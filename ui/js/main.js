import { invoke, listen, isTauri, errText } from "./api.js";
import { store, ingest, on, saveSettings, ring, windowSamples } from "./store.js";
import { h, icon, logo, dialog, toast, anyDialogOpen, closeMenu } from "./ui.js";
import { readPalette, trace, niceMax } from "./chart.js";
import { hooks, act } from "./procactions.js";
import { openDrawer, closeDrawer, isOpen as drawerOpen, update as drawerUpdate } from "./drawer.js";
import { matches } from "./procview.js";
import * as f from "./fmt.js";

import overviewPage from "./pages/overview.js";
import processesPage from "./pages/processes.js";
import performancePage from "./pages/performance.js";
import appHistoryPage from "./pages/apphistory.js";
import startupPage from "./pages/startup.js";
import usersPage from "./pages/users.js";
import detailsPage from "./pages/details.js";
import servicesPage from "./pages/services.js";
import connectionsPage from "./pages/connections.js";
import systemPage from "./pages/system.js";
import settingsPage from "./pages/settings.js";

const PAGES = [
  ["overview", "Overview", "overview", overviewPage],
  ["processes", "Processes", "processes", processesPage],
  ["performance", "Performance", "performance", performancePage],
  ["history", "App history", "history", appHistoryPage],
  ["startup", "Startup apps", "startup", startupPage],
  ["users", "Users", "users", usersPage],
  ["details", "Details", "details", detailsPage],
  ["services", "Services", "services", servicesPage],
  ["connections", "Connections", "connections", connectionsPage],
  ["system", "System", "system", systemPage],
  ["settings", "Settings", "settings", settingsPage],
];

const $ = (s) => document.querySelector(s);
let page = null;
let pageEl, titleEl, filterEl, pauseBtn, meters = {};

// ---------- colourway ----------
function applyColourway() {
  document.documentElement.dataset.colourway = store.settings.colourway;
  readPalette();
}
hooks.applyColourway = applyColourway;

// ---------- routing; the page, its filter and its params live in the hash ----------
function parseHash() {
  const raw = location.hash.slice(1) || "overview";
  const [id, qs] = raw.split("?");
  const params = Object.fromEntries(new URLSearchParams(qs || ""));
  return { id: PAGES.some((p) => p[0] === id) ? id : "overview", params };
}

function writeHash() {
  if (!page) return;
  const q = store.filter ? `?q=${encodeURIComponent(store.filter)}` : "";
  history.replaceState(null, "", `#${page.id}${q}`);
}

export function go(id, params = {}) {
  const q = params.filter != null ? `?q=${encodeURIComponent(params.filter)}` : store.filter ? `?q=${encodeURIComponent(store.filter)}` : "";
  pendingParams = params;
  location.hash = `#${id}${q}`;
}
hooks.go = go;
let pendingParams = null;

function route() {
  const { id, params } = parseHash();
  if (params.q != null) store.filter = params.q;
  filterEl.value = store.filter;
  page?.unmount?.();
  closeMenu();
  const def = PAGES.find((p) => p[0] === id);
  page = def[3]();
  page.params = { ...params, ...(pendingParams || {}) };
  pendingParams = null;
  titleEl.textContent = def[1];
  document.title = `${def[1]}, Forge`;
  pageEl.className = `page${page.flush ? " is-flush" : ""}`;
  pageEl.replaceChildren();
  pageEl.scrollTop = 0;
  document.querySelectorAll(".nav-link").forEach((a) => a.setAttribute("aria-current", a.dataset.page === id ? "page" : "false"));
  page.mount(pageEl);
}

// ---------- sidebar meters ----------
function buildMeters() {
  const foot = $(".side-foot");
  const mk = (k, label) => {
    const i = h("i");
    const num = h("span", { class: "num" });
    const m = h("div", { class: "meter" }, i);
    foot.append(h("div", { class: "side-meter" }, h("span", null, label), m, num));
    meters[k] = { i, num, m };
  };
  mk("cpu", "CPU");
  mk("mem", "Memory");
  mk("disk", "Disk");
  mk("gpu", "GPU");
  meters.net = h("div", { class: "side-meter" }, h("span", null, "Net"), h("span"), h("span", { class: "num" }));
  foot.append(meters.net);
}

