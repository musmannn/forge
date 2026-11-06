import { invoke, errText } from "../api.js";
import { store } from "../store.js";
import { h, menu, copyText } from "../ui.js";
import { Table } from "../table.js";
import { processMenu } from "../procactions.js";
import { openDrawer } from "../drawer.js";

export default function connectionsPage() {
  let table, list = null, err = null, show = "all", countEl, body;

  const addr = (a, p) => (a.includes(":") ? `[${a}]:${p}` : `${a}:${p}`);
  const cols = [
    { key: "process", label: "Process", width: "minmax(160px, 1.2fr)", render: (c) => h("span", { class: "t" }, c.process || (c.pid ? "" : "Another user's process")), sortVal: (c) => c.process || "~" },
    { key: "pid", label: "PID", width: "78px", num: true, render: (c) => (c.pid ? String(c.pid) : ""), sortVal: (c) => c.pid ?? 0 },
    { key: "proto", label: "Protocol", width: "84px", render: (c) => c.proto },
    { key: "local", label: "Local address", width: "minmax(180px, 1.3fr)", mono: true, render: (c) => addr(c.local, c.local_port), sortVal: (c) => c.local_port },
    { key: "remote", label: "Remote address", width: "minmax(180px, 1.3fr)", mono: true, render: (c) => (c.remote_port ? addr(c.remote, c.remote_port) : ""), sortVal: (c) => c.remote },
    { key: "state", label: "State", width: "120px", render: (c) => h("span", { class: `chip${c.state === "Listening" ? " chip--cool" : c.state === "Established" || c.state === "Connected" ? " chip--ok" : ""}` }, c.state) },
    { key: "service", label: "Service", width: "110px", render: (c) => c.service },
    { key: "queue", label: "Queued", width: "96px", num: true, render: (c) => (c.tx_queue || c.rx_queue ? `${c.tx_queue}/${c.rx_queue}` : ""), sortVal: (c) => c.tx_queue + c.rx_queue, titleOf: () => "Bytes waiting to send / to be read" },
  ];

  async function load() {
    try { list = await invoke("list_connections"); err = null; } catch (e) { err = errText(e); }
    render();
  }

  function render() {
    if (err) { body.replaceChildren(h("div", { class: "state state--error" }, h("h3", null, "Sockets could not be read"), h("p", null, err))); return; }
    if (!list) return;
    if (!body.contains(table.el)) body.replaceChildren(table.el);
    const q = store.filter.toLowerCase();
    const shown = list.filter((c) =>
      (show === "all" || (show === "listening" && (c.state === "Listening" || (c.proto.startsWith("UDP") && !c.remote_port))) || (show === "established" && (c.state === "Established" || c.state === "Connected"))) &&
      (!q || c.process.toLowerCase().includes(q) || String(c.pid) === q || String(c.local_port) === q || String(c.remote_port) === q || c.remote.includes(q) || c.service.includes(q)));
    const listen = list.filter((c) => c.state === "Listening").length;
    const est = list.filter((c) => c.state === "Established").length;
    countEl.textContent = `${listen} listening, ${est} established, ${list.length} sockets. Sockets of other users show no process without administrator rights.`;
    table.setRows(table.sortRows(shown.map((c) => ({ data: c }))).map((r, i) => ({ key: `${r.data.proto}${r.data.local}${r.data.local_port}${r.data.remote}${r.data.remote_port}${i}`, data: r.data })));
  }

  return {
    id: "connections",
    title: "Connections",
    flush: true,
    mount(root) {
      table = new Table({
        cols, label: "Network sockets", sort: { key: "state", dir: 1 },
        empty: () => [h("h3", null, "No socket matches"), h("p", null, "Try All, or clear the filter.")],
        onActivate: (r) => r.data.pid && openDrawer(r.data.pid),
        onSelect: (r) => { if (r.data.pid) store.selected = r.data.pid; },
        onContext: (r, x, y) => {
          const p = r.data.pid && store.procIndex.get(r.data.pid);
          if (p) processMenu(p, x, y, table.el);
          else menu(x, y, [{ label: "Copy local address", icon: "copy", run: () => copyText(addr(r.data.local, r.data.local_port)) }], table.el);
        },
      });
      table.onSort = render;
      const which = h("div", { class: "seg", role: "group", "aria-label": "Show" },
        [["all", "All"], ["listening", "Listening"], ["established", "Established"]].map(([v, l]) => h("button", { type: "button", "aria-pressed": String(show === v), onclick: (e) => { show = v; which.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false")); e.currentTarget.setAttribute("aria-pressed", "true"); render(); } }, l)));
      countEl = h("span", { class: "count", role: "status" });
      body = h("div", { class: "tbl-wrap" }, h("div", { class: "skeleton", "aria-label": "Reading sockets" }, h("i"), h("i"), h("i")));
      root.append(h("div", { class: "tbl-wrap" }, h("div", { class: "tbl-tools" }, which, countEl), body));
      load();
    },
    update() { if (store.ticks % 2 === 0) load(); },
    filter: render,
    focusTable() { table.el.focus(); },
    unmount() { table.destroy(); },
  };
}
