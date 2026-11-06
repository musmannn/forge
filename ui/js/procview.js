// Turning the process list into table rows: grouped like Task Manager,
// a tree like btop, or flat.

import { invoke } from "./api.js";
import { store, cpuOf } from "./store.js";
import { h, icon } from "./ui.js";
import * as f from "./fmt.js";

const icons = new Map();
export function appIcon(name) {
  if (!name) return null;
  const v = icons.get(name);
  if (v === undefined) {
    icons.set(name, null);
    invoke("app_icon", { name }).then((d) => icons.set(name, d || false)).catch(() => icons.set(name, false));
    return null;
  }
  return v || null;
}

export function nameCell(p, agg) {
  const src = appIcon(p.icon);
  const img = src ? h("img", { class: "ico", src, alt: "", width: "18", height: "18" }) : h("span", { class: "ico-blank", "aria-hidden": "true" });
  const label = agg ? p.name : p.kind === "app" && p.app && p.app !== p.name ? p.name : p.name;
  return [img, h("span", { class: "t" }, label, agg ? h("span", { class: "cnt" }, ` (${p.count})`) : null)];
}

export function statusCell(p) {
  const out = [];
  if (p.state === "T") out.push(h("span", { class: "chip chip--amber" }, "Suspended"));
  if (p.state === "Z") out.push(h("span", { class: "chip chip--bad" }, "Zombie"));
  if (p.state === "D") out.push(h("span", { class: "chip" }, "Waiting on disk"));
  if (p.policy === 5) out.push(h("span", { class: "chip chip--cool" }, "Efficiency"));
  if (p.container) out.push(h("span", { class: "chip" }, p.container));
  return out;
}

export function matches(p, q) {
  if (!q) return true;
  q = q.toLowerCase();
  return (
    p.name.toLowerCase().includes(q) ||
    String(p.pid) === q ||
    (p.app && p.app.toLowerCase().includes(q)) ||
    p.user.toLowerCase() === q ||
    (p.cmd && p.cmd.toLowerCase().includes(q)) ||
    (p.unit && p.unit.toLowerCase().includes(q)) ||
    (p.container && p.container === q)
  );
}

const memTotal = () => store.snap?.mem.total || 1;

export function columns(opts = {}) {
  const ncpu = () => store.snap?.ncpu || 1;
  const cols = [
    { key: "name", label: "Name", width: "minmax(240px, 2.4fr)", render: (p, r) => nameCell(p, r?.agg), sortVal: (p) => (p.name || "").toLowerCase(), titleOf: (p) => p.cmd || p.name },
    { key: "status", label: "Status", width: "minmax(110px, 0.9fr)", render: (p) => statusCell(p), sortVal: (p) => (p.state === "T" ? 2 : 0) + (p.policy === 5 ? 1 : 0) },
    { key: "pid", label: "PID", width: "80px", num: true, render: (p) => (p.agg ? "" : String(p.pid)), sortVal: (p) => p.pid },
    {
      key: "cpu", label: "CPU", width: "86px", num: true,
      render: (p) => f.pct(cpuOf(p), 1),
      sortVal: (p) => p.cpu,
      heat: (p) => p.cpu / 60,
      total: () => f.pct(store.settings.cpuMode === "core" ? (store.snap?.cpu.total || 0) * ncpu() : store.snap?.cpu.total || 0, 0),
      title: store.settings.cpuMode === "core" ? "Percent of one core" : "Percent of the whole processor",
      groupVal: (r) => f.pct(r.sum?.cpu ?? 0, 1),
    },
    {
      key: "mem", label: "Memory", width: "100px", num: true,
      render: (p) => f.bytes(p.mem_private || p.mem),
      sortVal: (p) => p.mem_private || p.mem,
      heat: (p) => ((p.mem_private || p.mem) / memTotal()) * 5,
      total: () => (store.snap ? f.pct((store.snap.mem.in_use / store.snap.mem.total) * 100) : ""),
      title: "Private memory: what this process alone holds in RAM",
      groupVal: (r) => f.bytes(r.sum?.mem ?? 0),
    },
    {
      key: "disk", label: "Disk", width: "116px", num: true,
      render: (p) => (p.read_bps + p.write_bps > 0 ? f.rate(p.read_bps + p.write_bps) : "0\u00a0B/s"),
      sortVal: (p) => p.read_bps + p.write_bps,
      heat: (p) => (p.read_bps + p.write_bps) / (40 * 1024 * 1024),
      total: () => (store.snap ? f.pct(Math.max(0, ...store.snap.disks.map((d) => d.active_pct))) : ""),
      title: "Reads and writes that reached storage. Other users' processes need administrator rights to read.",
    },
    {
      key: "gpu", label: "GPU", width: "76px", num: true,
      render: (p) => (p.gpu != null ? f.pct(p.gpu, 1) : ""),
      sortVal: (p) => p.gpu ?? -1,
      heat: (p) => (p.gpu ?? 0) / 100,
      total: () => (store.snap?.gpus[0]?.busy_pct != null ? f.pct(store.snap.gpus[0].busy_pct) : ""),
      title: "From the DRM driver's per-client engine counters",
    },
  ];
  if (opts.extra) cols.push(...opts.extra);
  return cols;
}

