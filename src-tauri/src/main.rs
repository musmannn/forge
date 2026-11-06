#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod actions;
mod apps;
mod gpu;
mod history;
mod sampler;
mod system;
mod util;

use sampler::{Sampler, Snapshot};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewWindow};

struct AppState {
    sampler: Arc<Mutex<Sampler>>,
    last: Arc<Mutex<Option<Arc<Snapshot>>>>,
    interval: Arc<AtomicU64>,
    paused: Arc<AtomicBool>,
    kick: Arc<AtomicBool>,
}

type R<T> = Result<T, String>;

#[tauri::command]
fn get_snapshot(s: tauri::State<AppState>) -> Option<Snapshot> {
    s.last.lock().unwrap().as_ref().map(|a| (**a).clone())
}

#[tauri::command]
fn set_interval(s: tauri::State<AppState>, ms: u64) {
    s.interval.store(ms.clamp(250, 10_000), Ordering::Relaxed);
}

#[tauri::command]
fn set_paused(s: tauri::State<AppState>, paused: bool) {
    s.paused.store(paused, Ordering::Relaxed);
}

#[tauri::command]
fn refresh_now(s: tauri::State<AppState>) {
    s.kick.store(true, Ordering::Relaxed);
}

#[tauri::command(async)]
fn signal_process(pid: i32, sig: i32, elevated: bool) -> R<()> {
    actions::signal(pid, sig, elevated)
}

#[tauri::command(async)]
fn signal_tree(pid: i32, sig: i32, elevated: bool) -> R<usize> {
    actions::signal_tree(pid, sig, elevated)
}

#[tauri::command(async)]
fn set_nice(pid: i32, nice: i32, elevated: bool) -> R<()> {
    actions::set_nice(pid, nice, elevated)
}

#[tauri::command(async)]
fn set_efficiency(pid: i32, on: bool, elevated: bool) -> R<()> {
    actions::set_efficiency(pid, on, elevated)
}

#[tauri::command(async)]
fn get_affinity(pid: i32) -> R<Vec<usize>> {
    actions::get_affinity(pid)
}

#[tauri::command(async)]
fn set_affinity(pid: i32, cpus: Vec<usize>, elevated: bool) -> R<()> {
    actions::set_affinity(pid, cpus, elevated)
}

#[tauri::command(async)]
fn run_task(command: String, elevated: bool) -> R<()> {
    actions::run_task(&command, elevated)
}

#[tauri::command(async)]
fn open_location(pid: i32) -> R<()> {
    actions::open_location(pid)
}

#[tauri::command(async)]
fn open_path(path: String) -> R<()> {
    actions::open_path(&path)
}

#[tauri::command(async)]
fn open_url(url: String) -> R<()> {
    if !url.starts_with("https://") {
        return Err("Only https links open from Forge".into());
    }
    actions::open_path(&url)
}

#[tauri::command(async)]
fn core_dump(pid: i32, elevated: bool) -> R<String> {
    actions::core_dump(pid, elevated)
}

#[tauri::command(async)]
fn process_details(pid: i32) -> R<actions::Details> {
    actions::details(pid)
}

#[tauri::command(async)]
fn app_icon(s: tauri::State<'_, AppState>, name: String) -> Option<String> {
    s.sampler.lock().unwrap().icon(&name)
}

#[tauri::command(async)]
fn app_history(s: tauri::State<'_, AppState>) -> history::HistoryFile {
    s.sampler.lock().unwrap().history.data.clone()
}

#[tauri::command(async)]
fn reset_app_history(s: tauri::State<'_, AppState>) {
    s.sampler.lock().unwrap().history.reset();
}

#[tauri::command(async)]
fn reload_apps(s: tauri::State<'_, AppState>) {
    s.sampler.lock().unwrap().reload_apps();
}

#[tauri::command(async)]
fn list_services(user: bool) -> R<Vec<system::Service>> {
    system::services(user)
}

#[tauri::command(async)]
fn service_action(user: bool, unit: String, verb: String, elevated: bool) -> R<()> {
    system::service_action(user, &unit, &verb, elevated)
}

#[tauri::command(async)]
fn service_logs(user: bool, unit: String, lines: u32) -> R<String> {
    system::service_logs(user, &unit, lines)
}

#[tauri::command(async)]
fn startup_apps() -> Vec<system::StartupApp> {
    system::startup_apps()
}

#[tauri::command(async)]
fn set_startup(id: String, enabled: bool) -> R<()> {
    system::set_startup(&id, enabled)
}

#[tauri::command(async)]
fn add_startup(name: String, command: String) -> R<String> {
    system::add_startup(&name, &command)
}

#[tauri::command(async)]
fn remove_startup(id: String) -> R<()> {
    system::remove_startup(&id)
}

#[tauri::command(async)]
fn list_sessions() -> R<Vec<std::collections::BTreeMap<String, String>>> {
    system::sessions()
}

#[tauri::command(async)]
fn session_action(id: String, verb: String) -> R<()> {
    system::session_action(&id, &verb)
}

#[tauri::command(async)]
fn list_connections() -> Vec<system::Conn> {
    system::connections()
}

#[tauri::command(async)]
fn system_info(s: tauri::State<'_, AppState>) -> system::SysInfo {
    let gpus = s
        .last
        .lock()
        .unwrap()
        .as_ref()
        .map(|l| l.gpus.iter().map(|g| (g.name.clone(), g.driver.clone())).collect())
        .unwrap_or_default();
    system::sys_info(gpus)
}

