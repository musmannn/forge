//! One sample of the whole machine per tick, built from /proc and /sys.

use crate::apps::{classify_cgroup, AppIndex};
use crate::gpu::GpuSampler;
use crate::history::AppHistory;
use crate::util::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::time::Instant;

#[derive(Serialize, Clone, Default)]
pub struct CpuSnap {
    pub total: f32,
    pub user: f32,
    pub system: f32,
    pub iowait: f32,
    pub steal: f32,
    pub irq: f32,
    pub cores: Vec<f32>,
    pub freqs_mhz: Vec<u32>,
    pub avg_freq_mhz: u32,
    pub load: [f64; 3],
    pub procs: usize,
    pub threads: u64,
    pub running: u64,
    pub blocked: u64,
    pub fds: u64,
    pub uptime_s: u64,
    pub ctxt_per_s: u64,
    pub intr_per_s: u64,
    pub temp_c: Option<f32>,
    pub core_temps: Vec<f32>,
}

#[derive(Serialize, Clone, Default)]
pub struct MemSnap {
    pub total: u64,
    pub in_use: u64,
    pub available: u64,
    pub free: u64,
    pub cached: u64,
    pub buffers: u64,
    pub modified: u64,
    pub standby: u64,
    pub shared: u64,
    pub slab: u64,
    pub page_tables: u64,
    pub kernel_stack: u64,
    pub committed: u64,
    pub commit_limit: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub swap_cached: u64,
    pub zswap: u64,
    pub hugepages_total: u64,
}

#[derive(Serialize, Clone, Default)]
pub struct DiskSnap {
    pub name: String,
    pub model: String,
    pub size: u64,
    pub rotational: bool,
    pub removable: bool,
    pub read_bps: f64,
    pub write_bps: f64,
    pub read_total: u64,
    pub write_total: u64,
    pub active_pct: f32,
    pub avg_ms: f32,
    pub queue: u64,
}

#[derive(Serialize, Clone, Default)]
pub struct MountSnap {
    pub dev: String,
    pub disk: String,
    pub mount: String,
    pub fs: String,
    pub total: u64,
    pub used: u64,
    pub avail: u64,
}

#[derive(Serialize, Clone, Default)]
pub struct NetSnap {
    pub name: String,
    pub rx_bps: f64,
    pub tx_bps: f64,
    pub rx_total: u64,
    pub tx_total: u64,
    pub rx_packets: u64,
    pub tx_packets: u64,
    pub errors: u64,
    pub drops: u64,
    pub up: bool,
    pub wireless: bool,
    pub virtual_if: bool,
    pub speed_mbps: Option<u64>,
    pub mac: String,
}

#[derive(Serialize, Clone, Default)]
pub struct TempSnap {
    pub chip: String,
    pub label: String,
    pub c: f32,
    pub high: Option<f32>,
    pub crit: Option<f32>,
}

#[derive(Serialize, Clone, Default)]
pub struct FanSnap {
    pub chip: String,
    pub label: String,
    pub rpm: u64,
}

#[derive(Serialize, Clone, Default)]
pub struct BatterySnap {
    pub name: String,
    pub pct: f32,
    pub status: String,
    pub power_w: Option<f32>,
    pub secs_left: Option<u64>,
    pub health_pct: Option<f32>,
    pub cycles: Option<u64>,
    pub ac_online: bool,
}

#[derive(Serialize, Clone, Default)]
pub struct Psi {
    pub cpu_some: f32,
    pub mem_some: f32,
    pub mem_full: f32,
    pub io_some: f32,
    pub io_full: f32,
}

#[derive(Serialize, Clone, Default)]
pub struct ProcSnap {
    pub pid: i32,
    pub ppid: i32,
    pub name: String,
    pub cmd: String,
    pub exe: String,
    pub user: String,
    pub uid: u32,
    pub state: char,
    pub cpu: f32,
    pub mem: u64,
    pub mem_private: u64,
    pub swap: u64,
    pub threads: u32,
    pub nice: i32,
    pub priority: i32,
    pub policy: u32,
    pub read_bps: f64,
    pub write_bps: f64,
    pub read_total: u64,
    pub write_total: u64,
    pub start_s: u64,
    pub cpu_time_s: f64,
    pub last_cpu: i32,
    pub gpu: Option<f32>,
    pub gpu_mem: Option<u64>,
    pub kind: &'static str,
    pub app: Option<String>,
    pub app_id: Option<String>,
    pub icon: Option<String>,
    pub container: Option<String>,
    pub unit: Option<String>,
    pub tty: i32,
}

