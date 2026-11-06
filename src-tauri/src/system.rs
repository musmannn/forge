//! Services, startup apps, sessions, sockets and static hardware facts.

use crate::actions::NEEDS_ROOT;
use crate::apps::{exec_program, parse_desktop};
use crate::util::*;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

// ---------- services ----------

#[derive(Serialize, Default)]
pub struct Service {
    pub unit: String,
    pub description: String,
    pub load: String,
    pub active: String,
    pub sub: String,
    pub enablement: String,
}

pub fn services(user: bool) -> Result<Vec<Service>, String> {
    let scope: &[&str] = if user { &["--user"] } else { &[] };
    let mut a: Vec<&str> = scope.to_vec();
    a.extend(["list-units", "--type=service", "--all", "--output=json", "--no-pager"]);
    let units: Value = serde_json::from_str(&run("systemctl", &a)?).map_err(|e| e.to_string())?;
    let mut b: Vec<&str> = scope.to_vec();
    b.extend(["list-unit-files", "--type=service", "--output=json", "--no-pager"]);
    let files: Value = run("systemctl", &b).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    let mut enable: HashMap<String, String> = HashMap::new();
    if let Some(arr) = files.as_array() {
        for f in arr {
            if let (Some(u), Some(s)) = (f["unit_file"].as_str(), f["state"].as_str()) {
                enable.insert(u.to_string(), s.to_string());
            }
        }
    }
    let mut out = vec![];
    let mut seen = HashSet::new();
    if let Some(arr) = units.as_array() {
        for u in arr {
            let unit = u["unit"].as_str().unwrap_or("").to_string();
            seen.insert(unit.clone());
            let base = unit.split_once('@').map(|(a, _)| format!("{a}@.service")).unwrap_or(unit.clone());
            out.push(Service {
                enablement: enable.get(&unit).or_else(|| enable.get(&base)).cloned().unwrap_or_default(),
                description: u["description"].as_str().unwrap_or("").to_string(),
                load: u["load"].as_str().unwrap_or("").to_string(),
                active: u["active"].as_str().unwrap_or("").to_string(),
                sub: u["sub"].as_str().unwrap_or("").to_string(),
                unit,
            });
        }
    }
    // installed but never loaded this boot
    for (u, s) in enable {
        if !seen.contains(&u) && !u.contains("@.") {
            out.push(Service { unit: u, enablement: s, active: "inactive".into(), sub: "dead".into(), load: "not-loaded".into(), ..Default::default() });
        }
    }
    out.sort_by(|a, b| a.unit.cmp(&b.unit));
    Ok(out)
}

pub fn service_action(user: bool, unit: &str, verb: &str, elevated: bool) -> Result<(), String> {
    if !matches!(verb, "start" | "stop" | "restart" | "reload" | "enable" | "disable" | "mask" | "unmask") {
        return Err(format!("unknown action {verb}"));
    }
    if unit.is_empty() || unit.contains(char::is_whitespace) {
        return Err("bad unit name".into());
    }
    if elevated && !user {
        return crate::actions::pkexec(&["systemctl", verb, unit]);
    }
    let mut a: Vec<&str> = if user { vec!["--user"] } else { vec![] };
    a.extend([verb, unit]);
    match run("systemctl", &a) {
        Ok(_) => Ok(()),
        Err(e) if e.contains("Interactive authentication") || e.contains("Access denied") || e.contains("authentication") => {
            Err(format!("{NEEDS_ROOT}{e}"))
        }
        Err(e) => Err(e),
    }
}

pub fn service_logs(user: bool, unit: &str, lines: u32) -> Result<String, String> {
    let n = lines.min(2000).to_string();
    let mut a: Vec<&str> = if user { vec!["--user"] } else { vec![] };
    a.extend(["-u", unit, "-n", &n, "--no-pager", "-o", "short-iso"]);
    run("journalctl", &a)
}

// ---------- startup apps ----------

#[derive(Serialize, Default)]
pub struct StartupApp {
    pub id: String,
    pub name: String,
    pub exec: String,
    pub program: String,
    pub icon: Option<String>,
    pub enabled: bool,
    pub source: String,
    pub path: String,
    pub user_created: bool,
    pub shown_here: bool,
    pub comment: String,
}

