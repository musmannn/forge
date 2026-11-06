use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

pub fn read(path: impl AsRef<Path>) -> Option<String> {
    fs::read_to_string(path).ok()
}

pub fn read_trim(path: impl AsRef<Path>) -> Option<String> {
    read(path).map(|s| s.trim().to_string())
}

pub fn read_u64(path: impl AsRef<Path>) -> Option<u64> {
    read_trim(path)?.parse().ok()
}

pub fn read_i64(path: impl AsRef<Path>) -> Option<i64> {
    read_trim(path)?.parse().ok()
}

pub fn clk_tck() -> f64 {
    static V: OnceLock<f64> = OnceLock::new();
    *V.get_or_init(|| {
        let v = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if v > 0 { v as f64 } else { 100.0 }
    })
}

pub fn page_size() -> u64 {
    static V: OnceLock<u64> = OnceLock::new();
    *V.get_or_init(|| {
        let v = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if v > 0 { v as u64 } else { 4096 }
    })
}

pub fn boot_time() -> u64 {
    static V: OnceLock<u64> = OnceLock::new();
    *V.get_or_init(|| {
        read("/proc/stat")
            .and_then(|s| {
                s.lines()
                    .find(|l| l.starts_with("btime "))
                    .and_then(|l| l[6..].trim().parse().ok())
            })
            .unwrap_or(0)
    })
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"))
}

pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local/share"));
    let dir = base.join("forge");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn config_home() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config"))
}

pub fn downloads_dir() -> PathBuf {
    if let Some(s) = read(config_home().join("user-dirs.dirs")) {
        for l in s.lines() {
            if let Some(v) = l.strip_prefix("XDG_DOWNLOAD_DIR=") {
                let v = v.trim_matches('"').replace("$HOME", &home().to_string_lossy());
                let p = PathBuf::from(v);
                if p.is_dir() {
                    return p;
                }
            }
        }
    }
    let p = home().join("Downloads");
    if p.is_dir() { p } else { home() }
}

/// Run a command and capture stdout. Errors carry stderr so the UI can show it.
pub fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("could not run {cmd}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("{cmd} exited with {}", out.status) } else { err })
    }
}

pub fn which(cmd: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(cmd).is_file()))
        .unwrap_or(false)
}

/// uid -> user name, from /etc/passwd (refreshed when an unknown uid shows up).
pub struct Users {
    map: HashMap<u32, String>,
}

impl Users {
    pub fn new() -> Self {
        let mut u = Users { map: HashMap::new() };
        u.reload();
        u
    }
    fn reload(&mut self) {
        if let Some(s) = read("/etc/passwd") {
            for l in s.lines() {
                let f: Vec<&str> = l.split(':').collect();
                if f.len() > 2 {
                    if let Ok(uid) = f[2].parse() {
                        self.map.insert(uid, f[0].to_string());
                    }
                }
            }
        }
    }
    pub fn name(&mut self, uid: u32) -> String {
        if !self.map.contains_key(&uid) {
            self.reload();
            if !self.map.contains_key(&uid) {
                self.map.insert(uid, uid.to_string());
            }
        }
        self.map[&uid].clone()
    }
}

pub fn uid() -> u32 {
    unsafe { libc::getuid() }
}

pub fn statvfs(path: &str) -> Option<(u64, u64, u64)> {
    let c = std::ffi::CString::new(path).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    let f = s.f_frsize as u64;
    let total = s.f_blocks as u64 * f;
    let free = s.f_bfree as u64 * f;
    let avail = s.f_bavail as u64 * f;
    Some((total, total.saturating_sub(free), avail))
}

/// Parse a cpu list like "0-3,8,10-11".
pub fn parse_cpu_list(s: &str) -> Vec<usize> {
    let mut v = Vec::new();
    for part in s.trim().split(',') {
        if let Some((a, b)) = part.split_once('-') {
            if let (Ok(a), Ok(b)) = (a.parse::<usize>(), b.parse::<usize>()) {
                v.extend(a..=b);
            }
        } else if let Ok(a) = part.parse() {
            v.push(a);
        }
    }
    v
}