#[derive(Serialize, Clone, Default)]
pub struct Snapshot {
    pub t: u64,
    pub interval_ms: u64,
    pub ncpu: usize,
    pub cpu: CpuSnap,
    pub mem: MemSnap,
    pub disks: Vec<DiskSnap>,
    pub mounts: Vec<MountSnap>,
    pub net: Vec<NetSnap>,
    pub gpus: Vec<crate::gpu::GpuSnap>,
    pub temps: Vec<TempSnap>,
    pub fans: Vec<FanSnap>,
    pub battery: Option<BatterySnap>,
    pub psi: Option<Psi>,
    pub procs: Vec<ProcSnap>,
}

#[derive(Clone, Copy, Default)]
struct CpuTimes {
    user: u64,
    nice: u64,
    system: u64,
    idle: u64,
    iowait: u64,
    irq: u64,
    softirq: u64,
    steal: u64,
}

impl CpuTimes {
    fn total(&self) -> u64 {
        self.user + self.nice + self.system + self.idle + self.iowait + self.irq + self.softirq + self.steal
    }
}

#[derive(Clone)]
struct ProcStatic {
    start: u64,
    name: String,
    cmd: String,
    exe: String,
    uid: u32,
    user: String,
    kind: &'static str,
    app: Option<String>,
    app_id: Option<String>,
    icon: Option<String>,
    container: Option<String>,
    unit: Option<String>,
}

#[derive(Clone, Copy)]
struct ProcPrev {
    start: u64,
    ticks: u64,
    rb: u64,
    wb: u64,
}

#[derive(Clone, Copy, Default)]
struct DiskPrev {
    reads: u64,
    writes: u64,
    rsec: u64,
    wsec: u64,
    ms_r: u64,
    ms_w: u64,
    ms_io: u64,
}

pub struct Sampler {
    ncpu: usize,
    prev_cpu: Vec<CpuTimes>,
    prev_ctxt: u64,
    prev_intr: u64,
    prev_procs: HashMap<i32, ProcPrev>,
    statics: HashMap<i32, ProcStatic>,
    prev_disk: HashMap<String, DiskPrev>,
    prev_net: HashMap<String, (u64, u64)>,
    prev_time: Option<Instant>,
    tick: u64,
    users: Users,
    apps: AppIndex,
    pub gpu: GpuSampler,
    pub history: AppHistory,
    mounts: Vec<MountSnap>,
    disk_meta: HashMap<String, (String, u64, bool, bool)>,
    my_uid: u32,
}

impl Sampler {
    pub fn new() -> Self {
        let ncpu = fs::read_to_string("/proc/stat")
            .map(|s| s.lines().filter(|l| l.starts_with("cpu") && !l.starts_with("cpu ")).count())
            .unwrap_or(1)
            .max(1);
        Sampler {
            ncpu,
            prev_cpu: vec![],
            prev_ctxt: 0,
            prev_intr: 0,
            prev_procs: HashMap::new(),
            statics: HashMap::new(),
            prev_disk: HashMap::new(),
            prev_net: HashMap::new(),
            prev_time: None,
            tick: 0,
            users: Users::new(),
            apps: AppIndex::load(),
            gpu: GpuSampler::new(),
            history: AppHistory::load(),
            mounts: vec![],
            disk_meta: HashMap::new(),
            my_uid: uid(),
        }
    }

    pub fn icon(&mut self, name: &str) -> Option<String> {
        self.apps.icon_data(name)
    }

    pub fn reload_apps(&mut self) {
        self.apps = AppIndex::load();
        self.statics.clear();
    }