function updateMeters() {
  const s = store.snap;
  const set = (k, v, text) => {
    meters[k].i.style.setProperty("--v", Math.min(1, v / 100).toFixed(3));
    meters[k].m.classList.toggle("is-hot", v > 90);
    meters[k].num.textContent = text;
  };
  set("cpu", s.cpu.total, f.pct(s.cpu.total));
  set("mem", (s.mem.in_use / s.mem.total) * 100, f.pct((s.mem.in_use / s.mem.total) * 100));
  const busy = Math.max(0, ...s.disks.map((d) => d.active_pct));
  set("disk", busy, f.pct(busy));
  const g = s.gpus[0]?.busy_pct;
  set("gpu", g ?? 0, g != null ? f.pct(g) : "");
  meters.net.lastChild.textContent = f.bits(ring("net.rx").latest + ring("net.tx").latest);
}

// ---------- alerts ----------
const lastAlert = {};
let hotSince = null;
function alert(kind, title, body) {
  const now = Date.now();
  if (lastAlert[kind] && now - lastAlert[kind] < 5 * 60 * 1000) return;
  lastAlert[kind] = now;
  invoke("notify", { title, body }).catch(() => toast(`${title}. ${body}`, { bad: true }));
}
function checkAlerts() {
  const a = store.settings.alerts;
  const s = store.snap;
  if (!a.enabled || !s) return;
  if (s.cpu.total >= a.cpu) {
    hotSince ??= Date.now();
    if (Date.now() - hotSince >= a.cpuSecs * 1000) {
      const top = s.procs.slice().sort((x, y) => y.cpu - x.cpu)[0];
      alert("cpu", `Processor at ${Math.round(s.cpu.total)}%`, `Busiest: ${top?.name} (${top?.pid}) at ${f.pct(top?.cpu, 1)}.`);
    }
  } else hotSince = null;
  const mp = (s.mem.in_use / s.mem.total) * 100;
  if (mp >= a.mem) {
    const top = s.procs.slice().sort((x, y) => (y.mem_private || y.mem) - (x.mem_private || x.mem))[0];
    alert("mem", `Memory at ${Math.round(mp)}%`, `Largest: ${top?.name} with ${f.bytes(top?.mem_private || top?.mem)}.`);
  }
  if (s.cpu.temp_c != null && s.cpu.temp_c >= a.temp) alert("temp", `Processor at ${Math.round(s.cpu.temp_c)} °C`, "Check what is busy and how the machine is cooled.");
  if (s.battery && s.battery.status === "Discharging" && s.battery.pct <= a.battery) alert("bat", `Battery at ${Math.round(s.battery.pct)}%`, "Plug in soon.");
}

// ---------- summary (compact) view ----------
let compactEl = null;
function compact(onOff) {
  document.documentElement.classList.toggle("compact", onOff);
  invoke("set_compact", { on: onOff }).catch(() => {});
  if (onOff) {
    const rows = [["cpu", "Processor"], ["mem", "Memory"], ["disk", "Disk"], ["net", "Network"], ["gpu", "GPU"]];
    compactEl = h("div", { class: "compact-view", ondblclick: () => compact(false) },
      rows.map(([k, l]) => {
        const c = h("canvas", { role: "img", "aria-label": `${l} over time` });
        const v = h("span");
        const r = h("div", { class: "compact-row" }, h("div", { class: "lbl" }, h("b", null, l), v), h("div", { class: "trace" }, c));
        r._c = c; r._v = v; r._k = k;
        return r;
      }),
      h("button", { type: "button", class: "btn btn--quiet btn--icon compact-exit", "aria-label": "Leave summary view", onclick: () => compact(false) }, icon("window")));
    pageEl.replaceChildren(compactEl);
    updateCompact();
  } else {
    compactEl = null;
    route();
  }
}
hooks.compact = compact;
function updateCompact() {
  const s = store.snap;
  if (!compactEl || !s) return;
  const n = windowSamples();
  for (const r of compactEl.querySelectorAll(".compact-row")) {
    if (r._k === "cpu") { trace(r._c, [{ data: ring("cpu").last(n), colour: "cool" }], { samples: n, max: 100, grid: 1 }); r._v.textContent = f.pct(s.cpu.total); }
    if (r._k === "mem") { trace(r._c, [{ data: ring("mem").last(n), colour: "cool" }], { samples: n, max: 100, grid: 1 }); r._v.textContent = f.bytes(s.mem.in_use); }
    if (r._k === "disk") { const d = ring("disk.r"), w = ring("disk.w"); const mx = niceMax(Math.max(d.max(n), w.max(n))); trace(r._c, [{ data: d.last(n), colour: "cool" }, { data: w.last(n), colour: "cool", mirror: true, alpha: 0.6 }], { samples: n, max: mx, mirror: true, grid: 0 }); r._v.textContent = f.rate(d.latest + w.latest); }
    if (r._k === "net") { const d = ring("net.rx"), w = ring("net.tx"); const mx = niceMax(Math.max(d.max(n), w.max(n))); trace(r._c, [{ data: d.last(n), colour: "cool" }, { data: w.last(n), colour: "cool", mirror: true, alpha: 0.6 }], { samples: n, max: mx, mirror: true, grid: 0 }); r._v.textContent = f.bits(d.latest + w.latest); }
    if (r._k === "gpu") { trace(r._c, [{ data: ring("gpu.0").last(n), colour: "cool" }], { samples: n, max: 100, grid: 1 }); r._v.textContent = s.gpus[0]?.busy_pct != null ? f.pct(s.gpus[0].busy_pct) : ""; }
  }
}

