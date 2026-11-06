//! Things the user does to processes, plus the deep per-process read.

use crate::util::*;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

/// Prefix the UI looks for to offer "retry as administrator".
pub const NEEDS_ROOT: &str = "needs-root: ";

fn errno_msg(what: &str) -> String {
    let e = std::io::Error::last_os_error();
    match e.raw_os_error() {
        Some(libc::EPERM) | Some(libc::EACCES) => format!("{NEEDS_ROOT}{what}: permission denied"),
        Some(libc::ESRCH) => format!("{what}: the process has already exited"),
        _ => format!("{what}: {e}"),
    }
}

pub fn pkexec(args: &[&str]) -> Result<(), String> {
    if !which("pkexec") {
        return Err("pkexec is not installed, so Forge cannot ask for administrator rights".into());
    }
    let out = Command::new("pkexec").args(args).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else if out.status.code() == Some(126) {
        Err("Authentication was cancelled".into())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn tids(pid: i32) -> Vec<i32> {
    fs::read_dir(format!("/proc/{pid}/task"))
        .map(|rd| rd.flatten().filter_map(|e| e.file_name().to_string_lossy().parse().ok()).collect())
        .unwrap_or_else(|_| vec![pid])
}

pub fn signal(pid: i32, sig: i32, elevated: bool) -> Result<(), String> {
    if pid <= 1 {
        return Err("Forge will not signal PID 1 or the kernel".into());
    }
    if elevated {
        return pkexec(&["kill", &format!("-{sig}"), &pid.to_string()]);
    }
    if unsafe { libc::kill(pid, sig) } != 0 {
        return Err(errno_msg("signal"));
    }
    Ok(())
}

pub fn descendants(pid: i32) -> Vec<i32> {
    let mut children: std::collections::HashMap<i32, Vec<i32>> = Default::default();
    if let Ok(rd) = fs::read_dir("/proc") {
        for e in rd.flatten() {
            let Ok(p) = e.file_name().to_string_lossy().parse::<i32>() else { continue };
            if let Some(stat) = read(format!("/proc/{p}/stat")) {
                if let Some(close) = stat.rfind(')') {
                    if let Some(pp) = stat[close + 2..].split_whitespace().nth(1).and_then(|x| x.parse().ok()) {
                        children.entry(pp).or_default().push(p);
                    }
                }
            }
        }
    }
    let mut out = vec![];
    let mut stack = vec![pid];
    let mut seen = HashSet::new();
    while let Some(p) = stack.pop() {
        if !seen.insert(p) {
            continue;
        }
        out.push(p);
        if let Some(c) = children.get(&p) {
            stack.extend(c);
        }
    }
    out
}

pub fn signal_tree(pid: i32, sig: i32, elevated: bool) -> Result<usize, String> {
    let all = descendants(pid);
    if elevated {
        let mut args = vec!["kill".to_string(), format!("-{sig}")];
        args.extend(all.iter().map(|p| p.to_string()));
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        pkexec(&refs)?;
        return Ok(all.len());
    }
    let mut err = None;
    // children first so a parent cannot respawn them
    for p in all.iter().rev() {
        if let Err(e) = signal(*p, sig, false) {
            err.get_or_insert(e);
        }
    }
    match err {
        Some(e) if e.starts_with(NEEDS_ROOT) => Err(e),
        _ => Ok(all.len()),
    }
}

pub fn set_nice(pid: i32, nice: i32, elevated: bool) -> Result<(), String> {
    let nice = nice.clamp(-20, 19);
    if elevated {
        let script = format!("for t in /proc/{pid}/task/*; do renice -n {nice} -p \"${{t##*/}}\" >/dev/null; done");
        return pkexec(&["sh", "-c", &script]);
    }
    for t in tids(pid) {
        if unsafe { libc::setpriority(libc::PRIO_PROCESS, t as libc::id_t, nice) } != 0 {
            return Err(errno_msg("change priority"));
        }
    }
    Ok(())
}

/// Efficiency mode: SCHED_IDLE runs the process only when nothing else wants the CPU.
pub fn set_efficiency(pid: i32, on: bool, elevated: bool) -> Result<(), String> {
    if elevated {
        let policy = if on { "--idle" } else { "--other" };
        return pkexec(&["chrt", "-a", policy, "-p", "0", &pid.to_string()]);
    }
    let policy = if on { libc::SCHED_IDLE } else { libc::SCHED_OTHER };
    let param = libc::sched_param { sched_priority: 0 };
    for t in tids(pid) {
        if unsafe { libc::sched_setscheduler(t, policy, &param) } != 0 {
            return Err(errno_msg("change scheduling"));
        }
    }
    Ok(())
}

pub fn get_affinity(pid: i32) -> Result<Vec<usize>, String> {
    let s = read(format!("/proc/{pid}/status")).ok_or("the process has exited")?;
    let l = s.lines().find(|l| l.starts_with("Cpus_allowed_list:")).ok_or("no affinity reported")?;
    Ok(parse_cpu_list(l.split(':').nth(1).unwrap_or("")))
}

pub fn set_affinity(pid: i32, cpus: Vec<usize>, elevated: bool) -> Result<(), String> {
    if cpus.is_empty() {
        return Err("Pick at least one processor".into());
    }
    let list = cpus.iter().map(|c| c.to_string()).collect::<Vec<_>>().join(",");
    if elevated {
        return pkexec(&["taskset", "-a", "-cp", &list, &pid.to_string()]);
    }
    let mut set: libc::cpu_set_t = unsafe { std::mem::zeroed() };
    for c in &cpus {
        unsafe { libc::CPU_SET(*c, &mut set) };
    }
    for t in tids(pid) {
        if unsafe { libc::sched_setaffinity(t, std::mem::size_of::<libc::cpu_set_t>(), &set) } != 0 {
            return Err(errno_msg("set affinity"));
        }
    }
    Ok(())
}

fn spawn_detached(cmd: &mut Command) -> Result<(), String> {
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub fn run_task(command: &str, elevated: bool) -> Result<(), String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("Type a command to run".into());
    }
    let mut c = if elevated {
        let mut c = Command::new("pkexec");
        c.args(["sh", "-c", command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    c.current_dir(home());
    spawn_detached(&mut c)
}

pub fn open_path(path: &str) -> Result<(), String> {
    spawn_detached(Command::new("xdg-open").arg(path))
}

pub fn open_location(pid: i32) -> Result<(), String> {
    let exe = fs::read_link(format!("/proc/{pid}/exe")).map_err(|_| "Forge cannot read where this process runs from".to_string())?;
    let dir = exe.parent().ok_or("no folder")?;
    open_path(&dir.to_string_lossy())
}

pub fn core_dump(pid: i32, elevated: bool) -> Result<String, String> {
    if !which("gcore") {
        return Err("gcore is not installed (it ships with gdb)".into());
    }
    let name = read_trim(format!("/proc/{pid}/comm")).unwrap_or_else(|| "process".into());
    let dir = data_dir().join("dumps");
    let _ = fs::create_dir_all(&dir);
    let prefix = dir.join(format!("{name}-{}", now_ms() / 1000));
    let p = prefix.to_string_lossy().into_owned();
    let pid_s = pid.to_string();
    if elevated {
        pkexec(&["gcore", "-o", &p, &pid_s])?;
    } else {
        let out = Command::new("gcore").args(["-o", &p, &pid_s]).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).to_string();
            if err.contains("ptrace") || err.contains("Operation not permitted") || err.contains("attach") {
                return Err(format!("{NEEDS_ROOT}attaching to the process was refused"));
            }
            return Err(err.lines().last().unwrap_or("gcore failed").to_string());
        }
    }
    Ok(format!("{p}.{pid}"))
}

#[derive(Serialize, Default)]
pub struct ThreadInfo {
    pub tid: i32,
    pub name: String,
    pub state: char,
    pub cpu_time_s: f64,
    pub last_cpu: i32,
    pub nice: i32,
}

#[derive(Serialize, Default)]
pub struct FdInfo {
    pub fd: i32,
    pub target: String,
}

#[derive(Serialize, Default)]
pub struct Details {
    pub pid: i32,
    pub name: String,
    pub argv: Vec<String>,
    pub exe: String,
    pub cwd: String,
    pub root: String,
    pub state: String,
    pub ppid: i32,
    pub parent_name: String,
    pub uid: String,
    pub gid: String,
    pub start_s: u64,
    pub threads: Vec<ThreadInfo>,
    pub fds: Vec<FdInfo>,
    pub fd_count: usize,
    pub env: Vec<String>,
    pub env_readable: bool,
    pub limits: Vec<(String, String, String)>,
    pub cgroup: String,
    pub policy: String,
    pub nice: i32,
    pub oom_score: Option<i64>,
    pub oom_adj: Option<i64>,
    pub affinity: Vec<usize>,
    pub io: Vec<(String, u64)>,
    pub memory: Vec<(String, u64)>,
    pub ctx_voluntary: u64,
    pub ctx_involuntary: u64,
    pub wchan: String,
    pub maps: Vec<(String, u64)>,
    pub map_count: usize,
    pub namespaces: Vec<(String, String)>,
    pub seccomp: String,
    pub capabilities: String,
}

pub fn details(pid: i32) -> Result<Details, String> {
    let base = format!("/proc/{pid}");
    let status = read(format!("{base}/status")).ok_or("The process has exited")?;
    let mut d = Details { pid, ..Default::default() };
    let field = |k: &str| status.lines().find_map(|l| l.strip_prefix(k).map(|v| v.trim().to_string())).unwrap_or_default();
    d.name = field("Name:");
    d.state = field("State:");
    d.ppid = field("PPid:").parse().unwrap_or(0);
    d.parent_name = read_trim(format!("/proc/{}/comm", d.ppid)).unwrap_or_default();
    d.uid = field("Uid:");
    d.gid = field("Gid:");
    d.seccomp = match field("Seccomp:").as_str() {
        "0" => "off".into(),
        "1" => "strict".into(),
        "2" => "filter".into(),
        s => s.into(),
    };
    d.capabilities = field("CapEff:");
    d.ctx_voluntary = field("voluntary_ctxt_switches:").parse().unwrap_or(0);
    d.ctx_involuntary = field("nonvoluntary_ctxt_switches:").parse().unwrap_or(0);
    for k in ["VmPeak", "VmSize", "VmHWM", "VmRSS", "RssAnon", "RssFile", "RssShmem", "VmData", "VmStk", "VmExe", "VmLib", "VmPTE", "VmSwap"] {
        let v = field(&format!("{k}:"));
        if let Some(n) = v.split_whitespace().next().and_then(|x| x.parse::<u64>().ok()) {
            d.memory.push((k.to_string(), n * 1024));
        }
    }
    if let Some(sr) = read(format!("{base}/smaps_rollup")) {
        for l in sr.lines().skip(1) {
            if let Some((k, v)) = l.split_once(':') {
                if matches!(k, "Pss" | "Shared_Clean" | "Shared_Dirty" | "Private_Clean" | "Private_Dirty") {
                    if let Some(n) = v.split_whitespace().next().and_then(|x| x.parse::<u64>().ok()) {
                        d.memory.push((k.to_string(), n * 1024));
                    }
                }
            }
        }
    }
    d.argv = fs::read(format!("{base}/cmdline"))
        .map(|b| String::from_utf8_lossy(&b).split('\0').filter(|s| !s.is_empty()).map(String::from).collect())
        .unwrap_or_default();
    let link = |n: &str| fs::read_link(format!("{base}/{n}")).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    d.exe = link("exe");
    d.cwd = link("cwd");
    d.root = link("root");
    d.wchan = read_trim(format!("{base}/wchan")).filter(|w| w != "0").unwrap_or_default();
    if let Some(stat) = read(format!("{base}/stat")) {
        if let Some(close) = stat.rfind(')') {
            let f: Vec<&str> = stat[close + 2..].split_whitespace().collect();
            if f.len() > 38 {
                d.nice = f[16].parse().unwrap_or(0);
                d.start_s = boot_time() + (f[19].parse::<f64>().unwrap_or(0.0) / clk_tck()) as u64;
                d.policy = match f[38].parse::<i32>().unwrap_or(0) {
                    0 => "Normal (SCHED_OTHER)",
                    1 => "Realtime FIFO",
                    2 => "Realtime round robin",
                    3 => "Batch",
                    5 => "Idle (efficiency mode)",
                    6 => "Deadline",
                    _ => "Unknown",
                }
                .into();
            }
        }
    }
    for t in tids(pid).into_iter().take(500) {
        let Some(stat) = read(format!("{base}/task/{t}/stat")) else { continue };
        let Some(close) = stat.rfind(')') else { continue };
        let open = stat.find('(').unwrap_or(0);
        let f: Vec<&str> = stat[close + 2..].split_whitespace().collect();
        if f.len() < 37 {
            continue;
        }
        let n = |i: usize| f[i].parse::<f64>().unwrap_or(0.0);
        d.threads.push(ThreadInfo {
            tid: t,
            name: stat[open + 1..close].to_string(),
            state: f[0].chars().next().unwrap_or('?'),
            cpu_time_s: (n(11) + n(12)) / clk_tck(),
            last_cpu: n(36) as i32,
            nice: n(16) as i32,
        });
    }
    d.threads.sort_by(|a, b| b.cpu_time_s.partial_cmp(&a.cpu_time_s).unwrap_or(std::cmp::Ordering::Equal));
    if let Ok(rd) = fs::read_dir(format!("{base}/fd")) {
        let mut fds: Vec<FdInfo> = rd
            .flatten()
            .filter_map(|e| {
                let fd = e.file_name().to_string_lossy().parse().ok()?;
                let target = fs::read_link(e.path()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
                Some(FdInfo { fd, target })
            })
            .collect();
        fds.sort_by_key(|f| f.fd);
        d.fd_count = fds.len();
        fds.truncate(400);
        d.fds = fds;
    }
    if let Ok(env) = fs::read(format!("{base}/environ")) {
        d.env_readable = true;
        let mut v: Vec<String> = String::from_utf8_lossy(&env).split('\0').filter(|s| !s.is_empty()).map(String::from).collect();
        v.sort();
        d.env = v;
    }
    if let Some(l) = read(format!("{base}/limits")) {
        for line in l.lines().skip(1) {
            // columns are fixed width: name 26, soft 21, hard 21
            if line.len() < 47 {
                continue;
            }
            let name = line[..26].trim().to_string();
            let soft = line[26..47].trim().to_string();
            let hard = line.get(47..68).unwrap_or("").trim().to_string();
            d.limits.push((name, soft, hard));
        }
    }
    d.cgroup = read(format!("{base}/cgroup"))
        .and_then(|s| s.lines().find(|l| l.starts_with("0::")).map(|l| l[3..].to_string()))
        .unwrap_or_default();
    d.oom_score = read_i64(format!("{base}/oom_score"));
    d.oom_adj = read_i64(format!("{base}/oom_score_adj"));
    d.affinity = get_affinity(pid).unwrap_or_default();
    if let Some(io) = read(format!("{base}/io")) {
        for l in io.lines() {
            if let Some((k, v)) = l.split_once(':') {
                d.io.push((k.to_string(), v.trim().parse().unwrap_or(0)));
            }
        }
    }
    if let Some(maps) = read(format!("{base}/maps")) {
        let mut by_file: std::collections::HashMap<String, u64> = Default::default();
        for l in maps.lines() {
            d.map_count += 1;
            let mut it = l.split_whitespace();
            let range = it.next().unwrap_or("");
            let path = it.nth(4).unwrap_or("");
            if path.starts_with('/') {
                if let Some((a, b)) = range.split_once('-') {
                    let size = u64::from_str_radix(b, 16).unwrap_or(0).saturating_sub(u64::from_str_radix(a, 16).unwrap_or(0));
                    *by_file.entry(path.to_string()).or_default() += size;
                }
            }
        }
        let mut v: Vec<(String, u64)> = by_file.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1));
        v.truncate(200);
        d.maps = v;
    }
    let mine = |n: &str| fs::read_link(format!("/proc/self/ns/{n}")).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    for n in ["pid", "net", "mnt", "user", "uts", "ipc", "cgroup"] {
        let theirs = fs::read_link(format!("{base}/ns/{n}")).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        if !theirs.is_empty() {
            let note = if theirs == mine(n) { "shared with the host".to_string() } else { "isolated".to_string() };
            d.namespaces.push((n.to_string(), format!("{theirs}, {note}")));
        }
    }
    Ok(d)
}