    pub fn sample(&mut self, interval_ms: u64) -> Snapshot {
        let now = Instant::now();
        let dt = self
            .prev_time
            .map(|p| now.duration_since(p).as_secs_f64())
            .unwrap_or(interval_ms as f64 / 1000.0)
            .max(0.05);
        self.prev_time = Some(now);
        self.tick += 1;

        let mut snap = Snapshot { t: now_ms(), interval_ms, ncpu: self.ncpu, ..Default::default() };
        snap.cpu = self.cpu(dt);
        snap.mem = mem();
        snap.disks = self.disks(dt);
        if self.tick == 1 || self.tick % 5 == 0 {
            self.mounts = mounts();
        }
        snap.mounts = self.mounts.clone();
        snap.net = self.net(dt);
        let (temps, fans) = hwmon();
        snap.cpu.temp_c = cpu_package_temp(&temps);
        snap.cpu.core_temps = temps
            .iter()
            .filter(|t| (t.chip == "coretemp" && t.label.starts_with("Core ")) || (t.chip == "k10temp" && t.label.starts_with("Tccd")))
            .map(|t| t.c)
            .collect();
        snap.temps = temps;
        snap.fans = fans;
        snap.battery = battery();
        snap.psi = psi();

        let total_jiffies_per_s = clk_tck() * self.ncpu as f64;
        snap.procs = self.procs(dt, total_jiffies_per_s);
        snap.cpu.procs = snap.procs.len();
        snap.cpu.threads = snap.procs.iter().map(|p| p.threads as u64).sum();

        let gpu_usage = self.gpu.sample(dt, self.tick, snap.procs.iter().map(|p| p.pid));
        for p in snap.procs.iter_mut() {
            if let Some((u, m)) = gpu_usage.per_pid.get(&p.pid) {
                p.gpu = Some(*u);
                p.gpu_mem = *m;
            }
        }
        snap.gpus = gpu_usage.gpus;

        self.history.add(&snap.procs, self.tick, dt);
        snap
    }

    fn cpu(&mut self, dt: f64) -> CpuSnap {
        let mut out = CpuSnap::default();
        let Some(stat) = read("/proc/stat") else { return out };
        let mut cur: Vec<CpuTimes> = Vec::new();
        let mut ctxt: u64 = 0;
        let mut intr: u64 = 0;
        for l in stat.lines() {
            if l.starts_with("cpu") {
                let f: Vec<u64> = l.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
                if f.len() >= 8 {
                    cur.push(CpuTimes {
                        user: f[0],
                        nice: f[1],
                        system: f[2],
                        idle: f[3],
                        iowait: f[4],
                        irq: f[5],
                        softirq: f[6],
                        steal: f[7],
                    });
                }
            } else if let Some(v) = l.strip_prefix("ctxt ") {
                ctxt = v.trim().parse().unwrap_or(0);
            } else if let Some(v) = l.strip_prefix("intr ") {
                intr = v.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(0);
            } else if let Some(v) = l.strip_prefix("procs_running ") {
                out.running = v.trim().parse().unwrap_or(0);
            } else if let Some(v) = l.strip_prefix("procs_blocked ") {
                out.blocked = v.trim().parse().unwrap_or(0);
            }
        }
        let pct = |a: &CpuTimes, b: &CpuTimes| -> (f32, f32, f32, f32, f32, f32) {
            let td = b.total().saturating_sub(a.total()) as f32;
            if td <= 0.0 {
                return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
            }
            let idle = (b.idle + b.iowait).saturating_sub(a.idle + a.iowait) as f32;
            let user = (b.user + b.nice).saturating_sub(a.user + a.nice) as f32;
            let sys = b.system.saturating_sub(a.system) as f32;
            let io = b.iowait.saturating_sub(a.iowait) as f32;
            let st = b.steal.saturating_sub(a.steal) as f32;
            let irq = (b.irq + b.softirq).saturating_sub(a.irq + a.softirq) as f32;
            (
                ((td - idle) / td * 100.0).clamp(0.0, 100.0),
                user / td * 100.0,
                sys / td * 100.0,
                io / td * 100.0,
                st / td * 100.0,
                irq / td * 100.0,
            )
        };
        if self.prev_cpu.len() == cur.len() && !cur.is_empty() {
            let (t, u, s, io, st, irq) = pct(&self.prev_cpu[0], &cur[0]);
            out.total = t;
            out.user = u;
            out.system = s;
            out.iowait = io;
            out.steal = st;
            out.irq = irq;
            out.cores = (1..cur.len()).map(|i| pct(&self.prev_cpu[i], &cur[i]).0).collect();
            out.ctxt_per_s = (ctxt.saturating_sub(self.prev_ctxt) as f64 / dt) as u64;
            out.intr_per_s = (intr.saturating_sub(self.prev_intr) as f64 / dt) as u64;
        } else {
            out.cores = vec![0.0; cur.len().saturating_sub(1)];
        }
        self.prev_cpu = cur;
        self.prev_ctxt = ctxt;
        self.prev_intr = intr;

        out.freqs_mhz = (0..self.ncpu)
            .map(|i| {
                read_u64(format!("/sys/devices/system/cpu/cpu{i}/cpufreq/scaling_cur_freq"))
                    .map(|k| (k / 1000) as u32)
                    .unwrap_or(0)
            })
            .collect();
        if out.freqs_mhz.iter().all(|f| *f == 0) {
            // fall back to /proc/cpuinfo
            if let Some(ci) = read("/proc/cpuinfo") {
                out.freqs_mhz = ci
                    .lines()
                    .filter(|l| l.starts_with("cpu MHz"))
                    .filter_map(|l| l.split(':').nth(1)?.trim().parse::<f32>().ok())
                    .map(|f| f as u32)
                    .collect();
            }
        }
        let nz: Vec<u32> = out.freqs_mhz.iter().copied().filter(|f| *f > 0).collect();
        out.avg_freq_mhz = if nz.is_empty() { 0 } else { (nz.iter().map(|x| *x as u64).sum::<u64>() / nz.len() as u64) as u32 };

        if let Some(la) = read("/proc/loadavg") {
            let f: Vec<f64> = la.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
            if f.len() == 3 {
                out.load = [f[0], f[1], f[2]];
            }
        }
        out.fds = read("/proc/sys/fs/file-nr")
            .and_then(|s| s.split_whitespace().next()?.parse().ok())
            .unwrap_or(0);
        out.uptime_s = read("/proc/uptime")
            .and_then(|s| s.split_whitespace().next()?.parse::<f64>().ok())
            .map(|f| f as u64)
            .unwrap_or(0);
        out
    }

