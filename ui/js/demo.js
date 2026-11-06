// Browser preview only: one real sample (sanitised) replayed with drift, so the
// screens can be designed and reviewed outside the app window. Never loaded in Forge itself.

const fx = await (await fetch(new URL("./demo-fixture.json", import.meta.url))).json();
let snap = fx.snapshot;
let t = 0;
const listeners = [];

const walk = (v, step, lo, hi) => Math.max(lo, Math.min(hi, v + (Math.random() - 0.5) * step));

function next() {
  t++;
  const s = structuredClone(snap);
  s.t = Date.now();
  const c = s.cpu;
  c.cores = c.cores.map((v) => walk(v, 30, 0, 100));
  c.total = c.cores.reduce((a, b) => a + b, 0) / c.cores.length;
  c.user = c.total * 0.7;
  c.system = c.total * 0.25;
  c.avg_freq_mhz = Math.round(walk(c.avg_freq_mhz || 1800, 600, 400, 4700));
  c.uptime_s += t;
  c.temp_c = walk(c.temp_c || 50, 3, 38, 80);
  s.mem.in_use = walk(s.mem.in_use, 6e7, 3e9, s.mem.total * 0.8);
  for (const p of s.procs) {
    if (p.kind === "kernel") continue;
    p.cpu = Math.max(0, fx.snapshot.procs.find((q) => q.pid === p.pid)?.cpu * (0.6 + Math.random() * 0.8) || 0);
  }
  for (const n of s.net) if (!n.virtual_if) { n.rx_bps = Math.abs(walk(0, 4e6, 0, 4e6)); n.tx_bps = Math.abs(walk(0, 6e5, 0, 6e5)); }
  for (const d of s.disks) { d.read_bps = Math.abs(walk(0, 2e7, 0, 2e7)); d.write_bps = Math.abs(walk(0, 8e6, 0, 8e6)); d.active_pct = Math.min(100, (d.read_bps + d.write_bps) / 3e5); }
  for (const g of s.gpus) { g.busy_pct = walk(g.busy_pct ?? 10, 12, 0, 70); g.engines = g.engines.map(([e, v]) => [e, e === "render" ? g.busy_pct * 0.8 : v]); }
  snap = s;
  return s;
}

function history() {
  const apps = {};
  for (const p of snap.procs) {
    if (p.kind === "kernel") continue;
    const k = p.app || p.name;
    const a = (apps[k] ||= { name: k, icon: p.icon, kind: p.kind, cpu_s: 0, read: 0, write: 0, gpu_s: 0, peak_mem: 0, last_seen: Date.now() });
    a.cpu_s += p.cpu_time_s;
    a.read += p.read_total;
    a.write += p.write_total;
    a.peak_mem = Math.max(a.peak_mem, p.mem);
  }
  return { since: fx.history.since, apps };
}

function details(pid) {
  const p = snap.procs.find((x) => x.pid === pid);
  if (!p) throw "The process has exited";
  return {
    pid, name: p.name, argv: [p.exe || p.name], exe: p.exe, cwd: "/home/you", root: "/", state: "S (sleeping)", ppid: p.ppid, parent_name: snap.procs.find((x) => x.pid === p.ppid)?.name || "",
    uid: `${p.uid}`, gid: `${p.uid}`, start_s: p.start_s, threads: Array.from({ length: Math.min(p.threads, 12) }, (_, i) => ({ tid: pid + i, name: i ? `${p.name}:w${i}` : p.name, state: "S", cpu_time_s: p.cpu_time_s / (i + 1), last_cpu: i % 12, nice: p.nice })),
    fds: [{ fd: 0, target: "/dev/null" }, { fd: 1, target: "socket:[48121]" }, { fd: 2, target: "pipe:[48122]" }], fd_count: 3, env: ["HOME=/home/you", "LANG=en_GB.UTF-8"], env_readable: true,
    limits: [["Max open files", "1024", "524288"], ["Max processes", "62519", "62519"]], cgroup: p.unit ? `/user.slice/${p.unit}` : "/", policy: p.policy === 5 ? "Idle (efficiency mode)" : "Normal (SCHED_OTHER)", nice: p.nice,
    oom_score: 666, oom_adj: 0, affinity: [...Array(snap.ncpu).keys()], io: [["read_bytes", p.read_total], ["write_bytes", p.write_total]], memory: [["VmRSS", p.mem], ["RssAnon", p.mem_private]], ctx_voluntary: 1204, ctx_involuntary: 31,
    wchan: "do_epoll_wait", maps: [[p.exe || "/usr/lib/libc.so.6", 4.2e6]], map_count: 212, namespaces: [["pid", "pid:[4026531836], shared with the host"]], seccomp: "off", capabilities: "0000000000000000",
  };
}

const handlers = {
  get_snapshot: () => next(),
  cpu_info: () => fx.cpu_info,
  system_info: () => fx.system_info,
  list_services: ({ user }) => (user ? fx.user_services : fx.services),
  startup_apps: () => fx.startup,
  list_sessions: () => fx.sessions,
  list_connections: () => fx.connections,
  app_history: () => history(),
  process_details: ({ pid }) => details(pid),
  get_affinity: () => [...Array(snap.ncpu).keys()],
  app_icon: () => null,
  export_snapshot: ({ format }) => `~/Downloads/forge-sample.${format}`,
  service_logs: () => "2026-11-06T09:41:07+0000 example systemd[1]: Started the sample service.",
};

export async function invoke(cmd, args) {
  const fn = handlers[cmd];
  return fn ? fn(args || {}) : undefined;
}

export async function listen(event, cb) {
  if (event !== "snapshot") return () => {};
  listeners.push(cb);
  if (listeners.length === 1) setInterval(() => { const s = next(); listeners.forEach((l) => l(s)); }, 1000);
  return () => {};
}