fn autostart_dirs() -> Vec<PathBuf> {
    let mut v = vec![];
    let sys = std::env::var("XDG_CONFIG_DIRS").unwrap_or_default();
    let sys = if sys.is_empty() { "/etc/xdg".to_string() } else { sys };
    for d in sys.split(':').rev() {
        v.push(PathBuf::from(d).join("autostart"));
    }
    v
}

fn user_autostart() -> PathBuf {
    config_home().join("autostart")
}

pub fn startup_apps() -> Vec<StartupApp> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    let ours: Vec<&str> = desktop.split(':').collect();
    let mut by_id: BTreeMap<String, StartupApp> = BTreeMap::new();
    let mut system_ids = HashSet::new();
    let mut dirs = autostart_dirs();
    dirs.push(user_autostart());
    for (i, dir) in dirs.iter().enumerate() {
        let is_user = i == dirs.len() - 1;
        let Ok(rd) = fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            let fname = e.file_name().to_string_lossy().into_owned();
            let Some(id) = fname.strip_suffix(".desktop") else { continue };
            let text = read(e.path()).unwrap_or_default();
            let Some(d) = parse_desktop(&e.path(), id) else { continue };
            let get = |k: &str| {
                text.lines()
                    .find_map(|l| l.strip_prefix(&format!("{k}=")).map(|v| v.trim().to_string()))
                    .unwrap_or_default()
            };
            let hidden = get("Hidden") == "true";
            let gnome_off = get("X-GNOME-Autostart-enabled") == "false";
            let only = get("OnlyShowIn");
            let not = get("NotShowIn");
            let shown_here = (only.is_empty() || only.split(';').any(|x| !x.is_empty() && ours.contains(&x)))
                && !not.split(';').any(|x| !x.is_empty() && ours.contains(&x));
            if !is_user {
                system_ids.insert(id.to_string());
            }
            let exec = d.exec.clone().unwrap_or_default();
            by_id.insert(
                id.to_string(),
                StartupApp {
                    id: id.to_string(),
                    name: d.name,
                    program: exec_program(&exec).unwrap_or_default(),
                    exec,
                    icon: d.icon,
                    enabled: !hidden && !gnome_off,
                    source: if is_user { "you".into() } else { dir.to_string_lossy().into_owned() },
                    path: e.path().to_string_lossy().into_owned(),
                    user_created: false,
                    shown_here,
                    comment: get("Comment"),
                },
            );
        }
    }
    for (id, a) in by_id.iter_mut() {
        a.user_created = !system_ids.contains(id);
    }
    by_id.into_values().collect()
}

pub fn set_startup(id: &str, enabled: bool) -> Result<(), String> {
    if id.contains('/') {
        return Err("bad id".into());
    }
    let user = user_autostart().join(format!("{id}.desktop"));
    let source = if user.is_file() {
        user.clone()
    } else {
        autostart_dirs()
            .into_iter()
            .rev()
            .map(|d| d.join(format!("{id}.desktop")))
            .find(|p| p.is_file())
            .ok_or("This startup entry no longer exists")?
    };
    let text = read(&source).ok_or("Cannot read the entry")?;
    let mut out = String::new();
    let mut in_main = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_main = t == "[Desktop Entry]";
            out.push_str(line);
            out.push('\n');
            if in_main {
                out.push_str(&format!("Hidden={}\nX-GNOME-Autostart-enabled={}\n", !enabled, enabled));
            }
            continue;
        }
        if in_main && (t.starts_with("Hidden=") || t.starts_with("X-GNOME-Autostart-enabled=")) {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    fs::create_dir_all(user_autostart()).map_err(|e| e.to_string())?;
    fs::write(&user, out).map_err(|e| e.to_string())
}