    fn disks(&mut self, dt: f64) -> Vec<DiskSnap> {
        let mut out = vec![];
        let Some(ds) = read("/proc/diskstats") else { return out };
        let ms = dt * 1000.0;
        let mut seen = HashSet::new();
        for l in ds.lines() {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 14 {
                continue;
            }
            let name = f[2].to_string();
            if !self.disk_meta.contains_key(&name) {
                let base = format!("/sys/block/{name}");
                let is_phys = fs::metadata(format!("{base}/device")).is_ok()
                    && !name.starts_with("loop")
                    && !name.starts_with("ram")
                    && !name.starts_with("zram");
                if !is_phys {
                    continue;
                }
                let model = read_trim(format!("{base}/device/model"))
                    .or_else(|| read_trim(format!("{base}/device/name")))
                    .unwrap_or_default();
                let size = read_u64(format!("{base}/size")).unwrap_or(0) * 512;
                let rot = read_u64(format!("{base}/queue/rotational")).unwrap_or(0) == 1;
                let rem = read_u64(format!("{base}/removable")).unwrap_or(0) == 1;
                if size == 0 {
                    continue;
                }
                self.disk_meta.insert(name.clone(), (model, size, rot, rem));
            }
            let (model, size, rot, rem) = self.disk_meta[&name].clone();
            let n = |i: usize| f[i].parse::<u64>().unwrap_or(0);
            let cur = DiskPrev { reads: n(3), rsec: n(5), ms_r: n(6), writes: n(7), wsec: n(9), ms_w: n(10), ms_io: n(12) };
            let queue = n(11);
            let prev = self.prev_disk.get(&name).copied();
            let mut d = DiskSnap {
                name: name.clone(),
                model,
                size,
                rotational: rot,
                removable: rem,
                read_total: cur.rsec * 512,
                write_total: cur.wsec * 512,
                queue,
                ..Default::default()
            };
            if let Some(p) = prev {
                d.read_bps = cur.rsec.saturating_sub(p.rsec) as f64 * 512.0 / dt;
                d.write_bps = cur.wsec.saturating_sub(p.wsec) as f64 * 512.0 / dt;
                d.active_pct = ((cur.ms_io.saturating_sub(p.ms_io)) as f64 / ms * 100.0).min(100.0) as f32;
                let ios = (cur.reads + cur.writes).saturating_sub(p.reads + p.writes);
                if ios > 0 {
                    d.avg_ms = ((cur.ms_r + cur.ms_w).saturating_sub(p.ms_r + p.ms_w)) as f32 / ios as f32;
                }
            }
            self.prev_disk.insert(name.clone(), cur);
            seen.insert(name);
            out.push(d);
        }
        self.prev_disk.retain(|k, _| seen.contains(k));
        out
    }

