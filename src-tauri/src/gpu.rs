//! GPU load. Whole-device numbers come from the driver (amdgpu busy percent,
//! i915 RC6 residency, nvidia-smi); per-process numbers come from DRM fdinfo
//! engine counters, the same source nvtop uses.

use crate::util::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;

#[derive(Serialize, Clone, Default)]
pub struct GpuSnap {
    pub name: String,
    pub driver: String,
    pub slot: String,
    pub busy_pct: Option<f32>,
    pub freq_mhz: Option<u32>,
    pub max_freq_mhz: Option<u32>,
    pub vram_used: Option<u64>,
    pub vram_total: Option<u64>,
    pub temp_c: Option<f32>,
    pub power_w: Option<f32>,
    pub engines: Vec<(String, f32)>,
    pub source: &'static str,
}

pub struct GpuUsage {
    pub gpus: Vec<GpuSnap>,
    pub per_pid: HashMap<i32, (f32, Option<u64>)>,
}

struct Card {
    path: String,
    driver: String,
    slot: String,
    name: String,
}

pub struct GpuSampler {
    cards: Vec<Card>,
    prev_rc6: HashMap<String, u64>,
    prev_client: HashMap<(String, String, String), u64>,
    drm_pids: HashSet<i32>,
    nvidia_smi: bool,
}

