// The btop screen: everything at once, the core strip on top.

import { store, ring, procRing, windowSamples, cpuOf } from "../store.js";
import { patch, h, icon } from "../ui.js";
import { trace, bars, niceMax } from "../chart.js";
import { Table } from "../table.js";
import { nameCell, treeRows, flatRows, visibleProcs, emptyFilter } from "../procview.js";
import { processMenu, endTask, processKey } from "../procactions.js";
import { openDrawer } from "../drawer.js";
import * as f from "../fmt.js";

export default function overviewPage() {
  let refs = {}, coreEls = [], table, tree = false, collapsed = new Set(), built = false;

  const cv = (label) => h("canvas", { role: "img", "aria-label": label });
  const tr = (label, cls = "") => { const c = cv(label); return [h("div", { class: `trace ${cls}` }, c), c]; };

  function buildCpu(snap) {
    const [cpuTrace, cpuCanvas] = tr("Processor use over time, the selected process in amber");
    refs.cpuCanvas = cpuCanvas;
    refs.cpuReading = h("div", { class: "reading" });
    refs.cpuFacts = h("dl", { class: "facts" });
    refs.cpuLegend = h("div", { class: "legend" });
    const info = store.cpuInfo || {};
    const pset = new Set(info.perf_cores || []), eset = new Set(info.eff_cores || []);
    const n = snap.cpu.cores.length;
    refs.coreCanvas = h("canvas", { role: "img", "aria-label": "Use of each logical processor now, with its recent peak; amber marks where the picked process last ran" });
    refs.coreNums = snap.cpu.cores.map(() => h("span", { class: "num" }));
    coreEls = snap.cpu.cores.map((_, i) => h("span", { class: `core-lbl${pset.has(i) ? " is-p" : ""}` }, `${i}${pset.has(i) ? "P" : eset.has(i) ? "E" : ""}`));
    refs.coreStrip = h("div", { class: "core-strip", style: { "--n": n } },
      h("div", { class: "trace core-bars" }, refs.coreCanvas),
      h("div", { class: "core-row" }, refs.coreNums),
      h("div", { class: "core-row" }, coreEls));
    refs.coreTitle = h("span", { class: "meta" });
    return h("section", { class: "panel ov-cpu", "aria-label": "Processor" },
      h("div", { class: "panel-head" }, h("h2", null, "Processor"), h("span", { class: "meta" }, info.model || "")),
      h("div", { style: { display: "flex", alignItems: "flex-end", gap: "var(--space-lg)", flexWrap: "wrap" } }, refs.cpuReading, refs.cpuLegend),
      cpuTrace,
      refs.cpuFacts,
      h("div", { class: "panel-head" }, h("h2", null, "Cores"), refs.coreTitle),
      refs.coreStrip);
  }

  function buildMem() {
    refs.memReading = h("div", { class: "reading reading--s" });
    refs.memBar = h("div", { class: "stackbar", role: "img", "aria-label": "Memory composition" });
    refs.memRows = h("div", { class: "mini-rows" });
    const [t, c] = tr("Memory in use over time", "trace--s");
    refs.memCanvas = c;
    return h("section", { class: "panel", "aria-label": "Memory" },
      h("div", { class: "panel-head" }, h("h2", null, "Memory"), refs.memMeta = h("span", { class: "meta" })),
      refs.memReading, t, refs.memBar, refs.memRows);
  }

  function buildSensors() {
    refs.sensorRows = h("div", { class: "mini-rows" });
    refs.batt = h("div");
    return h("section", { class: "panel", "aria-label": "Sensors and power" },
      h("div", { class: "panel-head" }, h("h2", null, "Sensors and power")),
      refs.batt, refs.sensorRows);
  }

  function buildNet() {
    const [t, c] = tr("Network download above the line, upload below", "trace--m");
    refs.netCanvas = c;
    refs.netLegend = h("div", { class: "legend" });
    refs.netFacts = h("dl", { class: "facts" });
    return h("section", { class: "panel", "aria-label": "Network" },
      h("div", { class: "panel-head" }, h("h2", null, "Network"), refs.netMeta = h("span", { class: "meta" })),
      refs.netLegend, t, refs.netFacts);
  }

  function buildDisk() {
    const [t, c] = tr("Disk reads above the line, writes below", "trace--m");
    refs.diskCanvas = c;
    refs.diskLegend = h("div", { class: "legend" });
    refs.mounts = h("div", { class: "mini-rows" });
    return h("section", { class: "panel", "aria-label": "Storage" },
      h("div", { class: "panel-head" }, h("h2", null, "Storage")),
      refs.diskLegend, t, refs.mounts);
  }

  function buildGpu() {
    const [t, c] = tr("Graphics processor use over time", "trace--m");
    refs.gpuCanvas = c;
    refs.gpuReading = h("div", { class: "legend" });
    refs.gpuRows = h("div", { class: "mini-rows" });
    return h("section", { class: "panel", "aria-label": "Graphics" },
      h("div", { class: "panel-head" }, h("h2", null, "Graphics"), refs.gpuMeta = h("span", { class: "meta" })),
      refs.gpuReading, t, refs.gpuRows);
  }

  function buildProcs() {
    table = new Table({
      label: "Processes by processor use",
      sort: { key: "cpu", dir: -1 },
      empty: emptyFilter,
      cols: [
        { key: "pid", label: "PID", width: "88px", num: true, render: (p) => String(p.pid), sortVal: (p) => p.pid },
        { key: "name", label: "Program", width: "minmax(180px, 1.4fr)", render: (p) => nameCell(p), sortVal: (p) => p.name.toLowerCase() },
        { key: "cmd", label: "Command", width: "minmax(200px, 3fr)", mono: true, render: (p) => h("span", { class: "t muted" }, p.cmd || `[${p.name}]`), titleOf: (p) => p.cmd },
        { key: "threads", label: "Threads", width: "76px", num: true, render: (p) => String(p.threads) },
        { key: "user", label: "User", width: "96px", render: (p) => p.user },
        { key: "mem", label: "Memory", width: "92px", num: true, render: (p) => f.bytes(p.mem), sortVal: (p) => p.mem, heat: (p) => (p.mem / (store.snap?.mem.total || 1)) * 5 },
        { key: "cpu", label: "CPU", width: "80px", num: true, render: (p) => f.pct(cpuOf(p), 1), sortVal: (p) => p.cpu, heat: (p) => p.cpu / 60 },
      ],
      onSelect: (r) => { store.selected = r.data.pid; },
      onActivate: (r) => openDrawer(r.data.pid),
      onContext: (r, x, y) => processMenu(r.data, x, y, table.el),
      onToggle: (r) => { collapsed.has(r.key) ? collapsed.delete(r.key) : collapsed.add(r.key); procRows(); },
      onDelete: (r, kill) => endTask(r.data, kill),
    });
    table.onSort = procRows;
    table.el.addEventListener("keydown", (e) => {
      const r = table.rows.find((x) => x.key === table.sel);
      if (r && e.target === table.el && processKey(e, r.data)) e.preventDefault();
      if (e.key === "t" && e.target === table.el) { tree = !tree; treeBtn.setAttribute("aria-pressed", String(tree)); procRows(); }
    });
    const treeBtn = h("button", { type: "button", class: "btn btn--quiet", "aria-pressed": "false", onclick: () => { tree = !tree; treeBtn.setAttribute("aria-pressed", String(tree)); procRows(); } }, icon("tree"), "Tree");
    refs.procMeta = h("span", { class: "meta" });
    return h("section", { class: "panel ov-procs", style: { padding: "0" }, "aria-label": "Processes" },
      h("div", { class: "panel-head", style: { padding: "var(--space-sm) var(--space-md) 0" } }, h("h2", null, "Processes"), treeBtn, refs.procMeta),
      h("div", { class: "tbl-wrap", style: { minHeight: "300px" } }, table.el));
  }

  function procRows() {
    const procs = visibleProcs();
    table.setRows(tree ? treeRows(table, collapsed, procs) : flatRows(table, procs));
    refs.procMeta.textContent = `${procs.length} processes, load ${store.snap.cpu.load.map((l) => l.toFixed(2)).join(" ")}`;
  }

  function build(root) {
    const snap = store.snap;
    root.replaceChildren(
      h("div", { class: "panels ov" },
        buildCpu(snap),
        buildMem(),
        buildSensors(),
        buildProcs(),
        h("div", { class: "ov-row2" }, buildNet(), buildDisk(), buildGpu())));
    built = true;
  }

  function memRow(label, value, frac, hot) {
    return h("div", { class: "mini-row" }, h("span", { class: "lbl" }, label), h("div", { class: `meter${hot ? " is-hot" : ""}` }, h("i", { style: { "--v": Math.min(1, Math.max(0, frac)).toFixed(3) } })), h("span", { class: "num" }, value));
  }

  function update() {
    const s = store.snap;
    if (!s) return;
    if (!built) build(refs.root);
    const n = windowSamples();
    const c = s.cpu;

    // processor
    patch(refs.cpuReading, f.pct(c.total), h("small", null, "in use"));
    patch(refs.cpuLegend, 
      h("span", null, h("i", { class: "swatch" }), "User ", h("b", null, f.pct(c.user))),
      h("span", null, h("i", { class: "swatch swatch--2" }), "System ", h("b", null, f.pct(c.system + c.irq))),
      h("span", null, "Waiting on IO ", h("b", null, f.pct(c.iowait, 1))),
      store.selected && store.procIndex.get(store.selected) ? h("span", null, h("i", { class: "swatch swatch--amber" }), store.procIndex.get(store.selected).name, " ", h("b", null, f.pct(store.procIndex.get(store.selected).cpu, 1))) : null,
    );
    const series = [
      { data: ring("cpu").last(n), colour: "cool" },
      { data: ring("cpu.sys").last(n), colour: "cool", fill: false, width: 1, alpha: 0.5 },
    ];
    const sel = store.selected != null && store.procIndex.has(store.selected) ? procRing(store.selected).cpu.last(n) : null;
    if (sel) series.push({ data: sel, colour: "accent", fill: false, width: 2 });
    trace(refs.cpuCanvas, series, { samples: n, max: 100 });
    patch(refs.cpuFacts, 
      ...[
        ["Speed", f.mhz(c.avg_freq_mhz)],
        ["Temperature", f.temp(c.temp_c) || "Not reported"],
        ["Load average", c.load.map((l) => l.toFixed(2)).join("  ")],
        ["Up for", f.duration(c.uptime_s)],
        ["Processes", f.int(c.procs)],
        ["Threads", f.int(c.threads)],
        ["Running now", f.int(c.running)],
        ["Context switches", `${f.int(c.ctxt_per_s)}/s`],
      ].map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, v))),
    );
    const peakN = 10;
    const picked = store.selected != null ? store.procIndex.get(store.selected) : null;
    bars(refs.coreCanvas, c.cores, { max: 100, gap: 4, peaks: c.cores.map((_, i) => ring(`core.${i}`).max(peakN)), mark: picked ? picked.last_cpu : null });
    refs.coreNums.forEach((el, i) => (el.textContent = f.pct(c.cores[i] ?? 0)));
    patch(refs.coreTitle, ...(c.core_temps.length ? ["Core temperatures ", h("span", { class: "num" }, `${c.core_temps.map((t) => Math.round(t)).join(" ")} °C`)] : [`${c.cores.length} logical processors`]));

    // memory
    const m = s.mem;
    patch(refs.memReading, f.bytes(m.in_use), h("small", null, `of ${f.bytes(m.total)}`));
    refs.memMeta.textContent = `${f.pct((m.in_use / m.total) * 100)} in use`;
    trace(refs.memCanvas, [{ data: ring("mem").last(n), colour: "cool" }, { data: ring("swap").last(n), colour: "muted", fill: false, width: 1 }], { samples: n, max: 100, grid: 1 });
    patch(refs.memBar, 
      h("i", { class: "s1", style: { "--v": m.in_use }, title: `In use ${f.bytes(m.in_use)}` }),
      h("i", { class: "s2", style: { "--v": m.modified }, title: `Modified ${f.bytes(m.modified)}` }),
      h("i", { class: "s3", style: { "--v": m.standby }, title: `Cached ${f.bytes(m.standby)}` }),
      h("i", { class: "s4", style: { "--v": m.free }, title: `Free ${f.bytes(m.free)}` }),
    );
    patch(refs.memRows, 
      memRow("In use", f.bytes(m.in_use), m.in_use / m.total, m.in_use / m.total > 0.9),
      memRow("Cached", f.bytes(m.standby + m.modified), (m.standby + m.modified) / m.total),
      memRow("Available", f.bytes(m.available), m.available / m.total),
      memRow("Free", f.bytes(m.free), m.free / m.total),
      m.swap_total ? memRow("Swap", f.bytes(m.swap_used), m.swap_used / m.swap_total, m.swap_used / m.swap_total > 0.8) : null,
      memRow("Committed", f.bytes(m.committed), m.committed / Math.max(m.commit_limit, m.committed)),
    );

    // sensors
    const b = s.battery;
    patch(refs.batt, 
      b ? h("div", { style: { display: "grid", gap: "var(--space-2xs)" } },
        h("div", { class: "reading reading--s" }, f.pct(b.pct), h("small", null, b.status === "Discharging" && b.secs_left ? `${f.duration(b.secs_left).slice(0, 5)} left` : b.status === "Charging" && b.secs_left ? `charging, full in ${f.duration(b.secs_left).slice(0, 5)}` : b.status.toLowerCase())),
        h("div", { class: "legend" }, b.power_w ? h("span", null, "Drawing ", h("b", null, `${b.power_w.toFixed(1)}\u00a0W`)) : null, b.health_pct ? h("span", null, "Health ", h("b", null, f.pct(b.health_pct))) : null, b.cycles ? h("span", null, "Cycles ", h("b", null, String(b.cycles))) : null))
        : h("p", { class: "muted" }, "No battery. Running on mains power."),
    );
    const temps = pickTemps(s.temps);
    patch(refs.sensorRows, 
      ...temps.map((t) => memRow(t.name, f.temp(t.c), t.c / (t.crit || 100), t.c >= (t.high || t.crit || 95) - 2)),
      ...s.fans.filter((x) => x.rpm > 0).map((x) => h("div", { class: "mini-row" }, h("span", { class: "lbl" }, x.label), h("span"), h("span", { class: "num" }, `${x.rpm} rpm`))),
      s.psi ? h("div", { class: "mini-row", title: "Share of the last 10 seconds that some task waited on this resource (pressure stall information)" }, h("span", { class: "lbl" }, "Stalled on"), h("span", { class: "wide" }, "Processor ", h("span", { class: "num" }, f.pct(s.psi.cpu_some, 1)), "  Memory ", h("span", { class: "num" }, f.pct(s.psi.mem_some, 1)), "  Disk ", h("span", { class: "num" }, f.pct(s.psi.io_some, 1)))) : null,
    );

    // network
    const rx = ring("net.rx"), tx = ring("net.tx");
    const nmax = niceMax(Math.max(rx.max(n), tx.max(n)));
    trace(refs.netCanvas, [{ data: rx.last(n), colour: "cool" }, { data: tx.last(n), colour: "cool", mirror: true, alpha: 0.6 }], { samples: n, max: nmax, mirror: true, grid: 0 });
    patch(refs.netLegend, h("span", null, "Down ", h("b", null, f.rate(rx.latest))), h("span", null, "Up ", h("b", null, f.rate(tx.latest))), h("span", null, "Scale ", h("b", null, f.rate(nmax))));
    const phys = s.net.filter((x) => !x.virtual_if && x.name !== "lo");
    const main = phys.slice().sort((a, b2) => b2.rx_total - a.rx_total)[0];
    refs.netMeta.textContent = main ? main.name : "";
    patch(refs.netFacts, ...(main ? [["Received", f.bytes(main.rx_total)], ["Sent", f.bytes(main.tx_total)]] : []).map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, v))));

    // storage
    const dr = ring("disk.r"), dw = ring("disk.w");
    const dmax = niceMax(Math.max(dr.max(n), dw.max(n)));
    trace(refs.diskCanvas, [{ data: dr.last(n), colour: "cool" }, { data: dw.last(n), colour: "cool", mirror: true, alpha: 0.6 }], { samples: n, max: dmax, mirror: true, grid: 0 });
    patch(refs.diskLegend, h("span", null, "Read ", h("b", null, f.rate(dr.latest))), h("span", null, "Write ", h("b", null, f.rate(dw.latest))), h("span", null, "Busy ", h("b", null, f.pct(Math.max(0, ...s.disks.map((d) => d.active_pct))))));
    patch(refs.mounts, ...s.mounts.map((mt) => memRow(mt.mount, `${f.bytes(mt.avail)} free`, mt.used / mt.total, mt.used / mt.total > 0.92)));

    // graphics
    const g = s.gpus[0];
    if (g) {
      refs.gpuMeta.textContent = g.name;
      trace(refs.gpuCanvas, [{ data: ring("gpu.0").last(n), colour: "cool" }], { samples: n, max: 100, grid: 1 });
      patch(refs.gpuReading, h("span", null, "Busy ", h("b", null, g.busy_pct != null ? f.pct(g.busy_pct) : "Not reported")), g.freq_mhz ? h("span", null, "Clock ", h("b", null, f.mhz(g.freq_mhz))) : h("span", null, "Clock ", h("b", null, "idle")), g.temp_c ? h("span", null, h("b", null, f.temp(g.temp_c))) : null);
      patch(refs.gpuRows, ...g.engines.map(([e, v]) => memRow(e, f.pct(v), v / 100)), g.vram_total ? memRow("Video memory", f.bytes(g.vram_used), g.vram_used / g.vram_total) : null);
    } else {
      patch(refs.gpuReading, h("span", null, "No graphics device reported by the kernel."));
    }

    procRows();
  }

  return {
    id: "overview",
    title: "Overview",
    mount(root) {
      refs.root = root;
      built = false;
      if (!store.snap) root.append(h("div", { class: "skeleton", "aria-label": "Waiting for the first sample" }, Array.from({ length: 8 }, () => h("i"))));
      update();
    },
    update,
    settings() { built = false; update(); },
    filter() { if (built) procRows(); },
    focusTable() { table?.el.focus(); },
    unmount() { table?.destroy(); },
  };
}

export function pickTemps(temps) {
  const out = [];
  const add = (chip, pre, name) => {
    const t = temps.find((x) => x.chip === chip && x.label.startsWith(pre));
    if (t) out.push({ ...t, name });
  };
  add("coretemp", "Package", "Processor");
  add("k10temp", "Tctl", "Processor");
  add("zenpower", "Tdie", "Processor");
  add("nvme", "Composite", "NVMe drive");
  add("amdgpu", "edge", "Graphics");
  add("iwlwifi_1", "", "Wi-Fi");
  add("acpitz", "", "Motherboard");
  add("pch_", "", "Chipset");
  if (!out.length) for (const t of temps.slice(0, 5)) out.push({ ...t, name: `${t.chip} ${t.label}` });
  return out;
}