    fn net(&mut self, dt: f64) -> Vec<NetSnap> {
        let mut out = vec![];
        let Some(nd) = read("/proc/net/dev") else { return out };
        for l in nd.lines().skip(2) {
            let Some((name, rest)) = l.split_once(':') else { continue };
            let name = name.trim().to_string();
            let f: Vec<u64> = rest.split_whitespace().filter_map(|x| x.parse().ok()).collect();
            if f.len() < 16 {
                continue;
            }
            let base = format!("/sys/class/net/{name}");
            let (rx, tx) = (f[0], f[8]);
            let mut n = NetSnap {
                name: name.clone(),
                rx_total: rx,
                tx_total: tx,
                rx_packets: f[1],
                tx_packets: f[9],
                errors: f[2] + f[10],
                drops: f[3] + f[11],
                up: read_trim(format!("{base}/operstate")).map(|s| s == "up" || s == "unknown").unwrap_or(false),
                wireless: fs::metadata(format!("{base}/wireless")).is_ok() || fs::metadata(format!("{base}/phy80211")).is_ok(),
                virtual_if: fs::metadata(format!("{base}/device")).is_err(),
                speed_mbps: read_i64(format!("{base}/speed")).filter(|s| *s > 0).map(|s| s as u64),
                mac: read_trim(format!("{base}/address")).unwrap_or_default(),
                ..Default::default()
            };
            if let Some((prx, ptx)) = self.prev_net.get(&name) {
                n.rx_bps = rx.saturating_sub(*prx) as f64 / dt;
                n.tx_bps = tx.saturating_sub(*ptx) as f64 / dt;
            }
            self.prev_net.insert(name, (rx, tx));
            out.push(n);
        }
        out
    }

    fn procs(&mut self, dt: f64, jiffies_per_s: f64) -> Vec<ProcSnap> {
        let mut out = Vec::with_capacity(512);
        let Ok(rd) = fs::read_dir("/proc") else { return out };
        let mut alive = HashSet::new();
        let boot = boot_time();
        let tck = clk_tck();
        let page = page_size();
        for ent in rd.flatten() {
            let Ok(pid) = ent.file_name().to_string_lossy().parse::<i32>() else { continue };
            let base = format!("/proc/{pid}");
            let Some(stat) = read(format!("{base}/stat")) else { continue };
            let Some(close) = stat.rfind(')') else { continue };
            let open = stat.find('(').unwrap_or(0);
            let comm = stat[open + 1..close].to_string();
            let f: Vec<&str> = stat[close + 2..].split_whitespace().collect();
            if f.len() < 39 {
                continue;
            }
            let num = |i: usize| f[i].parse::<i64>().unwrap_or(0);
            let state = f[0].chars().next().unwrap_or('?');
            let ppid = num(1) as i32;
            let tty = num(4) as i32;
            let ticks = (num(11) + num(12)) as u64;
            let priority = num(15) as i32;
            let nice = num(16) as i32;
            let threads = num(17) as u32;
            let start = num(19) as u64;
            let rss_pages = num(21).max(0) as u64;
            let last_cpu = num(36) as i32;
            let policy = num(38) as u32;

            if self.statics.get(&pid).map(|s| s.start != start).unwrap_or(true) {
                let st = self.load_static(pid, &base, &comm, ppid, start);
                self.statics.insert(pid, st);
            }
            let st = self.statics[&pid].clone();

            let mut swap = 0;
            let mut anon = 0;
            let mut shmem = 0;
            if let Some(status) = read(format!("{base}/status")) {
                for l in status.lines() {
                    let kb = || l.split_whitespace().nth(1).and_then(|x| x.parse::<u64>().ok()).unwrap_or(0) * 1024;
                    if l.starts_with("VmSwap:") {
                        swap = kb();
                    } else if l.starts_with("RssAnon:") {
                        anon = kb();
                    } else if l.starts_with("RssShmem:") {
                        shmem = kb();
                    }
                }
            }
            let (mut rb, mut wb): (u64, u64) = (0, 0);
            if let Some(io) = read(format!("{base}/io")) {
                for l in io.lines() {
                    if let Some(v) = l.strip_prefix("read_bytes: ") {
                        rb = v.trim().parse().unwrap_or(0);
                    } else if let Some(v) = l.strip_prefix("write_bytes: ") {
                        wb = v.trim().parse().unwrap_or(0);
                    }
                }
            }

            let prev = self.prev_procs.get(&pid).filter(|p| p.start == start).copied();
            let (cpu, rbps, wbps) = match prev {
                Some(p) => (
                    (ticks.saturating_sub(p.ticks) as f64 / dt / jiffies_per_s * 100.0) as f32,
                    rb.saturating_sub(p.rb) as f64 / dt,
                    wb.saturating_sub(p.wb) as f64 / dt,
                ),
                None => (0.0, 0.0, 0.0),
            };
            self.prev_procs.insert(pid, ProcPrev { start, ticks, rb, wb });
            alive.insert(pid);

            out.push(ProcSnap {
                pid,
                ppid,
                name: st.name,
                cmd: st.cmd,
                exe: st.exe,
                user: st.user,
                uid: st.uid,
                state,
                cpu: cpu.min(100.0),
                mem: rss_pages * page,
                mem_private: anon + shmem,
                swap,
                threads,
                nice,
                priority,
                policy,
                read_bps: rbps,
                write_bps: wbps,
                read_total: rb,
                write_total: wb,
                start_s: boot + (start as f64 / tck) as u64,
                cpu_time_s: ticks as f64 / tck,
                last_cpu,
                gpu: None,
                gpu_mem: None,
                kind: st.kind,
                app: st.app,
                app_id: st.app_id,
                icon: st.icon,
                container: st.container,
                unit: st.unit,
                tty,
            });
        }
        self.prev_procs.retain(|k, _| alive.contains(k));
        self.statics.retain(|k, _| alive.contains(k));
        out
    }