function aggregate(name, procs) {
  const a = { agg: true, name, count: procs.length, pid: procs[0].pid, icon: procs.find((p) => p.icon)?.icon, cpu: 0, mem: 0, mem_private: 0, read_bps: 0, write_bps: 0, gpu: null, state: "S", policy: 0, procs, user: procs[0].user, kind: "app" };
  for (const p of procs) {
    a.cpu += p.cpu;
    a.mem += p.mem;
    a.mem_private += p.mem_private || p.mem;
    a.read_bps += p.read_bps;
    a.write_bps += p.write_bps;
    if (p.gpu != null) a.gpu = (a.gpu || 0) + p.gpu;
  }
  if (procs.every((p) => p.state === "T")) a.state = "T";
  if (procs.every((p) => p.policy === 5)) a.policy = 5;
  const ids = new Set(procs.map((p) => p.pid));
  a.roots = procs.filter((p) => !ids.has(p.ppid)).map((p) => p.pid);
  a.root = procs.find((p) => p.pid === a.roots[0]) || procs[0];
  a.container = procs[0].container;
  return a;
}

/** Task Manager grouping: apps (merged by name), background, system, kernel. */
export function groupedRows(table, expanded, procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const appOf = (p) => {
    let q = p;
    for (let i = 0; i < 64 && q; i++) {
      if (q.kind === "app" && q.app) return q.app;
      q = byPid.get(q.ppid);
    }
    return null;
  };
  const apps = new Map();
  const bg = [], sys = [], kern = [];
  const q = store.filter;
  for (const p of procs) {
    const a = appOf(p);
    if (a) {
      if (!apps.has(a)) apps.set(a, []);
      apps.get(a).push(p);
    } else if (p.kind === "kernel") kern.push(p);
    else if (p.kind === "system") sys.push(p);
    else bg.push(p);
  }
  const rows = [];
  const section = (key, label, list, isApps) => {
    if (!list.length) return;
    const open = !expanded.has(`!${key}`);
    const all = isApps ? list.flatMap(([, ps]) => ps) : list;
    const sum = { cpu: 0, mem: 0 };
    for (const p of all) { sum.cpu += cpuOf(p); sum.mem += p.mem_private || p.mem; }
    rows.push({ key: `sec:${key}`, group: { label, count: list.length, expanded: open }, sum });
    if (!open) return;
    if (isApps) {
      const aggs = table.sortRows(list.map(([name, ps]) => ({ data: aggregate(name, ps) }))).map((r) => r.data);
      for (const a of aggs) {
        const filtered = q ? a.procs.filter((p) => matches(p, q)) : a.procs;
        if (q && !filtered.length && !a.name.toLowerCase().includes(q.toLowerCase())) continue;
        const k = `app:${a.name}`;
        const isOpen = expanded.has(k) || (!!q && filtered.length > 0 && filtered.length < a.procs.length);
        rows.push({ key: k, data: a, agg: true, kids: true, expanded: isOpen, depth: 0 });
        if (isOpen) for (const r of table.sortRows(a.procs.map((p) => ({ data: p })))) rows.push({ key: `p:${r.data.pid}`, data: r.data, depth: 1, dim: q && !matches(r.data, q) });
      }
    } else {
      for (const r of table.sortRows(list.filter((p) => matches(p, q)).map((p) => ({ data: p })))) rows.push({ key: `p:${r.data.pid}`, data: r.data, depth: 0 });
    }
  };
  section("apps", "Apps", [...apps.entries()], true);
  section("bg", "Background processes", bg);
  section("sys", "System and other users", sys);
  if (store.settings.showKernel) section("kern", "Kernel threads", kern);
  // sections lose rows to the filter; drop the empty ones
  return rows.filter((r, i) => !r.group || (rows[i + 1] && !rows[i + 1].group) || !r.group.expanded);
}

/** btop tree: every process under its parent. */
export function treeRows(table, collapsed, procs) {
  const q = store.filter;
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  let keep = null;
  if (q) {
    keep = new Set();
    for (const p of procs) {
      if (!matches(p, q)) continue;
      let x = p;
      for (let i = 0; i < 64 && x && !keep.has(x.pid); i++) { keep.add(x.pid); x = byPid.get(x.ppid); }
    }
  }
  const rows = [];
  const walk = (p, depth) => {
    if (keep && !keep.has(p.pid)) return;
    const ch = (kids.get(p.pid) || []).filter((c) => !keep || keep.has(c.pid));
    const k = `p:${p.pid}`;
    const open = !collapsed.has(k);
    rows.push({ key: k, data: p, depth, kids: ch.length > 0, expanded: open, dim: !!q && !matches(p, q) });
    if (open) for (const r of table.sortRows(ch.map((c) => ({ data: c })))) walk(r.data, depth + 1);
  };
  const roots = procs.filter((p) => !byPid.has(p.ppid));
  for (const r of table.sortRows(roots.map((p) => ({ data: p })))) walk(r.data, 0);
  return rows;
}

export function flatRows(table, procs) {
  const q = store.filter;
  return table.sortRows(procs.filter((p) => matches(p, q)).map((p) => ({ data: p }))).map((r) => ({ key: `p:${r.data.pid}`, data: r.data }));
}

export function visibleProcs() {
  const ps = store.snap?.procs || [];
  return store.settings.showKernel ? ps : ps.filter((p) => p.kind !== "kernel");
}

export function emptyFilter() {
  return [h("h3", null, store.filter ? `Nothing matches “${store.filter}”` : "No processes yet"), h("p", null, store.filter ? "The filter checks names, commands, users, PIDs, services and containers." : "The first sample arrives within a second.")];
}

export { icon };
