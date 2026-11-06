import { invoke, errText } from "../api.js";
import { store, cpuOf } from "../store.js";
import { h, icon, menu, dialog, toast, confirmDialog } from "../ui.js";
import { Table } from "../table.js";
import { act, hooks } from "../procactions.js";
import * as f from "../fmt.js";

export default function servicesPage() {
  let table, list = null, err = null, user = false, show = "all", countEl, wrap, body, btns = {};
  let usage = new Map();

  function computeUsage() {
    usage = new Map();
    for (const p of store.snap?.procs || []) {
      if (!p.unit || !p.unit.endsWith(".service")) continue;
      const u = usage.get(p.unit) || { cpu: 0, mem: 0, pids: [] };
      u.cpu += cpuOf(p);
      u.mem += p.mem_private || p.mem;
      u.pids.push(p.pid);
      usage.set(p.unit, u);
    }
  }

  const statusChip = (s) => {
    if (s.active === "active") return h("span", { class: "chip chip--ok" }, s.sub === "running" ? "Running" : s.sub === "exited" ? "Finished" : s.sub);
    if (s.active === "failed") return h("span", { class: "chip chip--bad" }, "Failed");
    if (s.active === "activating" || s.active === "reloading") return h("span", { class: "chip chip--cool" }, s.active === "reloading" ? "Reloading" : "Starting");
    if (s.active === "deactivating") return h("span", { class: "chip" }, "Stopping");
    return h("span", { class: "chip" }, "Stopped");
  };

  const cols = [
    { key: "unit", label: "Name", width: "minmax(220px, 1.4fr)", mono: true, render: (s) => h("span", { class: "t" }, s.unit.replace(/\.service$/, "")), titleOf: (s) => s.unit },
    { key: "description", label: "Description", width: "minmax(220px, 2fr)", render: (s) => h("span", { class: "t" }, s.description), titleOf: (s) => s.description },
    { key: "active", label: "Status", width: "110px", render: statusChip, sortVal: (s) => ({ failed: 0, active: 1, activating: 2 }[s.active] ?? 3) },
    { key: "enablement", label: "Startup", width: "110px", render: (s) => ({ enabled: "Automatic", disabled: "Manual", static: "Static", masked: "Masked", "enabled-runtime": "This boot", indirect: "Indirect", generated: "Generated", alias: "Alias" }[s.enablement] || s.enablement), titleOf: (s) => s.enablement },
    { key: "pids", label: "PIDs", width: "110px", num: true, render: (s) => { const u = usage.get(s.unit); return u ? (u.pids.length > 2 ? `${u.pids[0]} +${u.pids.length - 1}` : u.pids.join(" ")) : ""; }, sortVal: (s) => usage.get(s.unit)?.pids[0] ?? 0 },
    { key: "cpu", label: "CPU", width: "80px", num: true, render: (s) => (usage.get(s.unit) ? f.pct(usage.get(s.unit).cpu, 1) : ""), sortVal: (s) => usage.get(s.unit)?.cpu ?? -1, heat: (s) => (usage.get(s.unit)?.cpu ?? 0) / 60 },
    { key: "mem", label: "Memory", width: "100px", num: true, render: (s) => (usage.get(s.unit) ? f.bytes(usage.get(s.unit).mem) : ""), sortVal: (s) => usage.get(s.unit)?.mem ?? -1 },
  ];

  async function load() {
    try {
      list = await invoke("list_services", { user });
      err = null;
    } catch (e) {
      err = errText(e);
    }
    render();
  }

  const current = () => list?.find((s) => s.unit === table.sel);

  function render() {
    if (err) { body.replaceChildren(h("div", { class: "state state--error" }, h("h3", null, "Services could not be listed"), h("p", null, err), h("button", { type: "button", class: "btn", onclick: load }, "Try again"))); return; }
    if (!list) return;
    if (!body.contains(table.el)) body.replaceChildren(table.el);
    computeUsage();
    const q = store.filter.toLowerCase();
    const shown = list.filter((s) =>
      (show === "all" || (show === "running" && s.active === "active") || (show === "failed" && s.active === "failed") || (show === "stopped" && s.active === "inactive")) &&
      (!q || s.unit.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)));
    const running = list.filter((s) => s.active === "active" && s.sub === "running").length;
    const failed = list.filter((s) => s.active === "failed").length;
    countEl.textContent = `${running} running, ${failed} failed, ${list.length} in all`;
    table.setRows(table.sortRows(shown.map((s) => ({ data: s }))).map((r) => ({ key: r.data.unit, data: r.data })));
    const c = current();
    btns.start.disabled = !c || c.active === "active";
    btns.stop.disabled = !c || c.active !== "active";
    btns.restart.disabled = !c;
  }

  function run(s, verb) {
    const label = { start: "Starting", stop: "Stopping", restart: "Restarting", reload: "Reloading", enable: "Enabling", disable: "Disabling", mask: "Masking", unmask: "Unmasking" }[verb];
    act(`${label} ${s.unit}`, (el) => invoke("service_action", { user, unit: s.unit, verb, elevated: el })).then(() => setTimeout(load, 400));
  }

  async function logs(s) {
    const pre = h("pre", { class: "codebox", style: { maxHeight: "60vh" } }, "Reading the journal…");
    dialog({ title: `Log of ${s.unit}`, text: "The last 300 lines from journalctl.", body: pre, wide: true, actions: [{ label: "Close", primary: true }] });
    try {
      const t = await invoke("service_logs", { user, unit: s.unit, lines: 300 });
      pre.textContent = t.trim() || "The journal has no lines for this unit.";
      pre.scrollTop = pre.scrollHeight;
    } catch (e) {
      pre.textContent = `The journal could not be read: ${errText(e)}`;
    }
  }

  function ctx(s, x, y) {
    menu(x, y, [
      { label: "Start", icon: "play", disabled: s.active === "active", run: () => run(s, "start") },
      { label: "Stop", icon: "stop", disabled: s.active !== "active", run: () => run(s, "stop") },
      { label: "Restart", icon: "refresh", run: () => run(s, "restart") },
      { label: "Reload settings", run: () => run(s, "reload") },
      "-",
      { label: "Start automatically", disabled: s.enablement === "enabled" || s.enablement === "static", run: () => run(s, "enable") },
      { label: "Start manually", disabled: s.enablement !== "enabled", run: () => run(s, "disable") },
      s.enablement === "masked" ? { label: "Unmask", run: () => run(s, "unmask") } : { label: "Mask", danger: true, run: async () => { if (await confirmDialog(`Mask ${s.unit}?`, "A masked service cannot be started at all, by you or by anything else, until it is unmasked.", "Mask", true)) run(s, "mask"); } },
      "-",
      { label: "Open log", icon: "details", run: () => logs(s) },
      usage.get(s.unit) ? { label: "Show its processes", icon: "processes", run: () => hooks.go?.("details", { filter: s.unit }) } : null,
    ].filter(Boolean), table.el);
  }

  return {
    id: "services",
    title: "Services",
    flush: true,
    mount(root) {
      if (this.params?.user != null) user = this.params.user;
      table = new Table({
        cols, label: "Services", sort: { key: "unit", dir: 1 },
        empty: () => [h("h3", null, "No service matches"), h("p", null, "Change the filter, or switch between system and your own services.")],
        onSelect: () => render(),
        onActivate: (r) => logs(r.data),
        onContext: (r, x, y) => ctx(r.data, x, y),
      });
      table.onSort = render;
      const scope = h("div", { class: "seg", role: "group", "aria-label": "Scope" },
        [[false, "System"], [true, "Yours"]].map(([v, l]) => h("button", { type: "button", "aria-pressed": String(user === v), onclick: (e) => { user = v; list = null; scope.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false")); e.currentTarget.setAttribute("aria-pressed", "true"); body.replaceChildren(h("div", { class: "skeleton" }, h("i"), h("i"), h("i"))); load(); } }, l)));
      const which = h("div", { class: "seg", role: "group", "aria-label": "Show" },
        [["all", "All"], ["running", "Running"], ["failed", "Failed"], ["stopped", "Stopped"]].map(([v, l]) => h("button", { type: "button", "aria-pressed": String(show === v), onclick: (e) => { show = v; which.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false")); e.currentTarget.setAttribute("aria-pressed", "true"); render(); } }, l)));
      countEl = h("span", { class: "count", role: "status" });
      btns.start = h("button", { type: "button", class: "btn", disabled: true, onclick: () => current() && run(current(), "start") }, icon("play"), "Start");
      btns.stop = h("button", { type: "button", class: "btn", disabled: true, onclick: () => current() && run(current(), "stop") }, icon("stop"), "Stop");
      btns.restart = h("button", { type: "button", class: "btn", disabled: true, onclick: () => current() && run(current(), "restart") }, icon("refresh"), "Restart");
      body = h("div", { class: "tbl-wrap" }, h("div", { class: "skeleton", "aria-label": "Loading services" }, h("i"), h("i"), h("i"), h("i")));
      wrap = h("div", { class: "tbl-wrap" }, h("div", { class: "tbl-tools" }, scope, which, countEl, h("span", { class: "spacer" }), btns.start, btns.stop, btns.restart), body);
      root.append(wrap);
      load();
      if (this.params?.unit) { store.filter = ""; setTimeout(() => table.select(this.params.unit), 300); }
    },
    update() { if (list) { computeUsage(); table.paint(); } if (store.ticks % 10 === 0) load(); },
    filter: render,
    focusTable() { table.el.focus(); },
    unmount() { table.destroy(); },
  };
}