    fn load_static(&mut self, pid: i32, base: &str, comm: &str, ppid: i32, start: u64) -> ProcStatic {
        let uid = fs::metadata(base)
            .map(|m| std::os::unix::fs::MetadataExt::uid(&m))
            .unwrap_or(0);
        let raw = fs::read(format!("{base}/cmdline")).unwrap_or_default();
        let mut cmd: String = String::from_utf8_lossy(&raw)
            .split('\0')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if cmd.len() > 600 {
            let mut cut = 600;
            while !cmd.is_char_boundary(cut) {
                cut -= 1;
            }
            cmd.truncate(cut);
        }
        let exe = fs::read_link(format!("{base}/exe"))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let kernel = pid == 2 || ppid == 2 || (raw.is_empty() && exe.is_empty() && pid != 1);
        // long names get truncated to 15 chars in comm; prefer exe's name
        let mut name = comm.to_string();
        if name.len() >= 15 {
            if let Some(b) = std::path::Path::new(&exe).file_name() {
                name = b.to_string_lossy().into_owned();
            }
        }
        let cg = read(format!("{base}/cgroup"))
            .and_then(|s| s.lines().find(|l| l.starts_with("0::")).map(|l| l[3..].to_string()))
            .unwrap_or_default();
        let (app_unit, container, system) = classify_cgroup(&cg);
        let unit = cg.rsplit('/').next().filter(|s| s.ends_with(".service") || s.ends_with(".scope")).map(|s| s.to_string());
        let mut app = None;
        let mut app_id = None;
        let mut icon = None;
        if let Some(u) = &app_unit {
            if let Some(e) = self.apps.match_unit(u) {
                app = Some(e.name.clone());
                app_id = Some(format!("{}:{}", e.id, cg));
                icon = e.icon.clone();
            }
        }
        let base_of = |p: &str| std::path::Path::new(p).file_name().map(|b| b.to_string_lossy().into_owned()).unwrap_or_default();
        let bin = base_of(&exe);
        if app.is_none() && !kernel && !bin.is_empty() {
            if let Some(e) = self.apps.match_exe(&bin) {
                icon = e.icon.clone();
                // the root of the app's own tree becomes the app; its children group under it in the UI
                let parent_bin = fs::read_link(format!("/proc/{ppid}/exe")).map(|p| base_of(&p.to_string_lossy())).unwrap_or_default();
                let in_user_tree = cg.contains("/user@") && uid == self.my_uid;
                if in_user_tree && parent_bin != bin {
                    app = Some(e.name.clone());
                    app_id = Some(format!("{}:{}", e.id, pid));
                }
            }
        }
        let kind = if kernel {
            "kernel"
        } else if app.is_some() {
            "app"
        } else if system || uid != self.my_uid {
            "system"
        } else {
            "background"
        };
        ProcStatic {
            start,
            name,
            cmd,
            exe,
            uid,
            user: self.users.name(uid),
            kind,
            app,
            app_id,
            icon,
            container,
            unit,
        }
    }
}

