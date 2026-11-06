// Live state: the latest sample, ring-buffer history for every trace, settings.

export class Ring {
  constructor(cap) {
    this.cap = cap;
    this.buf = new Float32Array(cap);
    this.n = 0;
    this.head = 0;
  }
  push(v) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.cap;
    if (this.n < this.cap) this.n++;
  }
  // newest last; returns up to `count` values
  last(count) {
    const k = Math.min(count, this.n);
    const out = new Array(k);
    for (let i = 0; i < k; i++) out[i] = this.buf[(this.head - k + i + this.cap) % this.cap];
    return out;
  }
  get latest() {
    return this.n ? this.buf[(this.head - 1 + this.cap) % this.cap] : 0;
  }
  max(count) {
    let m = 0;
    for (const v of this.last(count)) if (v > m) m = v;
    return m;
  }
}

const SYS_CAP = 3600;
const PROC_CAP = 300;

const DEFAULTS = {
  interval: 1000,
  colourway: "graphite",
  cpuMode: "machine",
  showKernel: false,
  confirmEnd: true,
  windowSecs: 60,
  treeView: false,
  onTop: false,
  showVirtualNet: false,
  perfCpuView: "overall",
  alerts: { enabled: false, cpu: 90, cpuSecs: 15, mem: 90, temp: 90, battery: 15 },
  detailsColumns: null,
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("forge.settings") || "{}");
    return { ...DEFAULTS, ...s, alerts: { ...DEFAULTS.alerts, ...(s.alerts || {}) } };
  } catch {
    return { ...DEFAULTS };
  }
}

export const store = {
  snap: null,
  prev: null,
  settings: loadSettings(),
  hist: new Map(),
  procHist: new Map(),
  selected: null,
  filter: "",
  paused: false,
  cpuInfo: null,
  ticks: 0,
  listeners: new Set(),
  procIndex: new Map(),
};

export function saveSettings(patch) {
  Object.assign(store.settings, patch);
  localStorage.setItem("forge.settings", JSON.stringify(store.settings));
  emit("settings");
}

export function on(fn) {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
}

export function emit(kind) {
  for (const fn of store.listeners) fn(kind);
}

export function ring(key, cap = SYS_CAP) {
  let r = store.hist.get(key);
  if (!r) { r = new Ring(cap); store.hist.set(key, r); }
  return r;
}

export function procRing(pid) {
  let r = store.procHist.get(pid);
  if (!r) { r = { cpu: new Ring(PROC_CAP), mem: new Ring(PROC_CAP) }; store.procHist.set(pid, r); }
  return r;
}

export function windowSamples() {
  const ms = store.snap ? store.snap.interval_ms : store.settings.interval;
  return Math.max(10, Math.round((store.settings.windowSecs * 1000) / ms));
}

// CPU percent as the user chose to read it: share of the whole machine
// (Task Manager) or share of one core (btop, top).
export function cpuOf(p) {
  return store.settings.cpuMode === "core" && store.snap ? p.cpu * store.snap.ncpu : p.cpu;
}

// Forge sends a process's unchanging fields once; later samples leave them out.
const STATIC = ["cmd", "exe", "user", "app", "app_id", "icon", "container", "unit"];
const statics = new Map();
let onMissing = null;
export function onMissingStatics(fn) { onMissing = fn; }

function mergeStatics(procs) {
  let missing = false;
  const live = new Set();
  for (const p of procs) {
    const k = `${p.pid}:${p.start_s}`;
    live.add(k);
    if (p.full) {
      const st = {};
      for (const f of STATIC) st[f] = p[f] ?? null;
      st.cmd ||= ""; st.exe ||= ""; st.user ||= "";
      statics.set(k, st);
      Object.assign(p, st);
    } else {
      const st = statics.get(k);
      if (st) Object.assign(p, st);
      else { missing = true; Object.assign(p, { cmd: "", exe: "", user: String(p.uid) }); }
    }
  }
  if (store.ticks % 20 === 0) for (const k of statics.keys()) if (!live.has(k)) statics.delete(k);
  if (missing) onMissing?.();
}

export function ingest(snap) {
  mergeStatics(snap.procs);
  store.prev = store.snap;
  store.snap = snap;
  store.ticks++;
  const c = snap.cpu;
  ring("cpu").push(c.total);
  ring("cpu.user").push(c.user);
  ring("cpu.sys").push(c.system + c.irq);
  ring("cpu.io").push(c.iowait);
  c.cores.forEach((v, i) => ring(`core.${i}`).push(v));
  ring("freq").push(c.avg_freq_mhz);
  if (c.temp_c != null) ring("temp.cpu").push(c.temp_c);
  ring("load").push(c.load[0]);
  const m = snap.mem;
  ring("mem").push(m.total ? (m.in_use / m.total) * 100 : 0);
  ring("mem.bytes").push(m.in_use);
  ring("swap").push(m.swap_total ? (m.swap_used / m.swap_total) * 100 : 0);
  ring("mem.cache").push(m.total ? ((m.standby + m.modified) / m.total) * 100 : 0);
  for (const d of snap.disks) {
    ring(`disk.${d.name}`).push(d.active_pct);
    ring(`disk.${d.name}.r`).push(d.read_bps);
    ring(`disk.${d.name}.w`).push(d.write_bps);
  }
  let rx = 0, tx = 0;
  for (const n of snap.net) {
    ring(`net.${n.name}.rx`).push(n.rx_bps);
    ring(`net.${n.name}.tx`).push(n.tx_bps);
    if (!n.virtual_if && n.name !== "lo") { rx += n.rx_bps; tx += n.tx_bps; }
  }
  ring("net.rx").push(rx);
  ring("net.tx").push(tx);
  snap.gpus.forEach((g, i) => {
    ring(`gpu.${i}`).push(g.busy_pct ?? 0);
    for (const [e, v] of g.engines) ring(`gpu.${i}.${e}`).push(v);
    if (g.vram_total) ring(`gpu.${i}.vram`).push((g.vram_used / g.vram_total) * 100);
  });
  if (snap.battery) ring("bat").push(snap.battery.pct);
  if (snap.psi) {
    ring("psi.cpu").push(snap.psi.cpu_some);
    ring("psi.mem").push(snap.psi.mem_some);
    ring("psi.io").push(snap.psi.io_some);
  }
  let dr = 0, dw = 0;
  for (const d of snap.disks) { dr += d.read_bps; dw += d.write_bps; }
  ring("disk.r").push(dr);
  ring("disk.w").push(dw);

  const idx = new Map();
  for (const p of snap.procs) {
    idx.set(p.pid, p);
    const r = procRing(p.pid);
    r.cpu.push(p.cpu);
    r.mem.push(p.mem);
  }
  store.procIndex = idx;
  if (store.ticks % 30 === 0) {
    for (const pid of store.procHist.keys()) if (!idx.has(pid)) store.procHist.delete(pid);
  }
  emit("tick");
}
