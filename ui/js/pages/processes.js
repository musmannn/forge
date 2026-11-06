import { store, saveSettings } from "../store.js";
import { h, icon, menu } from "../ui.js";
import { Table } from "../table.js";
import { columns, groupedRows, treeRows, flatRows, visibleProcs, emptyFilter } from "../procview.js";
import { processMenu, endTask, endTree, processKey, act, hooks } from "../procactions.js";
import { openDrawer } from "../drawer.js";
import { invoke } from "../api.js";

export default function processesPage() {
  let skel, table, mode = store.settings.treeView ? "tree" : "grouped", countEl, endBtn;
  const expanded = new Set();
  const collapsed = new Set();
  const selectedRow = () => table.rows.find((r) => r.key === table.sel);

  const endAgg = (a) => {
    for (const pid of a.roots) act("Ending the app", (el) => invoke("signal_tree", { pid, sig: 15, elevated: el }));
  };

  function rebuild() {
    if (!store.snap) return;
    skel?.remove();
    const procs = visibleProcs();
    const rows = mode === "grouped" ? groupedRows(table, expanded, procs) : mode === "tree" ? treeRows(table, collapsed, procs) : flatRows(table, procs);
    table.setRows(rows);
    const shown = rows.filter((r) => !r.group && !r.agg).length;
    countEl.textContent = store.filter ? `${shown} of ${procs.length} processes match` : `${procs.length} processes, ${store.snap.cpu.threads.toLocaleString()} threads`;
    const r = selectedRow();
    endBtn.disabled = !r || r.group;
  }

  return {
    id: "processes",
    title: "Processes",
    flush: true,
    mount(root) {
      table = new Table({
        cols: columns(),
        label: "Processes",
        sort: { key: "cpu", dir: -1 },
        empty: emptyFilter,
        onSelect: (r) => { store.selected = r.agg ? r.data.root.pid : r.data.pid; endBtn.disabled = false; },
        onActivate: (r) => openDrawer(r.agg ? r.data.root.pid : r.data.pid),
        onToggle: (r) => {
          if (r.group) { const k = `!${r.key.slice(4)}`; expanded.has(k) ? expanded.delete(k) : expanded.add(k); }
          else if (mode === "tree") collapsed.has(r.key) ? collapsed.delete(r.key) : collapsed.add(r.key);
          else expanded.has(r.key) ? expanded.delete(r.key) : expanded.add(r.key);
          rebuild();
        },
        onContext: (r, x, y) => {
          if (r.agg) {
            const a = r.data;
            menu(x, y, [
              { heading: `${a.name}, ${a.count} processes` },
              { label: "End task", icon: "close", run: () => endAgg(a) },
              { label: r.expanded ? "Collapse" : "Expand", run: () => table.onToggle(r) },
              "-",
              ...[["Properties of the main process", () => openDrawer(a.root.pid)]].map(([l, run]) => ({ label: l, icon: "info", run })),
            ], table.el);
          } else processMenu(r.data, x, y, table.el);
        },
        onDelete: (r, kill) => (r.agg ? endAgg(r.data) : endTask(r.data, kill)),
      });
      table.onSort = rebuild;
      table.el.addEventListener("keydown", (e) => {
        const r = selectedRow();
        if (r && !r.group && !r.agg && e.target === table.el && processKey(e, r.data)) e.preventDefault();
      });
      const seg = h("div", { class: "seg", role: "group", "aria-label": "View" },
        [["grouped", "Grouped"], ["tree", "Tree"], ["flat", "Flat"]].map(([k, l]) =>
          h("button", { type: "button", "aria-pressed": String(mode === k), onclick: (e) => { mode = k; saveSettings({ treeView: k === "tree" }); seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false")); e.currentTarget.setAttribute("aria-pressed", "true"); rebuild(); } }, l)));
      countEl = h("span", { class: "count", role: "status" });
      endBtn = h("button", { type: "button", class: "btn", disabled: true, onclick: () => { const r = selectedRow(); if (r) r.agg ? endAgg(r.data) : endTask(r.data); } }, "End task");
      const kernel = h("label", { class: "switch" }, h("input", { type: "checkbox", checked: store.settings.showKernel, onchange: (e) => { saveSettings({ showKernel: e.target.checked }); rebuild(); } }), h("i"), h("span", null, "Kernel threads"));
      root.append(
        h("div", { class: "tbl-wrap" },
          h("div", { class: "tbl-tools" }, seg, kernel, countEl, h("span", { class: "spacer" }),
            h("button", { type: "button", class: "btn", onclick: () => { const r = selectedRow(); if (r && !r.group) endTree(r.agg ? r.data.root : r.data); } }, icon("tree"), "End tree"),
            endBtn),
          table.el),
      );
      if (!store.snap) table.body.append((skel = h("div", { class: "skeleton", "aria-label": "Loading processes" }, Array.from({ length: 10 }, () => h("i")))));
      rebuild();
      if (this.params?.pid) setTimeout(() => table.select(`p:${this.params.pid}`), 0);
    },
    update: rebuild,
    settings() { table.setCols(columns()); rebuild(); },
    filter: rebuild,
    focusTable() { table.el.focus(); },
    unmount() { table.destroy(); },
  };
}

export { hooks };