pub fn add_startup(name: &str, command: &str) -> Result<String, String> {
    let name = name.trim();
    let command = command.trim();
    if name.is_empty() || command.is_empty() {
        return Err("Give the entry a name and a command".into());
    }
    let slug: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let id = format!("forge-{}", slug.trim_matches('-'));
    fs::create_dir_all(user_autostart()).map_err(|e| e.to_string())?;
    let body = format!(
        "[Desktop Entry]\nType=Application\nName={name}\nExec={command}\nHidden=false\nX-GNOME-Autostart-enabled=true\nComment=Added with Forge\n"
    );
    fs::write(user_autostart().join(format!("{id}.desktop")), body).map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn remove_startup(id: &str) -> Result<(), String> {
    if id.contains('/') {
        return Err("bad id".into());
    }
    let has_system = autostart_dirs().iter().any(|d| d.join(format!("{id}.desktop")).is_file());
    if has_system {
        return Err("This entry comes with the system; disable it instead".into());
    }
    fs::remove_file(user_autostart().join(format!("{id}.desktop"))).map_err(|e| e.to_string())
}

// ---------- sessions ----------

pub fn sessions() -> Result<Vec<BTreeMap<String, String>>, String> {
    let list = run("loginctl", &["list-sessions", "--no-legend", "--no-pager"])?;
    let mut out = vec![];
    for l in list.lines() {
        let Some(id) = l.split_whitespace().next() else { continue };
        let props = run(
            "loginctl",
            &[
                "show-session", id, "-p", "Id", "-p", "Name", "-p", "User", "-p", "Seat", "-p", "TTY", "-p", "Type", "-p", "Class",
                "-p", "State", "-p", "Remote", "-p", "RemoteHost", "-p", "Timestamp", "-p", "Desktop", "-p", "Leader", "-p", "IdleHint",
                "-p", "Display", "-p", "Service", "-p", "LockedHint",
            ],
        )
        .unwrap_or_default();
        let mut m = BTreeMap::new();
        for p in props.lines() {
            if let Some((k, v)) = p.split_once('=') {
                m.insert(k.to_string(), v.to_string());
            }
        }
        if !m.is_empty() {
            out.push(m);
        }
    }
    Ok(out)
}

pub fn session_action(id: &str, verb: &str) -> Result<(), String> {
    if !matches!(verb, "lock-session" | "terminate-session" | "unlock-session") || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("bad session action".into());
    }
    run("loginctl", &[verb, id]).map(|_| ())
}

// ---------- sockets ----------

#[derive(Serialize, Default)]
pub struct Conn {
    pub proto: String,
    pub local: String,
    pub local_port: u16,
    pub remote: String,
    pub remote_port: u16,
    pub state: String,
    pub pid: Option<i32>,
    pub process: String,
    pub uid: u32,
    pub service: String,
    pub tx_queue: u64,
    pub rx_queue: u64,
}

fn hex_ip(s: &str) -> String {
    if s.len() == 8 {
        let v = u32::from_str_radix(s, 16).unwrap_or(0);
        std::net::Ipv4Addr::from(u32::from_be(v)).to_string()
    } else if s.len() == 32 {
        let mut bytes = [0u8; 16];
        for w in 0..4 {
            let word = u32::from_str_radix(&s[w * 8..w * 8 + 8], 16).unwrap_or(0).to_le_bytes();
            bytes[w * 4..w * 4 + 4].copy_from_slice(&word);
        }
        let ip = std::net::Ipv6Addr::from(bytes);
        match ip.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => ip.to_string(),
        }
    } else {
        s.to_string()
    }
}

fn port_names() -> &'static HashMap<(u16, String), String> {
    static V: std::sync::OnceLock<HashMap<(u16, String), String>> = std::sync::OnceLock::new();
    V.get_or_init(|| {
        let mut m = HashMap::new();
        for l in read("/etc/services").unwrap_or_default().lines() {
            let l = l.split('#').next().unwrap_or("");
            let mut it = l.split_whitespace();
            if let (Some(name), Some(pp)) = (it.next(), it.next()) {
                if let Some((p, proto)) = pp.split_once('/') {
                    if let Ok(p) = p.parse() {
                        m.entry((p, proto.to_string())).or_insert(name.to_string());
                    }
                }
            }
        }
        m
    })
}

