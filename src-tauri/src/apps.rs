//! Desktop entries: lets Forge name a process the way the launcher does,
//! group it as an app, and show its icon.

use crate::util::{home, read};
use base64::Engine;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default)]
pub struct DesktopEntry {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub exec: Option<String>,
    pub wm_class: Option<String>,
    pub hidden: bool,
    pub terminal: bool,
}

pub fn data_dirs() -> Vec<PathBuf> {
    let mut v = vec![home().join(".local/share")];
    let sys = std::env::var("XDG_DATA_DIRS").unwrap_or_default();
    let sys = if sys.is_empty() { "/usr/local/share:/usr/share".to_string() } else { sys };
    for d in sys.split(':').filter(|d| !d.is_empty()) {
        v.push(PathBuf::from(d));
    }
    for extra in [
        "/var/lib/flatpak/exports/share",
        "/var/lib/snapd/desktop",
        "/usr/share",
    ] {
        let p = PathBuf::from(extra);
        if !v.contains(&p) {
            v.push(p);
        }
    }
    v.push(home().join(".local/share/flatpak/exports/share"));
    v
}

pub fn parse_desktop(path: &Path, id: &str) -> Option<DesktopEntry> {
    let text = read(path)?;
    let mut e = DesktopEntry { id: id.to_string(), ..Default::default() };
    let mut in_main = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_main = line == "[Desktop Entry]";
            continue;
        }
        if !in_main {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                "Name" => e.name = v.trim().to_string(),
                "Icon" => e.icon = Some(v.trim().to_string()),
                "Exec" => e.exec = Some(v.trim().to_string()),
                "Terminal" => e.terminal = v.trim() == "true",
                "StartupWMClass" => e.wm_class = Some(v.trim().to_lowercase()),
                "NoDisplay" | "Hidden" => {
                    if v.trim() == "true" {
                        e.hidden = true
                    }
                }
                _ => {}
            }
        }
    }
    if e.name.is_empty() {
        e.name = id.to_string();
    }
    Some(e)
}

/// The program an Exec line runs, by base name (skips env, flatpak run, quoting).
pub fn exec_program(exec: &str) -> Option<String> {
    let mut parts = exec.split_whitespace().map(|s| s.trim_matches('"'));
    let mut first = parts.next()?;
    while first == "env" || first.contains('=') {
        first = parts.next()?;
    }
    Some(Path::new(first).file_name()?.to_string_lossy().into_owned())
}

pub struct AppIndex {
    pub by_id: HashMap<String, DesktopEntry>,
    pub by_exec: HashMap<String, String>,
    icons: HashMap<String, Option<String>>,
}

impl AppIndex {
    pub fn load() -> Self {
        let mut by_id = HashMap::new();
        for dir in data_dirs() {
            let apps = dir.join("applications");
            scan(&apps, "", &mut by_id);
        }
        // several spellings of "the program this entry launches", most specific first
        let mut by_exec = HashMap::new();
        let mut ids: Vec<&String> = by_id.keys().collect();
        ids.sort();
        for pass in 0..3 {
            for id in &ids {
                let e = &by_id[*id];
                if e.hidden || e.terminal {
                    continue;
                }
                let lower = id.to_lowercase();
                let keys: Vec<String> = match pass {
                    0 => e.exec.as_deref().and_then(exec_program).into_iter().map(|p| p.to_lowercase()).collect(),
                    1 => [e.wm_class.clone(), Some(lower.clone()), lower.rsplit('.').next().map(String::from)]
                        .into_iter()
                        .flatten()
                        .collect(),
                    _ => lower.split('-').next().filter(|s| s.len() >= 4 && *s != lower).map(String::from).into_iter().collect(),
                };
                for k in keys {
                    by_exec.entry(k).or_insert_with(|| (*id).clone());
                }
            }
        }
        AppIndex { by_id, by_exec, icons: HashMap::new() }
    }

    /// Match the id a launcher put in a cgroup unit name to a desktop entry.
    pub fn match_unit(&self, raw: &str) -> Option<&DesktopEntry> {
        let mut cand = raw.to_string();
        loop {
            if let Some(e) = self.by_id.get(&cand) {
                return Some(e);
            }
            let lower = cand.to_lowercase();
            if let Some(e) = self.by_id.get(&lower) {
                return Some(e);
            }
            match cand.split_once('-') {
                Some((_, rest)) if !rest.is_empty() => cand = rest.to_string(),
                _ => return None,
            }
        }
    }

