import { invoke, errText } from "../api.js";
import { store } from "../store.js";
import { h, confirmDialog } from "../ui.js";
import { Table } from "../table.js";
import { appIcon } from "../procview.js";
import * as f from "../fmt.js";

export default function appHistoryPage() {
  let table, sinceEl, data = null, err = null, wrap;

  const cols = [
    { key: "name", label: "Name", width: "minmax(240px, 2fr)", render: (a) => { const s = appIcon(a.icon); return [s ? h("img", { class: "ico", src: s, alt: "", width: "18", height: "18" }) : h("span", { class: "ico-blank", "aria-hidden": "true" }), h("span", { class: "t" }, a.name)]; }, sortVal: (a) => a.name.toLowerCase() },
    { key: "kind", label: "Kind", width: "120px", render: (a) => ({ app: "App", background: "Background", system: "System" }[a.kind] || a.kind) },
    { key: "cpu_s", label: "CPU time", width: "110px", num: true, render: (a) => f.cpuTime(a.cpu_s), heat: (a) => a.cpu_s / (top("cpu_s") || 1) },
    { key: "read", label: "Disk read", width: "110px", num: true, render: (a) => f.bytes(a.read), heat: (a) => a.read / (top("read") || 1) },
    { key: "write", label: "Disk written", width: "110px", num: true, render: (a) => f.bytes(a.write), heat: (a) => a.write / (top("write") || 1) },
    { key: "gpu_s", label: "GPU time", width: "100px", num: true, render: (a) => (a.gpu_s > 0.05 ? f.cpuTime(a.gpu_s) : "") },
    { key: "peak_mem", label: "Peak memory", width: "110px", num: true, render: (a) => f.bytes(a.peak_mem) },
    { key: "last_seen", label: "Last seen", width: "130px", num: true, render: (a) => (Date.now() - a.last_seen < 5000 ? "Running" : f.since(a.last_seen / 1000)) },
  ];
  const tops = {};
  const top = (k) => tops[k];

  async function load() {
    try {
      data = await invoke("app_history");
      err = null;
    } catch (e) {
      err = errText(e);
    }
    render();
  }

  function render() {
    if (err) { wrap.replaceChildren(h("div", { class: "state state--error" }, h("h3", null, "App history could not be read"), h("p", null, err), h("button", { type: "button", class: "btn", onclick: load }, "Try again"))); return; }
    if (!data) return;
    const list = Object.values(data.apps).filter((a) => !store.filter || a.name.toLowerCase().includes(store.filter.toLowerCase()));
    for (const k of ["cpu_s", "read", "write"]) tops[k] = Math.max(0, ...list.map((a) => a[k]));
    sinceEl.textContent = `Since ${f.dateTime(data.since)}. Kept between sessions while Forge runs.`;
    table.setRows(table.sortRows(list.map((a) => ({ data: a }))).map((r) => ({ key: r.data.name, data: r.data })));
  }

  return {
    id: "history",
    title: "App history",
    flush: true,
    mount(root) {
      table = new Table({ cols, label: "App history", sort: { key: "cpu_s", dir: -1 }, empty: () => [h("h3", null, "Nothing recorded yet"), h("p", null, "Forge adds CPU time and disk traffic for every program from the moment it starts. Come back in a minute.")] });
      table.onSort = render;
      sinceEl = h("span", { class: "count" });
      wrap = h("div", { class: "tbl-wrap" },
        h("div", { class: "tbl-tools" }, sinceEl, h("span", { class: "spacer" }),
          h("button", { type: "button", class: "btn", onclick: async () => { if (await confirmDialog("Clear app history?", "Every app's totals go back to zero and the record starts again now.", "Clear history", true)) { await invoke("reset_app_history"); load(); } } }, "Clear history")),
        table.el);
      root.append(wrap);
      load();
    },
    update() { if (store.ticks % 5 === 0) load(); },
    filter: render,
    unmount() { table.destroy(); },
  };
}