pub fn connections() -> Vec<Conn> {
    let mut inode_pid: HashMap<u64, i32> = HashMap::new();
    let mut names: HashMap<i32, String> = HashMap::new();
    if let Ok(rd) = fs::read_dir("/proc") {
        for e in rd.flatten() {
            let Ok(pid) = e.file_name().to_string_lossy().parse::<i32>() else { continue };
            let Ok(fds) = fs::read_dir(format!("/proc/{pid}/fd")) else { continue };
            for fd in fds.flatten() {
                if let Ok(t) = fs::read_link(fd.path()) {
                    let t = t.to_string_lossy();
                    if let Some(n) = t.strip_prefix("socket:[").and_then(|x| x.strip_suffix(']')) {
                        if let Ok(n) = n.parse() {
                            inode_pid.entry(n).or_insert(pid);
                            names.entry(pid).or_insert_with(|| read_trim(format!("/proc/{pid}/comm")).unwrap_or_default());
                        }
                    }
                }
            }
        }
    }
    let mut out = vec![];
    for (file, proto) in [("tcp", "TCP"), ("tcp6", "TCP"), ("udp", "UDP"), ("udp6", "UDP")] {
        let Some(text) = read(format!("/proc/net/{file}")) else { continue };
        for l in text.lines().skip(1) {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 10 {
                continue;
            }
            let (la, lp) = f[1].split_once(':').unwrap_or(("", "0"));
            let (ra, rp) = f[2].split_once(':').unwrap_or(("", "0"));
            let st = u8::from_str_radix(f[3], 16).unwrap_or(0);
            let state = if proto == "TCP" {
                match st {
                    1 => "Established",
                    2 => "SYN sent",
                    3 => "SYN received",
                    4 => "FIN wait 1",
                    5 => "FIN wait 2",
                    6 => "Time wait",
                    7 => "Closed",
                    8 => "Close wait",
                    9 => "Last ACK",
                    10 => "Listening",
                    11 => "Closing",
                    _ => "Unknown",
                }
            } else if st == 1 {
                "Connected"
            } else {
                "Open"
            };
            let (tx, rx) = f[4].split_once(':').unwrap_or(("0", "0"));
            let inode: u64 = f[9].parse().unwrap_or(0);
            let pid = inode_pid.get(&inode).copied();
            let local_port = u16::from_str_radix(lp, 16).unwrap_or(0);
            let remote_port = u16::from_str_radix(rp, 16).unwrap_or(0);
            let lower = proto.to_lowercase();
            let service = port_names()
                .get(&(local_port, lower.clone()))
                .filter(|_| state == "Listening" || state == "Open")
                .or_else(|| port_names().get(&(remote_port, lower)))
                .cloned()
                .unwrap_or_default();
            out.push(Conn {
                proto: format!("{proto}{}", if file.ends_with('6') { "6" } else { "" }),
                local: hex_ip(la),
                local_port,
                remote: hex_ip(ra),
                remote_port,
                state: state.into(),
                pid,
                process: pid.and_then(|p| names.get(&p).cloned()).unwrap_or_default(),
                uid: f[7].parse().unwrap_or(0),
                service,
                tx_queue: u64::from_str_radix(tx, 16).unwrap_or(0),
                rx_queue: u64::from_str_radix(rx, 16).unwrap_or(0),
            });
        }
    }
    out
}

// ---------- static facts ----------

#[derive(Serialize, Default)]
pub struct CpuInfo {
    pub model: String,
    pub vendor: String,
    pub sockets: usize,
    pub cores: usize,
    pub threads: usize,
    pub base_mhz: Option<u32>,
    pub min_mhz: Option<u32>,
    pub max_mhz: Option<u32>,
    pub caches: Vec<(String, u64)>,
    pub virtualization: String,
    pub hypervisor: bool,
    pub governor: String,
    pub energy_pref: String,
    pub perf_cores: Vec<usize>,
    pub eff_cores: Vec<usize>,
    pub microcode: String,
}

#[derive(Serialize, Default)]
pub struct Adapter {
    pub name: String,
    pub addrs: Vec<String>,
    pub mtu: u64,
    pub kind: String,
    pub connection: String,
    pub driver: String,
}

#[derive(Serialize, Default)]
pub struct SysInfo {
    pub cpu: CpuInfo,
    pub os: Vec<(String, String)>,
    pub hardware: Vec<(String, String)>,
    pub swaps: Vec<(String, String, u64, u64, i32)>,
    pub adapters: Vec<Adapter>,
    pub gateway: String,
    pub dns: Vec<String>,
    pub gpus: Vec<(String, String)>,
    pub battery: Vec<(String, String)>,
    pub disks: Vec<(String, String)>,
}