// ---------- run new task ----------
function runTask() {
  const input = h("input", { class: "input", id: "run-cmd", name: "command", autocomplete: "off", spellcheck: "false", placeholder: "firefox, or htop in a terminal: x-terminal-emulator -e htop" });
  const elev = h("input", { type: "checkbox", id: "run-elev" });
  const errEl = h("span", { class: "err", role: "alert" });
  const go = async () => {
    try {
      await invoke("run_task", { command: input.value, elevated: elev.checked });
    } catch (e) {
      errEl.textContent = errText(e);
      input.focus();
      return false;
    }
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go().then((r) => r !== false && d.close()); } });
  const d = dialog({
    title: "Run new task",
    text: "Type a program or a shell command. It starts on its own, in your home folder.",
    body: [h("div", { class: "field" }, h("label", { for: "run-cmd" }, "Command"), input, errEl), h("label", { class: "check", for: "run-elev" }, elev, h("span", null, "Run with administrator rights"))],
    actions: [{ label: "Cancel" }, { label: "Run", primary: true, run: () => { go().then((r) => r !== false && d.close()); return false; } }],
  });
}

// ---------- shortcuts ----------
const KEYS = [
  ["Ctrl K", "Command palette"], ["/", "Filter"], ["Esc", "Clear filter, close panel"], ["1 to 0", "Go to a page"],
  ["j k or arrows", "Move in a list"], ["Enter", "Open details"], ["Del", "End task"], ["Shift Del", "Kill"],
  ["z", "Suspend or resume"], ["e", "Efficiency mode"], ["n", "Priority"], ["a", "Affinity"], ["s", "Send a signal"],
  ["t", "Tree view on Overview"], ["p", "Pause or resume updates"], ["+ and -", "Update faster or slower"],
  ["Ctrl N", "Run new task"], ["m", "Summary view"], ["?", "These shortcuts"],
];
function shortcuts() {
  dialog({ title: "Keyboard shortcuts", body: h("div", { class: "sheet" }, KEYS.map(([k, l]) => h("div", null, h("span", null, l), h("span", { class: "kbd" }, k)))), wide: true, actions: [{ label: "Close", primary: true }] });
}
hooks.shortcuts = shortcuts;

