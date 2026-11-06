import { invoke, errText } from "../api.js";
import { store } from "../store.js";
import { h, icon, menu, dialog, toast, confirmDialog, copyText } from "../ui.js";
import { Table } from "../table.js";
import { appIcon } from "../procview.js";
import * as f from "../fmt.js";

export default function startupPage() {
  let table, list = null, err = null, wrap, countEl;

  const running = (a) => {
    if (!store.snap || !a.program) return [];
    const prog = a.program.toLowerCase();
    return store.snap.procs.filter((p) => p.name.toLowerCase() === prog || (p.exe && p.exe.toLowerCase().endsWith("/" + prog)));
  };

  async function toggle(a) {
    try {
      await invoke("set_startup", { id: a.id, enabled: !a.enabled });
      await load();
    } catch (e) {
      toast(`Could not change ${a.name}: ${errText(e)}`, { bad: true });
    }
  }

  const cols = [
    { key: "name", label: "Name", width: "minmax(220px, 1.6fr)", render: (a) => { const s = appIcon(a.icon); return [s ? h("img", { class: "ico", src: s, alt: "", width: "18", height: "18" }) : h("span", { class: "ico-blank", "aria-hidden": "true" }), h("span", { class: "t" }, a.name)]; }, sortVal: (a) => a.name.toLowerCase(), titleOf: (a) => a.comment || a.name },
    { key: "status", label: "Status", width: "120px", render: (a) => h("span", { class: `chip ${a.enabled ? "chip--ok" : ""}` }, a.enabled ? "Enabled" : "Disabled"), sortVal: (a) => (a.enabled ? 1 : 0) },
    { key: "running", label: "Running now", width: "150px", num: true, render: (a) => { const r = running(a); return r.length ? f.bytes(r.reduce((s, p) => s + (p.mem_private || p.mem), 0)) : "No"; }, sortVal: (a) => running(a).reduce((s, p) => s + p.mem, 0) },
    { key: "exec", label: "Command", width: "minmax(220px, 2fr)", mono: true, render: (a) => h("span", { class: "t muted" }, a.exec), titleOf: (a) => a.exec },
    { key: "source", label: "Added by", width: "130px", render: (a) => (a.source === "you" ? (a.user_created ? "You" : "System, changed by you") : "System"), sortVal: (a) => a.source },
    { key: "here", label: "This desktop", width: "120px", render: (a) => (a.shown_here ? "Runs here" : "Skipped here"), titleOf: () => "Entries can be limited to some desktops with OnlyShowIn and NotShowIn" },
  ];

  async function load() {
    try {
      list = await invoke("startup_apps");
      err = null;
    } catch (e) {
      err = errText(e);
    }
    render();
  }

  function render() {
    if (err) { wrap.replaceChildren(h("div", { class: "state state--error" }, h("h3", null, "Startup apps could not be read"), h("p", null, err), h("button", { type: "button", class: "btn", onclick: load }, "Try again"))); return; }
    if (!list) return;
    const q = store.filter.toLowerCase();
    const shown = list.filter((a) => !q || a.name.toLowerCase().includes(q) || a.exec.toLowerCase().includes(q));
    countEl.textContent = `${list.filter((a) => a.enabled && a.shown_here).length} of ${list.length} start when you sign in`;
    table.setRows(table.sortRows(shown.map((a) => ({ data: a }))).map((r) => ({ key: r.data.id, data: r.data })));
    toggleBtn.disabled = !current();
    toggleBtn.textContent = current()?.enabled ? "Disable" : "Enable";
  }

  const current = () => list?.find((a) => a.id === table.sel);
  const toggleBtn = h("button", { type: "button", class: "btn", disabled: true, onclick: () => current() && toggle(current()) }, "Disable");

  function addDialog() {
    const name = h("input", { class: "input", id: "su-name", name: "name", autocomplete: "off" });
    const cmd = h("input", { class: "input", id: "su-cmd", name: "command", autocomplete: "off", spellcheck: "false" });
    dialog({
      title: "Add a startup app",
      text: "Forge writes a desktop entry to ~/.config/autostart. It runs the next time you sign in.",
      body: [h("div", { class: "field" }, h("label", { for: "su-name" }, "Name"), name), h("div", { class: "field" }, h("label", { for: "su-cmd" }, "Command"), cmd, h("span", { class: "help" }, "For example: syncthing serve --no-browser"))],
      actions: [{ label: "Cancel" }, { label: "Add startup app", primary: true, run: () => { invoke("add_startup", { name: name.value, command: cmd.value }).then(load, (e) => toast(errText(e), { bad: true })); } }],
    });
  }

  return {
    id: "startup",
    title: "Startup apps",
    flush: true,
    mount(root) {
      table = new Table({
        cols, label: "Startup apps", sort: { key: "name", dir: 1 },
        empty: () => [h("h3", null, store.filter ? "No startup app matches" : "Nothing starts when you sign in"), h("p", null, "Add an app with the button above and it runs at your next sign-in.")],
        onSelect: () => render(),
        onActivate: (r) => toggle(r.data),
        onContext: (r, x, y) => menu(x, y, [
          { label: r.data.enabled ? "Disable" : "Enable", run: () => toggle(r.data) },
          { label: "Open the entry", icon: "external", run: () => invoke("open_path", { path: r.data.path }).catch((e) => toast(errText(e), { bad: true })) },
          { label: "Copy command", icon: "copy", run: () => copyText(r.data.exec) },
          r.data.user_created ? "-" : null,
          r.data.user_created ? { label: "Remove", danger: true, run: async () => { if (await confirmDialog(`Remove ${r.data.name}?`, "Its entry in ~/.config/autostart is deleted.", "Remove", true)) invoke("remove_startup", { id: r.data.id }).then(load, (e) => toast(errText(e), { bad: true })); } } : null,
        ].filter(Boolean), table.el),
      });
      table.onSort = render;
      countEl = h("span", { class: "count", role: "status" });
      wrap = h("div", { class: "tbl-wrap" },
        h("div", { class: "tbl-tools" }, countEl, h("span", { class: "spacer" }), h("button", { type: "button", class: "btn", onclick: addDialog }, icon("plus"), "Add"), toggleBtn),
        table.el);
      root.append(wrap);
      load();
    },
    update() { if (store.ticks % 3 === 0) table.paint(); },
    filter: render,
    unmount() { table.destroy(); },
  };
}