pub fn cpu_info() -> CpuInfo {
    let ci = read("/proc/cpuinfo").unwrap_or_default();
    let mut c = CpuInfo::default();
    let mut sockets = HashSet::new();
    let mut cores = HashSet::new();
    let mut phys = String::new();
    let mut flags = String::new();
    for l in ci.lines() {
        let Some((k, v)) = l.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        match k {
            "model name" if c.model.is_empty() => c.model = v.to_string(),
            "vendor_id" if c.vendor.is_empty() => c.vendor = v.to_string(),
            "physical id" => {
                phys = v.to_string();
                sockets.insert(v.to_string());
            }
            "core id" => {
                cores.insert((phys.clone(), v.to_string()));
            }
            "flags" if flags.is_empty() => flags = v.to_string(),
            "microcode" if c.microcode.is_empty() => c.microcode = v.to_string(),
            "processor" => c.threads += 1,
            _ => {}
        }
    }
    if c.model.is_empty() {
        // ARM boards
        c.model = read_trim("/sys/firmware/devicetree/base/model").unwrap_or_else(|| "Unknown processor".into());
    }
    c.sockets = sockets.len().max(1);
    c.cores = if cores.is_empty() { c.threads } else { cores.len() };
    let f: HashSet<&str> = flags.split_whitespace().collect();
    c.virtualization = if f.contains("vmx") {
        "Intel VT-x".into()
    } else if f.contains("svm") {
        "AMD-V".into()
    } else {
        "Not reported".into()
    };
    c.hypervisor = f.contains("hypervisor");
    let cf = "/sys/devices/system/cpu/cpu0/cpufreq";
    let mhz = |n: &str| read_u64(format!("{cf}/{n}")).map(|k| (k / 1000) as u32);
    c.base_mhz = mhz("base_frequency").or_else(|| mhz("bios_limit"));
    c.min_mhz = mhz("cpuinfo_min_freq");
    c.max_mhz = mhz("cpuinfo_max_freq");
    c.governor = read_trim(format!("{cf}/scaling_governor")).unwrap_or_default();
    c.energy_pref = read_trim(format!("{cf}/energy_performance_preference")).unwrap_or_default();
    c.perf_cores = read("/sys/devices/cpu_core/cpus").map(|s| parse_cpu_list(&s)).unwrap_or_default();
    c.eff_cores = read("/sys/devices/cpu_atom/cpus").map(|s| parse_cpu_list(&s)).unwrap_or_default();
    // total cache per level, counting each shared instance once
    let mut seen = HashSet::new();
    let mut totals: BTreeMap<String, u64> = BTreeMap::new();
    for cpu in 0..c.threads.max(1) {
        let Ok(rd) = fs::read_dir(format!("/sys/devices/system/cpu/cpu{cpu}/cache")) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if !e.file_name().to_string_lossy().starts_with("index") {
                continue;
            }
            let level = read_trim(p.join("level")).unwrap_or_default();
            let ty = read_trim(p.join("type")).unwrap_or_default();
            let shared = read_trim(p.join("shared_cpu_list")).unwrap_or_default();
            if !seen.insert((level.clone(), ty.clone(), shared)) {
                continue;
            }
            let size = read_trim(p.join("size")).unwrap_or_default();
            let bytes = size.trim_end_matches('K').parse::<u64>().unwrap_or(0) * 1024;
            let key = if level == "1" { format!("L1 {}", if ty == "Instruction" { "instruction" } else { "data" }) } else { format!("L{level}") };
            *totals.entry(key).or_default() += bytes;
        }
    }
    c.caches = totals.into_iter().collect();
    c
}