impl GpuSampler {
    pub fn new() -> Self {
        let mut cards = vec![];
        if let Ok(rd) = fs::read_dir("/sys/class/drm") {
            let mut names: Vec<String> = rd
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("card") && !n.contains('-'))
                .collect();
            names.sort();
            for n in names {
                let path = format!("/sys/class/drm/{n}");
                let uevent = read(format!("{path}/device/uevent")).unwrap_or_default();
                let field = |k: &str| {
                    uevent
                        .lines()
                        .find_map(|l| l.strip_prefix(k).map(|v| v.to_string()))
                        .unwrap_or_default()
                };
                let driver = field("DRIVER=");
                let slot = field("PCI_SLOT_NAME=");
                if driver.is_empty() {
                    continue;
                }
                let name = pci_name(&slot).unwrap_or_else(|| driver.clone());
                cards.push(Card { path, driver, slot, name });
            }
        }
        GpuSampler {
            cards,
            prev_rc6: HashMap::new(),
            prev_client: HashMap::new(),
            drm_pids: HashSet::new(),
            nvidia_smi: which("nvidia-smi"),
        }
    }

    pub fn sample(&mut self, dt: f64, tick: u64, pids: impl Iterator<Item = i32>) -> GpuUsage {
        let full_scan = tick % 5 == 1;
        let candidates: Vec<i32> = if full_scan { pids.collect() } else { self.drm_pids.iter().copied().collect() };
        let mut cur: HashMap<(String, String, String), (u64, i32, u64)> = HashMap::new();
        let mut found = HashSet::new();
        let mut mem_by_pid: HashMap<i32, u64> = HashMap::new();
        let mut caps: HashMap<String, f64> = HashMap::new();
        for pid in candidates {
            let Ok(fds) = fs::read_dir(format!("/proc/{pid}/fd")) else { continue };
            let mut seen_clients = HashSet::new();
            for fd in fds.flatten() {
                let Ok(target) = fs::read_link(fd.path()) else { continue };
                if !target.to_string_lossy().starts_with("/dev/dri/") {
                    continue;
                }
                found.insert(pid);
                let Some(info) = read(format!("/proc/{pid}/fdinfo/{}", fd.file_name().to_string_lossy())) else { continue };
                let mut client = String::new();
                let mut pdev = String::new();
                let mut engines = vec![];
                let mut mem = 0u64;
                for l in info.lines() {
                    let Some((k, v)) = l.split_once(':') else { continue };
                    let v = v.trim();
                    if k == "drm-client-id" {
                        client = v.to_string();
                    } else if k == "drm-pdev" {
                        pdev = v.to_string();
                    } else if let Some(e) = k.strip_prefix("drm-engine-capacity-") {
                        caps.insert(e.to_string(), v.parse().unwrap_or(1.0));
                    } else if let Some(e) = k.strip_prefix("drm-engine-") {
                        if let Some(ns) = v.strip_suffix(" ns").and_then(|x| x.trim().parse::<u64>().ok()) {
                            engines.push((e.to_string(), ns));
                        }
                    } else if k.starts_with("drm-resident-") || k.starts_with("drm-memory-") {
                        mem += parse_kib(v);
                    }
                }
                if client.is_empty() || !seen_clients.insert((pdev.clone(), client.clone())) {
                    continue;
                }
                for (e, ns) in engines {
                    cur.entry((pdev.clone(), client.clone(), e)).or_insert((ns, pid, mem));
                }
                *mem_by_pid.entry(pid).or_default() += mem;
            }
        }
        if full_scan {
            self.drm_pids = found;
        }
        let span = dt * 1e9;
        let mut per_pid_engine: HashMap<(i32, String), f64> = HashMap::new();
        let mut per_dev_engine: HashMap<(String, String), f64> = HashMap::new();
        for (key, (ns, pid, _)) in &cur {
            if let Some(prev) = self.prev_client.get(key) {
                let cap = caps.get(&key.2).copied().unwrap_or(1.0).max(1.0);
                let pct = ns.saturating_sub(*prev) as f64 / span / cap * 100.0;
                *per_pid_engine.entry((*pid, key.2.clone())).or_default() += pct;
                *per_dev_engine.entry((key.0.clone(), key.2.clone())).or_default() += pct;
            }
        }
        self.prev_client = cur.into_iter().map(|(k, (ns, _, _))| (k, ns)).collect();

        let mut per_pid: HashMap<i32, (f32, Option<u64>)> = HashMap::new();
        for ((pid, _), pct) in per_pid_engine {
            let e = per_pid.entry(pid).or_insert((0.0, mem_by_pid.get(&pid).copied().filter(|m| *m > 0)));
            e.0 = e.0.max(pct.min(100.0) as f32);
        }

        let nv = if self.nvidia_smi { nvidia() } else { vec![] };
        let mut nv_iter = nv.into_iter();
        let mut gpus = vec![];
        for c in &self.cards {
            let mut g = GpuSnap { name: c.name.clone(), driver: c.driver.clone(), slot: c.slot.clone(), ..Default::default() };
            let dev = format!("{}/device", c.path);
            let mut engines: Vec<(String, f32)> = per_dev_engine
                .iter()
                .filter(|((pdev, _), _)| pdev.is_empty() || pdev == &c.slot)
                .map(|((_, e), p)| (e.clone(), p.min(100.0) as f32))
                .collect();
            engines.sort_by(|a, b| a.0.cmp(&b.0));
            let fdinfo_busy = engines.iter().map(|e| e.1).fold(None, |a: Option<f32>, b| Some(a.map_or(b, |a| a.max(b))));
            g.engines = engines;
            match c.driver.as_str() {
                "amdgpu" => {
                    g.busy_pct = read_u64(format!("{dev}/gpu_busy_percent")).map(|v| v as f32);
                    g.vram_used = read_u64(format!("{dev}/mem_info_vram_used"));
                    g.vram_total = read_u64(format!("{dev}/mem_info_vram_total"));
                    g.freq_mhz = read(format!("{dev}/pp_dpm_sclk")).and_then(|s| {
                        s.lines().find(|l| l.contains('*')).and_then(|l| {
                            l.split_whitespace().nth(1)?.trim_end_matches("Mhz").trim_end_matches("MHz").parse().ok()
                        })
                    });
                    hwmon_into(&dev, &mut g);
                    g.source = "amdgpu";
                }
                "i915" => {
                    let rc6 = read_u64(format!("{}/gt/gt0/rc6_residency_ms", c.path))
                        .or_else(|| read_u64(format!("{}/power/rc6_residency_ms", c.path)));
                    if let Some(r) = rc6 {
                        if let Some(p) = self.prev_rc6.get(&c.path) {
                            let idle = r.saturating_sub(*p) as f64 / (dt * 1000.0) * 100.0;
                            g.busy_pct = Some((100.0 - idle).clamp(0.0, 100.0) as f32);
                        }
                        self.prev_rc6.insert(c.path.clone(), r);
                    }
                    g.freq_mhz = read_u64(format!("{}/gt/gt0/rps_act_freq_mhz", c.path))
                        .or_else(|| read_u64(format!("{}/gt_act_freq_mhz", c.path)))
                        .map(|v| v as u32);
                    g.max_freq_mhz = read_u64(format!("{}/gt/gt0/rps_RP0_freq_mhz", c.path))
                        .or_else(|| read_u64(format!("{}/gt_RP0_freq_mhz", c.path)))
                        .map(|v| v as u32);
                    g.source = "i915 rc6";
                }
                "nvidia" => {
                    if let Some(n) = nv_iter.next() {
                        g.name = n.0;
                        g.busy_pct = Some(n.1);
                        g.vram_used = Some(n.2);
                        g.vram_total = Some(n.3);
                        g.temp_c = n.4;
                        g.freq_mhz = n.5;
                        g.power_w = n.6;
                        g.source = "nvidia-smi";
                    }
                }
                _ => {
                    hwmon_into(&dev, &mut g);
                }
            }
            if g.busy_pct.is_none() {
                if let Some(b) = fdinfo_busy {
                    g.busy_pct = Some(b);
                    g.source = "fdinfo";
                }
            }
            gpus.push(g);
        }
        GpuUsage { gpus, per_pid }
    }
}