fn mem() -> MemSnap {
    let mut m: HashMap<&str, u64> = HashMap::new();
    let text = read("/proc/meminfo").unwrap_or_default();
    for l in text.lines() {
        if let Some((k, v)) = l.split_once(':') {
            let v = v.split_whitespace().next().and_then(|x| x.parse::<u64>().ok()).unwrap_or(0) * 1024;
            m.insert(k, v);
        }
    }
    let g = |k: &str| *m.get(k).unwrap_or(&0);
    let total = g("MemTotal");
    let free = g("MemFree");
    let cache = (g("Cached") + g("Buffers") + g("SReclaimable")).saturating_sub(g("Shmem"));
    let modified = g("Dirty") + g("Writeback");
    MemSnap {
        total,
        in_use: total.saturating_sub(free + cache),
        available: g("MemAvailable"),
        free,
        cached: g("Cached") + g("SReclaimable"),
        buffers: g("Buffers"),
        modified: modified.min(cache),
        standby: cache.saturating_sub(modified),
        shared: g("Shmem"),
        slab: g("Slab"),
        page_tables: g("PageTables"),
        kernel_stack: g("KernelStack"),
        committed: g("Committed_AS"),
        commit_limit: g("CommitLimit"),
        swap_total: g("SwapTotal"),
        swap_used: g("SwapTotal").saturating_sub(g("SwapFree")),
        swap_cached: g("SwapCached"),
        zswap: g("Zswap"),
        hugepages_total: g("HugePages_Total") / 1024 * g("Hugepagesize") / 1024,
    }
}

fn mounts() -> Vec<MountSnap> {
    let mut out = vec![];
    let mut seen = HashSet::new();
    let Some(text) = read("/proc/mounts") else { return out };
    for l in text.lines() {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() < 3 {
            continue;
        }
        let (dev, mnt, fs_) = (f[0], f[1].replace("\\040", " "), f[2]);
        if !dev.starts_with("/dev/") || fs_ == "squashfs" || dev.starts_with("/dev/loop") {
            continue;
        }
        if !seen.insert(dev.to_string()) {
            continue;
        }
        let Some((total, used, avail)) = statvfs(&mnt) else { continue };
        if total == 0 {
            continue;
        }
        out.push(MountSnap {
            dev: dev.to_string(),
            disk: parent_disk(dev),
            mount: mnt,
            fs: fs_.to_string(),
            total,
            used,
            avail,
        });
    }
    out
}

fn parent_disk(dev: &str) -> String {
    let real = fs::canonicalize(dev).map(|p| p.to_string_lossy().into_owned()).unwrap_or(dev.to_string());
    let name = real.rsplit('/').next().unwrap_or("").to_string();
    if name.starts_with("dm-") {
        if let Ok(rd) = fs::read_dir(format!("/sys/block/{name}/slaves")) {
            if let Some(s) = rd.flatten().next() {
                return parent_disk(&format!("/dev/{}", s.file_name().to_string_lossy()));
            }
        }
        return name;
    }
    let sys = format!("/sys/class/block/{name}");
    if fs::metadata(format!("{sys}/partition")).is_ok() {
        if let Ok(p) = fs::canonicalize(&sys) {
            if let Some(parent) = p.parent().and_then(|p| p.file_name()) {
                return parent.to_string_lossy().into_owned();
            }
        }
    }
    name
}

fn hwmon() -> (Vec<TempSnap>, Vec<FanSnap>) {
    let mut temps = vec![];
    let mut fans = vec![];
    let Ok(rd) = fs::read_dir("/sys/class/hwmon") else { return (temps, fans) };
    let mut dirs: Vec<_> = rd.flatten().map(|e| e.path()).collect();
    dirs.sort();
    for d in dirs {
        let chip = read_trim(d.join("name")).unwrap_or_default();
        let Ok(files) = fs::read_dir(&d) else { continue };
        let mut names: Vec<String> = files.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort_by_key(|n| {
            let digits: String = n.chars().filter(|c| c.is_ascii_digit()).collect();
            digits.parse::<u32>().unwrap_or(0)
        });
        for n in &names {
            if let Some(idx) = n.strip_prefix("temp").and_then(|x| x.strip_suffix("_input")) {
                let Some(v) = read_i64(d.join(n)) else { continue };
                let label = read_trim(d.join(format!("temp{idx}_label"))).unwrap_or_else(|| format!("temp{idx}"));
                let lim = |s: &str| read_i64(d.join(format!("temp{idx}_{s}"))).filter(|x| *x > 0).map(|x| x as f32 / 1000.0);
                temps.push(TempSnap { chip: chip.clone(), label, c: v as f32 / 1000.0, high: lim("max"), crit: lim("crit") });
            } else if let Some(idx) = n.strip_prefix("fan").and_then(|x| x.strip_suffix("_input")) {
                let Some(v) = read_u64(d.join(n)) else { continue };
                let label = read_trim(d.join(format!("fan{idx}_label"))).unwrap_or_else(|| format!("fan{idx}"));
                fans.push(FanSnap { chip: chip.clone(), label, rpm: v });
            }
        }
    }
    (temps, fans)
}