// ---------- palette ----------
function palette() {
  const input = h("input", { class: "input", placeholder: "Go to a page, run an action, or find a process", "aria-label": "Command", autocomplete: "off", spellcheck: "false" });
  const list = h("ul", { role: "listbox", "aria-label": "Results" });
  let sel = 0, items = [];
  const actions = () => [
    ...PAGES.map(([id, l, ic], i) => ({ label: `Go to ${l}`, icon: ic, key: i < 10 ? String((i + 1) % 10) : "", run: () => go(id) })),
    { label: store.paused ? "Resume updates" : "Pause updates", icon: store.paused ? "play" : "pause", key: "p", run: togglePause },
    { label: "Run new task", icon: "plus", key: "Ctrl N", run: runTask },
    { label: "Summary view", icon: "window", key: "m", run: () => compact(true) },
    { label: store.settings.onTop ? "Stop staying on top" : "Stay on top of other windows", icon: "pin", run: () => { saveSettings({ onTop: !store.settings.onTop }); invoke("set_always_on_top", { on: store.settings.onTop }); } },
    ...["graphite", "paper", "amber-room"].map((c) => ({ label: `Colourway: ${c.replace("-", " ")}`, icon: "settings", run: () => { saveSettings({ colourway: c }); applyColourway(); route(); } })),
    { label: store.settings.cpuMode === "core" ? "Read CPU as share of the whole machine" : "Read CPU as share of one core", icon: "performance", run: () => saveSettings({ cpuMode: store.settings.cpuMode === "core" ? "machine" : "core" }) },
    { label: store.settings.showKernel ? "Hide kernel threads" : "Show kernel threads", icon: "processes", run: () => saveSettings({ showKernel: !store.settings.showKernel }) },
    { label: "Export the sample as JSON", icon: "download", run: () => invoke("export_snapshot", { format: "json" }).then((p) => toast(`Saved ${p}`), (e) => toast(errText(e), { bad: true })) },
    { label: "Export processes as CSV", icon: "download", run: () => invoke("export_snapshot", { format: "csv" }).then((p) => toast(`Saved ${p}`), (e) => toast(errText(e), { bad: true })) },
    { label: "Keyboard shortcuts", icon: "keyboard", key: "?", run: shortcuts },
  ];
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const acts = actions().filter((a) => !q || a.label.toLowerCase().includes(q));
    const procs = q && store.snap ? store.snap.procs.filter((p) => matches(p, q)).sort((a, b) => b.cpu - a.cpu).slice(0, 8).map((p) => ({ label: `${p.name}  ${p.pid}`, sub: f.pct(p.cpu, 1), icon: "info", run: () => openDrawer(p.pid) })) : [];
    items = [...acts.slice(0, q ? 8 : 30), ...procs];
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((it, i) => h("li", { role: "option", "aria-selected": String(i === sel), onclick: () => { d.close(); it.run(); }, onpointermove: () => { if (sel !== i) { sel = i; mark(); } } }, icon(it.icon), h("span", null, it.label), h("span", { class: "k" }, it.key || it.sub || ""))));
    if (!items.length) list.replaceChildren(h("li", { "aria-disabled": "true" }, h("span", { class: "muted" }, "Nothing matches.")));
  };
  const mark = () => [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === sel)));
  input.addEventListener("input", () => { sel = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); mark(); list.children[sel]?.scrollIntoView({ block: "nearest" }); }
    if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + items.length) % Math.max(1, items.length); mark(); list.children[sel]?.scrollIntoView({ block: "nearest" }); }
    if (e.key === "Enter" && items[sel]) { e.preventDefault(); const it = items[sel]; d.close(); it.run(); }
  });
  const d = dialog({ cls: "palette", title: "Command palette", body: [input, list] });
  d.el.querySelector(".dialog-head")?.classList.add("visually-hidden");
  render();
  setTimeout(() => input.focus(), 30);
}

// ---------- pause and speed ----------
function togglePause() {
  store.paused = !store.paused;
  invoke("set_paused", { paused: store.paused });
  pauseBtn.setAttribute("aria-pressed", String(store.paused));
  pauseBtn.setAttribute("aria-label", store.paused ? "Resume updates" : "Pause updates");
  pauseBtn.replaceChildren(icon(store.paused ? "play" : "pause"));
  $("#paused-flag").hidden = !store.paused;
}
function nudgeInterval(dir) {
  const steps = [250, 500, 1000, 2000, 3000, 5000, 10000];
  const i = steps.indexOf(store.settings.interval);
  const next = steps[Math.max(0, Math.min(steps.length - 1, (i < 0 ? 2 : i) + dir))];
  saveSettings({ interval: next });
  invoke("set_interval", { ms: next });
  toast(`Updating every ${next >= 1000 ? `${next / 1000} s` : `${next} ms`}.`, { ms: 1800 });
}