fn parse_kib(v: &str) -> u64 {
    let mut it = v.split_whitespace();
    let n: u64 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    match it.next() {
        Some("KiB") => n * 1024,
        Some("MiB") => n * 1024 * 1024,
        Some("GiB") => n * 1024 * 1024 * 1024,
        _ => n,
    }
}

fn hwmon_into(dev: &str, g: &mut GpuSnap) {
    if let Ok(rd) = fs::read_dir(format!("{dev}/hwmon")) {
        if let Some(h) = rd.flatten().next() {
            let p = h.path();
            g.temp_c = read_i64(p.join("temp1_input")).map(|v| v as f32 / 1000.0);
            g.power_w = read_u64(p.join("power1_average"))
                .or_else(|| read_u64(p.join("power1_input")))
                .map(|v| v as f32 / 1_000_000.0);
        }
    }
}

fn pci_name(slot: &str) -> Option<String> {
    if slot.is_empty() || !which("lspci") {
        return None;
    }
    let out = run("lspci", &["-mm", "-s", slot]).ok()?;
    let quoted: Vec<&str> = out.split('"').collect();
    // 0 slot, 1 class, 3 vendor, 5 device
    let vendor = quoted.get(3)?.replace(" Corporation", "").replace(", Inc.", "").replace(" [AMD/ATI]", "");
    let device = quoted.get(5)?.to_string();
    Some(format!("{vendor} {device}"))
}

type Nv = (String, f32, u64, u64, Option<f32>, Option<u32>, Option<f32>);

fn nvidia() -> Vec<Nv> {
    let Ok(out) = run(
        "nvidia-smi",
        &[
            "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,clocks.gr,power.draw",
            "--format=csv,noheader,nounits",
        ],
    ) else {
        return vec![];
    };
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(',').map(|s| s.trim()).collect();
            if f.len() < 7 {
                return None;
            }
            Some((
                f[0].to_string(),
                f[1].parse().unwrap_or(0.0),
                f[2].parse::<u64>().unwrap_or(0) * 1024 * 1024,
                f[3].parse::<u64>().unwrap_or(0) * 1024 * 1024,
                f[4].parse().ok(),
                f[5].parse().ok(),
                f[6].parse().ok(),
            ))
        })
        .collect()
}