#[tauri::command(async)]
fn cpu_info() -> system::CpuInfo {
    system::cpu_info()
}

#[tauri::command(async)]
fn notify(title: String, body: String) -> R<()> {
    system::notify(&title, &body)
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

#[tauri::command(async)]
fn export_snapshot(s: tauri::State<'_, AppState>, format: String) -> R<String> {
    let snap = s.last.lock().unwrap().clone().ok_or("No sample yet")?;
    let stamp = util::now_ms() / 1000;
    let dir = util::downloads_dir();
    let path = if format == "csv" {
        let mut out = String::from("pid,ppid,name,user,state,cpu_pct,memory_bytes,private_bytes,swap_bytes,threads,nice,disk_read_bps,disk_write_bps,gpu_pct,kind,app,container,command\n");
        for p in &snap.procs {
            out.push_str(&format!(
                "{},{},{},{},{},{:.2},{},{},{},{},{},{:.0},{:.0},{},{},{},{},{}\n",
                p.pid,
                p.ppid,
                csv_field(&p.name),
                csv_field(&p.user),
                p.state,
                p.cpu,
                p.mem,
                p.mem_private,
                p.swap,
                p.threads,
                p.nice,
                p.read_bps,
                p.write_bps,
                p.gpu.map(|g| format!("{g:.1}")).unwrap_or_default(),
                p.kind,
                csv_field(p.app.as_deref().unwrap_or("")),
                p.container.as_deref().unwrap_or(""),
                csv_field(&p.cmd)
            ));
        }
        let path = dir.join(format!("forge-processes-{stamp}.csv"));
        std::fs::write(&path, out).map_err(|e| e.to_string())?;
        path
    } else {
        let path = dir.join(format!("forge-snapshot-{stamp}.json"));
        let json = serde_json::to_string_pretty(&*snap).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())?;
        path
    };
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn selftest() -> bool {
    std::env::var_os("FORGE_SELFTEST").is_some()
}

#[tauri::command]
fn log_js(msg: String) {
    eprintln!("[ui] {msg}");
}

#[tauri::command]
fn quit(app: tauri::AppHandle, code: i32) {
    app.exit(code);
}

#[tauri::command]
fn set_always_on_top(window: WebviewWindow, on: bool) -> R<()> {
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_compact(window: WebviewWindow, on: bool) -> R<()> {
    let size = if on { tauri::LogicalSize::new(380.0, 300.0) } else { tauri::LogicalSize::new(1360.0, 860.0) };
    window.set_size(size).map_err(|e| e.to_string())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--dump") {
        // prints one real sample as JSON, for debugging and UI fixtures
        let mut s = Sampler::new();
        s.sample(1000);
        std::thread::sleep(Duration::from_millis(1000));
        let snap = s.sample(1000);
        let extra = serde_json::json!({
            "snapshot": snap,
            "cpu_info": system::cpu_info(),
            "system_info": system::sys_info(snap.gpus.iter().map(|g| (g.name.clone(), g.driver.clone())).collect()),
            "services": system::services(false).unwrap_or_default(),
            "user_services": system::services(true).unwrap_or_default(),
            "startup": system::startup_apps(),
            "sessions": system::sessions().unwrap_or_default(),
            "connections": system::connections(),
            "history": s.history.data,
        });
        println!("{}", serde_json::to_string(&extra).unwrap());
        return;
    }
    let sampler = Arc::new(Mutex::new(Sampler::new()));
    let state = AppState {
        sampler: sampler.clone(),
        last: Arc::new(Mutex::new(None)),
        interval: Arc::new(AtomicU64::new(1000)),
        paused: Arc::new(AtomicBool::new(false)),
        kick: Arc::new(AtomicBool::new(false)),
    };
    let (last, interval, paused, kick) = (state.last.clone(), state.interval.clone(), state.paused.clone(), state.kick.clone());
    let saver = sampler.clone();

    tauri::Builder::default()
        .manage(state)
        .setup(move |app| {
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("sampler".into())
                .spawn(move || loop {
                    let ms = interval.load(Ordering::Relaxed);
                    if !paused.load(Ordering::Relaxed) || kick.load(Ordering::Relaxed) {
                        kick.store(false, Ordering::Relaxed);
                        let snap = Arc::new(sampler.lock().unwrap().sample(ms));
                        let _ = handle.emit("snapshot", &*snap);
                        *last.lock().unwrap() = Some(snap);
                    }
                    let mut waited = 0;
                    while waited < ms && !kick.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(50));
                        waited += 50;
                    }
                })?;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            set_interval,
            set_paused,
            refresh_now,
            signal_process,
            signal_tree,
            set_nice,
            set_efficiency,
            get_affinity,
            set_affinity,
            run_task,
            open_location,
            open_path,
            open_url,
            core_dump,
            process_details,
            app_icon,
            app_history,
            reset_app_history,
            reload_apps,
            list_services,
            service_action,
            service_logs,
            startup_apps,
            set_startup,
            add_startup,
            remove_startup,
            list_sessions,
            session_action,
            list_connections,
            system_info,
            cpu_info,
            notify,
            export_snapshot,
            set_always_on_top,
            set_compact,
            selftest,
            log_js,
            quit
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Forge")
        .run(move |_, ev| {
            if let tauri::RunEvent::Exit = ev {
                saver.lock().unwrap().history.save();
            }
        });
}