    pub fn match_exe(&self, exe_base: &str) -> Option<&DesktopEntry> {
        self.by_id.get(self.by_exec.get(&exe_base.to_lowercase())?)
    }

    pub fn icon_data(&mut self, name: &str) -> Option<String> {
        if let Some(v) = self.icons.get(name) {
            return v.clone();
        }
        let v = find_icon(name).and_then(|p| {
            let bytes = fs::read(&p).ok()?;
            if bytes.len() > 512 * 1024 {
                return None;
            }
            let mime = if p.extension().map(|e| e == "svg").unwrap_or(false) {
                "image/svg+xml"
            } else if p.extension().map(|e| e == "xpm").unwrap_or(false) {
                return None;
            } else {
                "image/png"
            };
            Some(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ))
        });
        self.icons.insert(name.to_string(), v.clone());
        v
    }
}

fn scan(dir: &Path, prefix: &str, out: &mut HashMap<String, DesktopEntry>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for ent in rd.flatten() {
        let p = ent.path();
        let fname = ent.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            scan(&p, &format!("{prefix}{fname}-"), out);
        } else if let Some(stem) = fname.strip_suffix(".desktop") {
            let id = format!("{prefix}{stem}");
            if out.contains_key(&id) {
                continue;
            }
            if let Some(e) = parse_desktop(&p, &id) {
                out.insert(id, e);
            }
        }
    }
}

fn find_icon(name: &str) -> Option<PathBuf> {
    if name.starts_with('/') {
        let p = PathBuf::from(name);
        return p.is_file().then_some(p);
    }
    let themes = ["hicolor", "Yaru", "Adwaita", "breeze", "Papirus"];
    let sizes = ["scalable", "48x48", "64x64", "128x128", "256x256", "32x32", "512x512", "24x24"];
    let cats = ["apps", "devices", "categories", "places", "mimetypes", "status", "actions"];
    for dir in data_dirs() {
        for t in themes {
            for s in sizes {
                for c in cats {
                    for ext in ["svg", "png"] {
                        let p = dir.join(format!("icons/{t}/{s}/{c}/{name}.{ext}"));
                        if p.is_file() {
                            return Some(p);
                        }
                    }
                }
            }
        }
        for ext in ["svg", "png"] {
            let p = dir.join(format!("pixmaps/{name}.{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// systemd escapes '-' inside unit name components as \x2d.
pub fn unescape_unit(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 3 < b.len() && b[i + 1] == b'x' {
            if let Ok(v) = u8::from_str_radix(&s[i + 2..i + 4], 16) {
                out.push(v as char);
                i += 4;
                continue;
            }
        }
        out.push(b[i] as char);
        i += 1;
    }
    out
}

/// From a cgroup path, the app unit (if the process was launched as an app)
/// and the container or sandbox it runs in.
pub fn classify_cgroup(cg: &str) -> (Option<String>, Option<String>, bool) {
    let mut app_unit = None;
    let mut container = None;
    let system = cg.starts_with("/system.slice") || cg == "/init.scope" || cg.starts_with("/machine.slice");
    for comp in cg.split('/') {
        if container.is_none() {
            if comp.starts_with("docker-") || comp == "docker" {
                container = Some("docker".into());
            } else if comp.starts_with("libpod-") {
                container = Some("podman".into());
            } else if comp.starts_with("app-flatpak-") {
                container = Some("flatpak".into());
            } else if comp.starts_with("snap.") {
                container = Some("snap".into());
            } else if comp.starts_with("lxc") {
                container = Some("lxc".into());
            } else if comp.starts_with("machine-") {
                container = Some("vm".into());
            }
        }
        if app_unit.is_none() && comp.starts_with("app-") {
            let mut s = unescape_unit(&comp[4..]);
            for suf in [".scope", ".service", ".slice"] {
                if let Some(x) = s.strip_suffix(suf) {
                    s = x.to_string();
                }
            }
            if let Some((a, _)) = s.split_once('@') {
                s = a.to_string();
            }
            // trailing "-<random>" from systemd scopes
            if let Some((a, b)) = s.rsplit_once('-') {
                if !b.is_empty() && b.chars().all(|c| c.is_ascii_hexdigit()) {
                    s = a.to_string();
                }
            }
            if let Some(x) = s.strip_prefix("flatpak-") {
                s = x.to_string();
            }
            app_unit = Some(s);
        }
    }
    (app_unit, container, system)
}