fn cpu_package_temp(t: &[TempSnap]) -> Option<f32> {
    let pick = |chip: &str, pre: &str| t.iter().find(|x| x.chip == chip && x.label.starts_with(pre)).map(|x| x.c);
    pick("coretemp", "Package")
        .or_else(|| pick("k10temp", "Tctl"))
        .or_else(|| pick("k10temp", "Tdie"))
        .or_else(|| pick("zenpower", "Tdie"))
        .or_else(|| pick("cpu_thermal", ""))
        .or_else(|| pick("acpitz", ""))
}

fn battery() -> Option<BatterySnap> {
    let rd = fs::read_dir("/sys/class/power_supply").ok()?;
    let mut ac = false;
    let mut bat: Option<BatterySnap> = None;
    for e in rd.flatten() {
        let p = e.path();
        let ty = read_trim(p.join("type")).unwrap_or_default();
        if ty == "Mains" {
            ac |= read_u64(p.join("online")).unwrap_or(0) == 1;
        } else if ty == "Battery" && bat.is_none() {
            // peripherals (mice, headsets) report scope=Device
            if read_trim(p.join("scope")).as_deref() == Some("Device") {
                continue;
            }
            let g = |n: &str| read_u64(p.join(n));
            let status = read_trim(p.join("status")).unwrap_or_default();
            let (now, full, design) = match (g("energy_now"), g("energy_full")) {
                (Some(n), Some(f)) => (n, f, g("energy_full_design")),
                _ => (g("charge_now").unwrap_or(0), g("charge_full").unwrap_or(0), g("charge_full_design")),
            };
            let power_uw = g("power_now").or_else(|| Some(g("current_now")? * g("voltage_now")? / 1_000_000));
            let pct = g("capacity").map(|c| c as f32).unwrap_or(if full > 0 { now as f32 / full as f32 * 100.0 } else { 0.0 });
            let secs_left = power_uw.filter(|w| *w > 0).and_then(|w| {
                let hours = match status.as_str() {
                    "Discharging" => now as f64 / w as f64,
                    "Charging" => full.saturating_sub(now) as f64 / w as f64,
                    _ => return None,
                };
                // charge_* is in µAh and current in µA, energy in µWh and power in µW: either ratio is hours
                Some((hours * 3600.0) as u64)
            });
            bat = Some(BatterySnap {
                name: e.file_name().to_string_lossy().into_owned(),
                pct,
                status,
                power_w: power_uw.map(|w| w as f32 / 1_000_000.0),
                secs_left,
                health_pct: design.filter(|d| *d > 0).map(|d| full as f32 / d as f32 * 100.0),
                cycles: g("cycle_count").filter(|c| *c > 0),
                ac_online: false,
            });
        }
    }
    bat.map(|mut b| {
        b.ac_online = ac;
        b
    })
}

fn psi() -> Option<Psi> {
    let parse = |file: &str| -> (f32, f32) {
        let s = read(format!("/proc/pressure/{file}")).unwrap_or_default();
        let get = |kind: &str| {
            s.lines()
                .find(|l| l.starts_with(kind))
                .and_then(|l| l.split_whitespace().find(|w| w.starts_with("avg10="))?[6..].parse().ok())
                .unwrap_or(0.0)
        };
        (get("some"), get("full"))
    };
    if fs::metadata("/proc/pressure/cpu").is_err() {
        return None;
    }
    let (cs, _) = parse("cpu");
    let (ms, mf) = parse("memory");
    let (is, if_) = parse("io");
    Some(Psi { cpu_some: cs, mem_some: ms, mem_full: mf, io_some: is, io_full: if_ })
}
