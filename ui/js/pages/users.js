import { invoke, errText } from "../api.js";
import { store, cpuOf } from "../store.js";
import { h, menu, toast, confirmDialog } from "../ui.js";
import { Table } from "../table.js";
import { nameCell, matches } from "../procview.js";
import { processMenu, endTask } from "../procactions.js";
import { openDrawer } from "../drawer.js";
import * as f from "../fmt.js";

export default function usersPage() {
  let table, sessions = null, sessErr = null, sessEl;
  const expanded = new Set();

  const cols = [
    { key: "name", label: "User", width: "minmax(240px, 2fr)", render: (d, r) => (r?.agg ? h("span", { class: "t" }, d.name, " ", h("span", { class: "cnt" }, `(${d.count})`)) : nameCell(d)), sortVal: (d) => d.name.toLowerCase() },
    { key: "status", label: "Status", width: "160px", render: (d, r) => (r?.agg ? sessionState(d.name) : f.STATE[d.state] || "") },
    { key: "cpu", label: "CPU", width: "90px", num: true, render: (d) => f.pct(cpuOf(d), 1), sortVal: (d) => d.cpu, heat: (d) => d.cpu / 60, total: () => f.pct(store.snap?.cpu.total || 0) },
    { key: "mem", label: "Memory", width: "110px", num: true, render: (d) => f.bytes(d.mem_private ?? d.mem), sortVal: (d) => d.mem_private ?? d.mem, heat: (d) => (d.mem_private ?? d.mem) / (store.snap?.mem.total || 1) * 3 },
    { key: "disk", label: "Disk", width: "100px", num: true, render: (d) => f.rate(d.read_bps + d.write_bps), sortVal: (d) => d.read_bps + d.write_bps },
    { key: "gpu", label: "GPU", width: "80px", num: true, render: (d) => (d.gpu != null ? f.pct(d.gpu, 1) : ""), sortVal: (d) => d.gpu ?? -1 },
  ];

  function sessionState(user) {
    const ss = (sessions || []).filter((s) => s.Name === user && s.Class === "user");
    if (!ss.length) return h("span", { class: "muted" }, "No session");
    const s = ss[0];
    return h("span", { class: `chip ${s.LockedHint === "yes" ? "chip--amber" : "chip--ok"}` }, s.LockedHint === "yes" ? "Locked" : s.State === "active" ? "Signed in" : s.State);
  }

  function rebuild() {
    if (!store.snap) return;
    const by = new Map();
    for (const p of store.snap.procs) {
      if (p.kind === "kernel") continue;
      if (!by.has(p.user)) by.set(p.user, []);
      by.get(p.user).push(p);
    }
    const aggs = [...by.entries()].map(([name, ps]) => {
      const a = { name, count: ps.length, cpu: 0, mem: 0, mem_private: 0, read_bps: 0, write_bps: 0, gpu: null, procs: ps, uid: ps[0].uid };
      for (const p of ps) { a.cpu += p.cpu; a.mem += p.mem; a.mem_private += p.mem_private || p.mem; a.read_bps += p.read_bps; a.write_bps += p.write_bps; if (p.gpu != null) a.gpu = (a.gpu || 0) + p.gpu; }
      return a;
    });
    const rows = [];
    for (const r of table.sortRows(aggs.map((a) => ({ data: a })))) {
      const a = r.data;
      const q = store.filter;
      const kids = q ? a.procs.filter((p) => matches(p, q)) : a.procs;
      if (q && !kids.length && !a.name.includes(q)) continue;
      const k = `u:${a.name}`;
      const open = expanded.has(k) || (!!q && kids.length > 0);
      rows.push({ key: k, data: a, agg: true, kids: true, expanded: open, depth: 0 });
      if (open) for (const pr of table.sortRows(kids.map((p) => ({ data: p })))) rows.push({ key: `p:${pr.data.pid}`, data: pr.data, depth: 1 });
    }
    table.setRows(rows);
  }

  async function loadSessions() {
    try { sessions = await invoke("list_sessions"); sessErr = null; } catch (e) { sessErr = errText(e); }
    renderSessions();
    rebuild();
  }

  function renderSessions() {
    if (sessErr) { sessEl.replaceChildren(h("p", { class: "muted" }, `Sessions could not be listed: ${sessErr}`)); return; }
    if (!sessions) { sessEl.replaceChildren(h("div", { class: "skeleton", style: { padding: "0" } }, h("i"))); return; }
    const user = sessions.filter((s) => s.Class === "user" || s.Class === "user-early" || s.Remote === "yes");
    sessEl.replaceChildren(
      ...user.map((s) => h("div", { class: "panel", style: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: "var(--space-md)" } },
        h("div", { style: { minWidth: "0" } }, h("b", null, s.Name), h("div", { class: "muted", style: { fontSize: "var(--text-xs)" } }, `Session ${s.Id}, ${s.Type}${s.TTY ? ` on ${s.TTY}` : ""}${s.Seat ? `, ${s.Seat}` : ""}${s.Remote === "yes" ? `, remote from ${s.RemoteHost}` : ""}, since ${s.Timestamp}`)),
        h("span", { style: { flex: "1" } }),
        h("button", { type: "button", class: "btn", onclick: () => invoke("session_action", { id: s.Id, verb: "lock-session" }).then(loadSessions, (e) => toast(errText(e), { bad: true })) }, "Lock"),
        h("button", { type: "button", class: "btn btn--danger", onclick: async () => { if (await confirmDialog(`Sign ${s.Name} out?`, `Every program in session ${s.Id} closes. Unsaved work is lost.`, "Sign out", true)) invoke("session_action", { id: s.Id, verb: "terminate-session" }).then(loadSessions, (e) => toast(errText(e), { bad: true })); } }, "Sign out"))),
    );
  }

  return {
    id: "users",
    title: "Users",
    flush: true,
    mount(root) {
      table = new Table({
        cols, label: "Users", sort: { key: "cpu", dir: -1 },
        onToggle: (r) => { expanded.has(r.key) ? expanded.delete(r.key) : expanded.add(r.key); rebuild(); },
        onActivate: (r) => (r.agg ? table.onToggle(r) : openDrawer(r.data.pid)),
        onSelect: (r) => { if (!r.agg) store.selected = r.data.pid; },
        onContext: (r, x, y) => (r.agg ? menu(x, y, [{ label: r.expanded ? "Collapse" : "Expand", run: () => table.onToggle(r) }], table.el) : processMenu(r.data, x, y, table.el)),
        onDelete: (r, kill) => !r.agg && endTask(r.data, kill),
      });
      table.onSort = rebuild;
      sessEl = h("div", { class: "panels", style: { margin: "var(--space-md) var(--space-lg)" }, "aria-label": "Sessions" });
      root.append(h("div", { class: "tbl-wrap" }, sessEl, table.el));
      renderSessions();
      loadSessions();
      rebuild();
    },
    update() { rebuild(); if (store.ticks % 10 === 0) loadSessions(); },
    filter: rebuild,
    unmount() { table.destroy(); },
  };
}
