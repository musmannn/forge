//! App history: CPU time and disk traffic per app, accumulated while Forge runs
//! and kept across sessions in ~/.local/share/forge/app-history.json.

use crate::sampler::ProcSnap;
use crate::util::{data_dir, now_ms};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AppRecord {
    pub name: String,
    pub icon: Option<String>,
    pub kind: String,
    pub cpu_s: f64,
    pub read: u64,
    pub write: u64,
    pub gpu_s: f64,
    pub peak_mem: u64,
    pub last_seen: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct HistoryFile {
    pub since: u64,
    pub apps: HashMap<String, AppRecord>,
}

pub struct AppHistory {
    pub data: HistoryFile,
    prev: HashMap<i32, (u64, f64, u64, u64)>,
}

impl AppHistory {
    fn path() -> std::path::PathBuf {
        data_dir().join("app-history.json")
    }

    pub fn load() -> Self {
        let data = fs::read_to_string(Self::path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(HistoryFile { since: now_ms(), apps: HashMap::new() });
        AppHistory { data, prev: HashMap::new() }
    }

    pub fn add(&mut self, procs: &[ProcSnap], tick: u64, dt: f64) {
        let now = now_ms();
        let mut next = HashMap::with_capacity(procs.len());
        for p in procs {
            if p.kind == "kernel" {
                continue;
            }
            let key = p.app.clone().unwrap_or_else(|| p.name.clone());
            let (dc, dr, dw) = match self.prev.get(&p.pid) {
                Some((start, c, r, w)) if *start == p.start_s => {
                    ((p.cpu_time_s - c).max(0.0), p.read_total.saturating_sub(*r), p.write_total.saturating_sub(*w))
                }
                _ => (0.0, 0, 0),
            };
            next.insert(p.pid, (p.start_s, p.cpu_time_s, p.read_total, p.write_total));
            let rec = self.data.apps.entry(key.clone()).or_insert_with(|| AppRecord {
                name: key,
                icon: p.icon.clone(),
                kind: p.kind.to_string(),
                ..Default::default()
            });
            rec.cpu_s += dc;
            rec.read += dr;
            rec.write += dw;
            if let Some(g) = p.gpu {
                rec.gpu_s += g as f64 / 100.0 * dt;
            }
            rec.peak_mem = rec.peak_mem.max(p.mem);
            rec.last_seen = now;
            if rec.icon.is_none() {
                rec.icon = p.icon.clone();
            }
        }
        self.prev = next;
        if tick % 60 == 0 {
            self.save();
        }
    }

    pub fn save(&self) {
        if let Ok(s) = serde_json::to_string(&self.data) {
            let tmp = Self::path().with_extension("json.tmp");
            if fs::write(&tmp, s).is_ok() {
                let _ = fs::rename(tmp, Self::path());
            }
        }
    }

    pub fn reset(&mut self) {
        self.data = HistoryFile { since: now_ms(), apps: HashMap::new() };
        self.save();
    }
}