// ---------- keyboard ----------
const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
function onKey(e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K" || (e.shiftKey && (e.key === "p" || e.key === "P")))) { e.preventDefault(); if (!anyDialogOpen()) palette(); return; }
  if (anyDialogOpen()) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) { e.preventDefault(); filterEl.focus(); filterEl.select(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === "n" || e.key === "N")) { e.preventDefault(); runTask(); return; }
  if (e.key === "Escape") {
    if (document.documentElement.classList.contains("compact")) { compact(false); return; }
    if (e.target === filterEl) { if (filterEl.value) { filterEl.value = ""; setFilter(""); } else page?.focusTable?.(); return; }
    if (drawerOpen()) { closeDrawer(); return; }
    return;
  }
  if (typing(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
  if (page?.keys?.(e)) { e.preventDefault(); return; }
  if (e.key === "/") { e.preventDefault(); filterEl.focus(); filterEl.select(); return; }
  if (e.key === "?") { shortcuts(); return; }
  if (e.key === "p") { togglePause(); return; }
  if (e.key === "+" || e.key === "=") { nudgeInterval(-1); return; }
  if (e.key === "-") { nudgeInterval(1); return; }
  if (e.key === "m") { compact(!document.documentElement.classList.contains("compact")); return; }
  if (/^[0-9]$/.test(e.key) && !e.target.closest?.(".vt")) {
    const i = e.key === "0" ? 9 : +e.key - 1;
    if (PAGES[i]) go(PAGES[i][0]);
  }
}

function setFilter(v) {
  store.filter = v;
  writeHash();
  page?.filter?.();
}

// ---------- start ----------
async function start() {
  applyColourway();
  pageEl = $("#page");
  titleEl = $("#page-title");
  document.querySelectorAll(".nav-link").forEach((a) => a.prepend(icon(a.dataset.icon)));
  $(".wordmark").prepend(logo());
  filterEl = $("#filter");
  pauseBtn = $("#pause");
  $(".search").prepend(icon("search"));
  pauseBtn.append(icon("pause"));
  $("#palette-btn").prepend(icon("command"));
  $("#run-btn").prepend(icon("plus"));
  filterEl.addEventListener("input", () => setFilter(filterEl.value));
  filterEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); page?.focusTable?.(); } });
  pauseBtn.addEventListener("click", togglePause);
  $("#palette-btn").addEventListener("click", palette);
  $("#run-btn").addEventListener("click", runTask);
  buildMeters();
  document.addEventListener("keydown", onKey);
  window.addEventListener("hashchange", route);
  hooks.openDetails = openDrawer;

  on((kind) => {
    if (kind === "tick") {
      updateMeters();
      checkAlerts();
      if (document.hidden) return;
      if (compactEl) { updateCompact(); return; }
      try { page?.update?.(); } catch (err) { console.error(err); }
      drawerUpdate();
    } else if (kind === "settings") {
      page?.settings?.();
    }
  });

  invoke("cpu_info").then((c) => { store.cpuInfo = c; }).catch(() => {});
  try {
    const s = await invoke("get_snapshot");
    if (s) ingest(s);
  } catch {}
  await listen("snapshot", (s) => ingest(s));
  invoke("set_interval", { ms: store.settings.interval }).catch(() => {});
  if (store.settings.onTop) invoke("set_always_on_top", { on: true }).catch(() => {});
  route();
  if (!isTauri) document.documentElement.dataset.preview = "true";
}

// errors reach the terminal Forge was started from
const report = (m) => { if (isTauri) invoke("log_js", { msg: String(m) }).catch(() => {}); };
window.addEventListener("error", (e) => report(`${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => report(`unhandled: ${e.reason?.stack || e.reason}`));

// FORGE_SELFTEST=1 walks every page on live data, then exits with the error count
async function selftest() {
  if (!isTauri || !(await invoke("selftest"))) return;
  let errors = 0;
  const orig = console.error;
  console.error = (...a) => { errors++; report(a.join(" ")); orig(...a); };
  window.addEventListener("error", () => errors++);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(2500);
  for (const [id] of PAGES) {
    go(id);
    await wait(2200);
    report(`page ${id}: ${document.querySelectorAll(".vt-row").length} rows, ${pageEl.textContent.length} chars`);
  }
  const top = store.snap.procs.slice().sort((a, b) => b.cpu - a.cpu)[0];
  openDrawer(top.pid);
  await wait(2000);
  for (const t of document.querySelectorAll(".drawer .tab")) { t.click(); await wait(400); }
  report(`drawer for ${top.name}: ${document.querySelector(".drawer").textContent.length} chars`);
  closeDrawer();
  compact(true); await wait(1500); compact(false); await wait(800);
  report(`selftest finished, ${errors} errors`);
  invoke("quit", { code: errors ? 1 : 0 });
}

start().then(selftest).catch((e) => {
  const p = document.getElementById("page");
  if (p) p.replaceChildren(h("div", { class: "state state--error" }, h("h3", null, "Forge could not start"), h("p", null, String(e))));
});

export { act };
