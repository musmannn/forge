# Forge: design and decisions

Forge is a Linux system monitor that merges Windows Task Manager (pages, process actions,
startup apps, services, users, app history) with btop (dense live graphs, per-core view,
tree view, signals, keyboard driving, colourways), plus things neither has on Linux.

## Decisions, the options weighed, and what was picked

### 1. GUI stack

| Option | Notes |
| --- | --- |
| **A. Tauri 2, Rust backend, vanilla JS + canvas UI, no frontend build step** (picked) | Uses the system WebKitGTK, so the binary is a few MB. No npm framework, no bundler. Canvas charts draw 1 Hz data cheaply. Full control over the look. |
| B. Tauri 2 with Svelte or Solid via Vite | Nicer component model, but adds a toolchain and a build step for an app whose UI is mostly tables and graphs. |
| C. Pure Rust GUI (egui, iced, Slint) | No webview and the lowest RAM, but the design system cannot be expressed as tokens and CSS, and tables with rich context menus take much more code. |

Recommendation: A. It is the lightest stack that still gives a designed UI.

### 2. Where the data comes from

| Option | Notes |
| --- | --- |
| **A. Read `/proc` and `/sys` directly** (picked) | Exact control of what each number means; per-process GPU via DRM `fdinfo`, PSI, cgroups, app scopes, sockets. Few dependencies. |
| B. `sysinfo` crate | Portable, but hides details Forge needs (cgroup, nice, DRM engines, io_ticks). |
| C. Shell out to `ps`, `ss`, `free` | Slow and fragile. Used only for `systemctl`, `loginctl`, `journalctl`, `ip`, which are the stable interfaces there. |

### 3. Privileged actions

Unprivileged by default. When the kernel refuses (raising priority, signalling another user's
process, system services, core dumps under `ptrace_scope=1`), the UI offers to retry the same
action through `pkexec`, which shows the desktop's own password dialog.

### 4. Navigation

Nine destinations, so a sidebar is earned: Overview (the btop screen), Processes, Performance,
App history, Startup apps, Users, Details, Services, plus Forge's own Connections and System.

## Feature map

From **Windows Task Manager**: grouped Processes (apps, background, system, kernel) with heat-shaded
CPU, memory, disk, GPU columns; end task; run new task; efficiency mode (SCHED_IDLE); priority;
affinity; open file location; search online; create dump file (gcore); properties; Performance
pages for CPU (logical-processor view, speed, sockets, cores, caches, virtualization, uptime,
processes, threads, handles), Memory (composition bar, committed, cached), each Disk (active time,
response time, throughput, type), each Network adapter (send, receive, addresses), GPU; App history;
Startup apps (enable or disable); Users (per-user totals, sign out); Details (every column);
Services (start, stop, restart, enable, disable); column picker; update speed; always on top;
summary (mini) view.

From **btop**: one dense overview, per-core graphs and bars, temperatures, load average, battery,
network graphs with totals, process tree, every signal, process detail panel with its own trace,
filter, sort, keyboard driving (vim keys), pause, update interval, colourways.

Forge's own: Connections (every socket with its owning process), pressure stall (PSI) readings,
container and sandbox column (Docker, Podman, Flatpak, Snap), per-process GPU on Intel, AMD and
any DRM driver that reports fdinfo, threshold alerts as desktop notifications, command palette,
export of a snapshot to JSON or CSV, service logs, open files, environment and memory maps per
process, OOM score.

## Honesty

Forge shows only what the kernel reports. Per-process network throughput needs root and eBPF, so
it is not shown. Memory speed and slots need root (`dmidecode`), so they are not shown.
