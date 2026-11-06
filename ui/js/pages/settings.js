import { invoke, errText } from "../api.js";
import { store, saveSettings } from "../store.js";
import { h, toast } from "../ui.js";
import { hooks } from "../procactions.js";

export default function settingsPage() {
  const seg = (label, key, options, after) => {
    const g = h("div", { class: "seg", role: "group", "aria-label": label },
      options.map(([v, l]) => h("button", { type: "button", "aria-pressed": String(store.settings[key] === v), onclick: (e) => { saveSettings({ [key]: v }); g.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false")); e.currentTarget.setAttribute("aria-pressed", "true"); after?.(v); } }, l)));
    return g;
  };
  const sw = (key, after, id) => h("label", { class: "switch" }, h("input", { type: "checkbox", id, checked: !!store.settings[key], onchange: (e) => { saveSettings({ [key]: e.target.checked }); after?.(e.target.checked); } }), h("i"));
  const row = (t, p, control) => (control.querySelector?.("input")?.setAttribute("aria-label", t), h("div", { class: "setting" }, h("div", null, h("div", { class: "t" }, t), p ? h("p", null, p) : null), control));
  const alertNum = (key, min, max, unit) => h("span", { style: { display: "inline-flex", alignItems: "center", gap: "var(--space-xs)" } },
    h("input", { class: "input", type: "number", inputmode: "numeric", min: String(min), max: String(max), value: String(store.settings.alerts[key]), "aria-label": key, onchange: (e) => { const v = Math.max(min, Math.min(max, +e.target.value || min)); e.target.value = String(v); saveSettings({ alerts: { ...store.settings.alerts, [key]: v } }); } }),
    h("span", { class: "muted" }, unit));

  return {
    id: "settings",
    title: "Settings",
    mount(root) {
      root.append(h("div", { class: "settings" },
        h("section", null, h("h2", null, "Updates"),
          row("Update speed", "How often Forge samples the machine. Faster costs a little more processor time.", seg("Update speed", "interval", [[500, "0.5 s"], [1000, "1 s"], [2000, "2 s"], [5000, "5 s"]], (v) => invoke("set_interval", { ms: v }))),
          row("Time shown in graphs", null, seg("Time shown", "windowSecs", [[60, "1 min"], [300, "5 min"], [1800, "30 min"], [3600, "1 hour"]]))),
        h("section", null, h("h2", null, "Look"),
          row("Colourway", "Graphite is the default. Paper is light. Amber room is warm and dim for night work.", seg("Colourway", "colourway", [["graphite", "Graphite"], ["paper", "Paper"], ["amber-room", "Amber room"]], () => hooks.applyColourway?.()))),
        h("section", null, h("h2", null, "Processes"),
          row("Processor percentages", "Whole machine reads like Task Manager: all cores together make 100%. One core reads like btop and top: a busy single thread shows 100%.", seg("Processor percentages", "cpuMode", [["machine", "Whole machine"], ["core", "One core"]])),
          row("Show kernel threads", "Kernel workers have no program file. Hidden by default.", sw("showKernel")),
          row("Confirm before ending a task", null, sw("confirmEnd")),
          row("Show virtual network adapters", "Docker bridges, VPN tunnels and veth pairs in Performance.", sw("showVirtualNet"))),
        h("section", null, h("h2", null, "Window"),
          row("Always on top", null, sw("onTop", (v) => invoke("set_always_on_top", { on: v }).catch((e) => toast(errText(e), { bad: true })))),
          row("Summary view", "A small window with only the graphs, as in the old Task Manager. Double-click it or press Escape to come back.", h("button", { type: "button", class: "btn", onclick: () => hooks.compact?.(true) }, "Open summary view"))),
        h("section", null, h("h2", null, "Alerts"),
          row("Desktop notifications", "Forge tells you when something stays past a limit. Each alert repeats at most once every five minutes.", h("label", { class: "switch" }, h("input", { type: "checkbox", checked: store.settings.alerts.enabled, onchange: (e) => saveSettings({ alerts: { ...store.settings.alerts, enabled: e.target.checked } }) }), h("i"))),
          row("Processor above", "For longer than the time below.", alertNum("cpu", 10, 100, "%")),
          row("For longer than", null, alertNum("cpuSecs", 3, 600, "s")),
          row("Memory above", null, alertNum("mem", 10, 100, "%")),
          row("Processor temperature above", null, alertNum("temp", 40, 110, "°C")),
          row("Battery below", "Only while unplugged.", alertNum("battery", 3, 60, "%")),
          row("Try it", null, h("button", { type: "button", class: "btn", onclick: () => invoke("notify", { title: "Forge", body: "Alerts reach your desktop." }).catch((e) => toast(`Notifications failed: ${errText(e)}`, { bad: true })) }, "Send a test alert"))),
        h("section", null, h("h2", null, "Data"),
          row("Export the current sample", "Saved to your Downloads folder.", h("span", { style: { display: "inline-flex", gap: "var(--space-xs)" } },
            h("button", { type: "button", class: "btn", onclick: () => invoke("export_snapshot", { format: "json" }).then((p) => toast(`Saved ${p}`), (e) => toast(errText(e), { bad: true })) }, "Everything as JSON"),
            h("button", { type: "button", class: "btn", onclick: () => invoke("export_snapshot", { format: "csv" }).then((p) => toast(`Saved ${p}`), (e) => toast(errText(e), { bad: true })) }, "Processes as CSV"))),
          row("Keyboard shortcuts", null, h("button", { type: "button", class: "btn", onclick: () => hooks.shortcuts?.() }, "Show shortcuts")),
          row("Rescan installed apps", "After installing an app, so it groups and shows its icon.", h("button", { type: "button", class: "btn", onclick: () => invoke("reload_apps").then(() => toast("Installed apps read again.")) }, "Rescan"))),
      ));
    },
  };
}
