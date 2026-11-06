import { store, saveSettings, cpuOf } from "../store.js";
import { h, icon, dialog } from "../ui.js";
import { Table } from "../table.js";
import { nameCell, flatRows, visibleProcs, emptyFilter, statusCell } from "../procview.js";
import { processMenu, endTask, processKey } from "../procactions.js";
import { openDrawer } from "../drawer.js";
import * as f from "../fmt.js";

const ALL = [
  { key: "name", label: "Name", width: "minmax(200px, 1.6fr)", render: (p) => nameCell(p), sortVal: (p) => p.name.toLowerCase(), fixed: true },
  { key: "pid", label: "PID", width: "78px", num: true, render: (p) => String(p.pid) },
  { key: "ppid", label: "Parent", width: "78px", num: true, render: (p) => String(p.ppid) },
  { key: "state", label: "Status", width: "130px", render: (p) => f.STATE[p.state] || p.state },
  { key: "flags", label: "Flags", width: "130px", render: (p) => statusCell(p), sortVal: (p) => p.container || "" },
  { key: "user", label: "User", width: "100px", render: (p) => p.user },
  { key: "cpu", label: "CPU", width: "76px", num: true, render: (p) => f.pct(cpuOf(p), 1), heat: (p) => p.cpu / 60 },
  { key: "cpu_time_s", label: "CPU time", width: "110px", num: true, render: (p) => f.cpuTime(p.cpu_time_s) },
  { key: "mem_private", label: "Private memory", width: "120px", num: true, render: (p) => f.bytes(p.mem_private), heat: (p) => p.mem_private / (store.snap?.mem.total || 1) * 5 },
  { key: "mem", label: "Resident", width: "100px", num: true, render: (p) => f.bytes(p.mem) },
  { key: "swap", label: "Swapped", width: "96px", num: true, render: (p) => (p.swap ? f.bytes(p.swap) : "") },
  { key: "threads", label: "Threads", width: "80px", num: true, render: (p) => String(p.threads) },
  { key: "prio", label: "Priority", width: "120px", render: (p) => f.priorityName(p.nice, p.policy), sortVal: (p) => (p.policy === 5 ? 40 : p.nice) },
  { key: "nice", label: "Nice", width: "64px", num: true, render: (p) => String(p.nice) },
  { key: "last_cpu", label: "Last core", width: "84px", num: true, render: (p) => String(p.last_cpu) },
  { key: "read_bps", label: "Disk read", width: "100px", num: true, render: (p) => f.rate(p.read_bps) },
  { key: "write_bps", label: "Disk write", width: "100px", num: true, render: (p) => f.rate(p.write_bps) },
  { key: "read_total", label: "Read in all", width: "104px", num: true, render: (p) => f.bytes(p.read_total) },
  { key: "write_total", label: "Written in all", width: "112px", num: true, render: (p) => f.bytes(p.write_total) },
  { key: "gpu", label: "GPU", width: "70px", num: true, render: (p) => (p.gpu != null ? f.pct(p.gpu, 1) : ""), sortVal: (p) => p.gpu ?? -1 },
  { key: "gpu_mem", label: "GPU memory", width: "110px", num: true, render: (p) => (p.gpu_mem ? f.bytes(p.gpu_mem) : ""), sortVal: (p) => p.gpu_mem ?? -1 },
  { key: "start_s", label: "Started", width: "120px", num: true, render: (p) => f.since(p.start_s) },
  { key: "kind", label: "Kind", width: "110px", render: (p) => ({ app: "App", background: "Background", system: "System", kernel: "Kernel" }[p.kind]) },
  { key: "app", label: "App", width: "150px", render: (p) => p.app || "" },
  { key: "unit", label: "Unit", width: "200px", mono: true, render: (p) => p.unit || "" },
  { key: "exe", label: "Program path", width: "260px", mono: true, render: (p) => h("span", { class: "t muted" }, p.exe), titleOf: (p) => p.exe },
  { key: "cmd", label: "Command line", width: "minmax(260px, 3fr)", mono: true, render: (p) => h("span", { class: "t muted" }, p.cmd), titleOf: (p) => p.cmd },
];
const DEFAULT = ["name", "pid", "state", "user", "cpu", "cpu_time_s", "mem_private", "threads", "prio", "cmd"];

export default function detailsPage() {
  let table, countEl;
  const chosen = () => store.settings.detailsColumns || DEFAULT;
  const cols = () => ALL.filter((c) => chosen().includes(c.key));

  function rebuild() {
    if (!store.snap) return;
    const procs = visibleProcs();
    table.setRows(flatRows(table, procs));
    countEl.textContent = `${table.rows.length} of ${procs.length} processes`;
  }

  function chooser() {
    const boxes = ALL.filter((c) => !c.fixed).map((c) => h("label", { class: "check" }, h("input", { type: "checkbox", value: c.key, checked: chosen().includes(c.key) }), h("span", null, c.label)));
    dialog({
      title: "Columns",
      text: "Pick what the Details table shows.",
      body: h("div", { class: "check-grid", style: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } }, boxes),
      actions: [
        { label: "Reset", run: () => { saveSettings({ detailsColumns: null }); table.setCols(cols()); rebuild(); } },
        { label: "Show columns", primary: true, run: () => { const keys = ["name", ...boxes.map((b) => b.querySelector("input")).filter((i) => i.checked).map((i) => i.value)]; saveSettings({ detailsColumns: keys }); table.setCols(cols()); rebuild(); } },
      ],
    });
  }

  return {
    id: "details",
    title: "Details",
    flush: true,
    mount(root) {
      table = new Table({
        cols: cols(), label: "All processes", sort: { key: "pid", dir: 1 }, empty: emptyFilter,
        onSelect: (r) => { store.selected = r.data.pid; },
        onActivate: (r) => openDrawer(r.data.pid),
        onContext: (r, x, y) => processMenu(r.data, x, y, table.el),
        onDelete: (r, kill) => endTask(r.data, kill),
      });
      table.onSort = rebuild;
      table.el.addEventListener("keydown", (e) => {
        const r = table.rows.find((x) => x.key === table.sel);
        if (r && e.target === table.el && processKey(e, r.data)) e.preventDefault();
      });
      countEl = h("span", { class: "count", role: "status" });
      root.append(h("div", { class: "tbl-wrap" }, h("div", { class: "tbl-tools" }, countEl, h("span", { class: "spacer" }), h("button", { type: "button", class: "btn", onclick: chooser }, icon("details"), "Columns")), table.el));
      rebuild();
    },
    update: rebuild,
    settings() { table.setCols(cols()); rebuild(); },
    filter: rebuild,
    focusTable() { table.el.focus(); },
    unmount() { table.destroy(); },
  };
}