pub fn sys_info(gpus: Vec<(String, String)>) -> SysInfo {
    let mut s = SysInfo { cpu: cpu_info(), gpus, ..Default::default() };
    let osr = read("/etc/os-release").unwrap_or_default();
    let os_field = |k: &str| {
        osr.lines()
            .find_map(|l| l.strip_prefix(&format!("{k}=")))
            .map(|v| v.trim_matches('"').to_string())
            .unwrap_or_default()
    };
    let mut uts: libc::utsname = unsafe { std::mem::zeroed() };
    unsafe { libc::uname(&mut uts) };
    let cstr = |a: &[libc::c_char]| unsafe { std::ffi::CStr::from_ptr(a.as_ptr()) }.to_string_lossy().into_owned();
    let env = |k: &str| std::env::var(k).unwrap_or_default();
    s.os = vec![
        ("Distribution".into(), os_field("PRETTY_NAME")),
        ("Kernel".into(), format!("{} {}", cstr(&uts.sysname), cstr(&uts.release))),
        ("Architecture".into(), cstr(&uts.machine)),
        ("Host name".into(), cstr(&uts.nodename)),
        ("Desktop".into(), env("XDG_CURRENT_DESKTOP").replace(':', ", ")),
        ("Session".into(), env("XDG_SESSION_TYPE")),
        ("Shell".into(), env("SHELL")),
        ("Init".into(), run("systemctl", &["--version"]).ok().and_then(|v| v.lines().next().map(String::from)).unwrap_or_default()),
        ("Booted".into(), boot_time().to_string()),
    ];
    s.os.retain(|(_, v)| !v.is_empty());
    let dmi = |n: &str| read_trim(format!("/sys/class/dmi/id/{n}")).filter(|v| !v.is_empty() && v != "To be filled by O.E.M." && v != "Default string");
    for (label, keys) in [
        ("Maker", vec!["sys_vendor"]),
        ("Model", vec!["product_name", "product_version"]),
        ("Board", vec!["board_vendor", "board_name"]),
        ("Firmware", vec!["bios_vendor", "bios_version", "bios_date"]),
    ] {
        let v: Vec<String> = keys.iter().filter_map(|k| dmi(k)).collect();
        if !v.is_empty() {
            s.hardware.push((label.into(), v.join(" ")));
        }
    }
    if let Some(sw) = read("/proc/swaps") {
        for l in sw.lines().skip(1) {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() >= 5 {
                s.swaps.push((
                    f[0].to_string(),
                    f[1].to_string(),
                    f[2].parse::<u64>().unwrap_or(0) * 1024,
                    f[3].parse::<u64>().unwrap_or(0) * 1024,
                    f[4].parse().unwrap_or(0),
                ));
            }
        }
    }
    let nm: HashMap<String, (String, String)> = run("nmcli", &["-t", "-f", "DEVICE,TYPE,CONNECTION", "device"])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(':').collect();
            (f.len() >= 3).then(|| (f[0].to_string(), (f[1].to_string(), f[2].to_string())))
        })
        .collect();
    if let Ok(j) = run("ip", &["-j", "addr"]) {
        if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&j) {
            for a in arr {
                let name = a["ifname"].as_str().unwrap_or("").to_string();
                let addrs = a["addr_info"]
                    .as_array()
                    .map(|v| {
                        v.iter()
                            .filter_map(|x| Some(format!("{}/{}", x["local"].as_str()?, x["prefixlen"].as_u64()?)))
                            .collect()
                    })
                    .unwrap_or_default();
                let (kind, connection) = nm.get(&name).cloned().unwrap_or_else(|| (a["link_type"].as_str().unwrap_or("").to_string(), String::new()));
                let driver = fs::read_link(format!("/sys/class/net/{name}/device/driver"))
                    .ok()
                    .and_then(|p| p.file_name().map(|f| f.to_string_lossy().into_owned()))
                    .unwrap_or_default();
                s.adapters.push(Adapter { mtu: a["mtu"].as_u64().unwrap_or(0), name, addrs, kind, connection, driver });
            }
        }
    }
    if let Some(r) = read("/proc/net/route") {
        for l in r.lines().skip(1) {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() > 2 && f[1] == "00000000" {
                s.gateway = format!("{} via {}", hex_ip(f[2]), f[0]);
                break;
            }
        }
    }
    s.dns = read("/etc/resolv.conf")
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.strip_prefix("nameserver ").map(|v| v.trim().to_string()))
        .collect();
    if let Ok(rd) = fs::read_dir("/sys/class/power_supply") {
        for e in rd.flatten() {
            let p = e.path();
            if read_trim(p.join("type")).as_deref() == Some("Battery") && read_trim(p.join("scope")).as_deref() != Some("Device") {
                for (label, k) in [("Maker", "manufacturer"), ("Model", "model_name"), ("Chemistry", "technology")] {
                    if let Some(v) = read_trim(p.join(k)).filter(|v| !v.is_empty()) {
                        s.battery.push((label.into(), v));
                    }
                }
                break;
            }
        }
    }
    if let Ok(rd) = fs::read_dir("/sys/block") {
        let mut v: Vec<(String, String)> = rd
            .flatten()
            .filter_map(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                let p = e.path();
                fs::metadata(p.join("device")).ok()?;
                let transport = if fs::canonicalize(&p).map(|c| c.to_string_lossy().contains("/usb")).unwrap_or(false) {
                    "USB"
                } else if n.starts_with("nvme") {
                    "NVMe"
                } else if n.starts_with("mmcblk") {
                    "SD or eMMC"
                } else {
                    "SATA or SCSI"
                };
                Some((n, transport.to_string()))
            })
            .collect();
        v.sort();
        s.disks = v;
    }
    s
}

pub fn notify(title: &str, body: &str) -> Result<(), String> {
    run("notify-send", &["-a", "Forge", "-i", "utilities-system-monitor", title, body]).map(|_| ())
}
