import { invoke, errText } from "../api.js";
import { store } from "../store.js";
import { patch, h, icon, copyText } from "../ui.js";
import * as f from "../fmt.js";

export default function systemPage() {
  let root, info = null, err = null, live = {};

  const kv = (pairs) => h("dl", { class: "kv" }, pairs.filter(([, v]) => v !== "" && v != null).flatMap(([k, v, mono]) => [h("dt", null, k), h("dd", { class: mono ? "measured" : null }, v)]));
  const panel = (title, ...kids) => h("section", { class: "panel", "aria-label": title }, h("div", { class: "panel-head" }, h("h2", null, title)), ...kids);

  async function load() {
    try { info = await invoke("system_info"); err = null; } catch (e) { err = errText(e); }
    render();
  }

  function asText() {
    if (!info) return "";
    const s = store.snap;
    const lines = [];
    for (const [k, v] of info.os) lines.push(`${k}: ${k === "Booted" ? new Date(+v * 1000).toISOString() : v}`);
    for (const [k, v] of info.hardware) lines.push(`${k}: ${v}`);
    const c = info.cpu;
    lines.push(`Processor: ${c.model}, ${c.cores} cores, ${c.threads} threads`);
    if (s) lines.push(`Memory: ${f.bytes(s.mem.total)}`);
    for (const [n, d] of info.gpus) lines.push(`Graphics: ${n} (${d})`);
    if (s) for (const d of s.disks) lines.push(`Disk ${d.name}: ${d.model} ${f.bytes(d.size)}`);
    return lines.join("\n");
  }

  function render() {
    if (err) { root.replaceChildren(h("div", { class: "state state--error" }, h("h3", null, "System facts could not be read"), h("p", null, err), h("button", { type: "button", class: "btn", onclick: load }, "Try again"))); return; }
    if (!info) { root.replaceChildren(h("div", { class: "skeleton" }, h("i"), h("i"), h("i"), h("i"))); return; }
    const s = store.snap;
    const os = Object.fromEntries(info.os);
    const c = info.cpu;
    live.uptime = h("span", { class: "measured" });
    live.sensors = h("ul", { class: "list" });
    live.psi = h("div", { class: "mini-rows" });
    live.mounts = h("ul", { class: "list" });
    root.replaceChildren(
      h("div", { class: "lead-row" },
        h("h2", null, os["Host name"] || "This computer"),
        h("p", null, `${os.Distribution || ""}, up `, live.uptime),
        h("span", { style: { flex: "1" } }),
        h("button", { type: "button", class: "btn", onclick: () => copyText(asText()) }, icon("copy"), "Copy summary")),
      h("div", { class: "panels sys" },
        panel("Operating system", kv(info.os.map(([k, v]) => [k, k === "Booted" ? f.dateTime(+v * 1000) : v, k === "Kernel"]))),
        panel("Hardware", info.hardware.length ? kv(info.hardware) : h("p", { class: "muted" }, "The firmware does not describe this machine.")),
        panel("Processor", kv([
          ["Model", c.model], ["Vendor", c.vendor], ["Layout", `${c.sockets} socket, ${c.cores} cores, ${c.threads} threads`],
          c.perf_cores.length ? ["Core types", `${c.perf_cores.length} performance (${c.perf_cores.join(" ")}), ${c.eff_cores.length} efficient`] : null,
          ["Speed", `${f.mhz(c.min_mhz)} to ${f.mhz(c.max_mhz)}${c.base_mhz ? `, base ${f.mhz(c.base_mhz)}` : ""}`],
          ...c.caches.map(([k, v]) => [`${k} cache`, f.bytes(v), true]),
          ["Virtualization", c.virtualization], ["Running in a VM", c.hypervisor ? "Yes" : "No"], ["Governor", c.governor], ["Energy preference", c.energy_pref], ["Microcode", c.microcode, true],
        ].filter(Boolean))),
        panel("Memory", kv([
          ["Installed", s ? f.bytes(s.mem.total) : ""],
          ...info.swaps.map(([name, type, size, used, prio]) => [`Swap ${type}`, `${name}, ${f.bytes(used)} of ${f.bytes(size)}, priority ${prio}`]),
          info.swaps.length ? null : ["Swap", "None"],
        ].filter(Boolean))),
        panel("Graphics", info.gpus.length ? kv(info.gpus.map(([n, d], i) => [`GPU ${i}`, `${n}, driver ${d}`])) : h("p", { class: "muted" }, "No graphics device reported.")),
        panel("Storage", kv((s?.disks || []).map((d) => [d.name, `${d.model || "Unknown model"}, ${f.bytes(d.size)}, ${d.rotational ? "hard disk" : "solid state"}, ${(info.disks.find((x) => x[0] === d.name) || [])[1] || ""}`])), live.mounts),
        panel("Network", kv([
          ...info.adapters.filter((a) => a.name !== "lo").map((a) => [a.name, `${a.connection || a.kind || ""}${a.addrs.length ? `\n${a.addrs.join("\n")}` : ""}`, true]),
          ["Default route", info.gateway, true], ["DNS servers", info.dns.join(", "), true],
        ])),
        info.battery.length ? panel("Battery", kv(info.battery)) : null,
        panel("Sensors", live.sensors),
        panel("Pressure", h("p", { class: "muted" }, "Share of the last ten seconds in which some task waited for each resource. Above a few percent, the machine is short of it."), live.psi),
      ),
    );
    update();
  }

  function update() {
    const s = store.snap;
    if (!s || !live.sensors) return;
    live.uptime.textContent = f.duration(s.cpu.uptime_s);
    patch(live.sensors, 
      ...s.temps.map((t) => h("li", null, h("span", null, `${t.chip} `, h("span", { class: "muted" }, t.label)), h("span", { class: "measured" }, `${f.temp(t.c)}${t.crit ? `, limit ${f.temp(t.crit)}` : ""}`))),
      ...s.fans.map((x) => h("li", null, h("span", null, `${x.chip} `, h("span", { class: "muted" }, x.label)), h("span", { class: "measured" }, `${x.rpm} rpm`))),
    );
    if (!s.temps.length && !s.fans.length) patch(live.sensors, h("li", null, h("span", { class: "muted" }, "No sensors exposed through hwmon."), h("span")));
    patch(live.mounts, ...s.mounts.map((m) => h("li", null, h("span", null, `${m.mount} `, h("span", { class: "muted" }, `${m.fs} on ${m.disk}`)), h("span", { class: "measured" }, `${f.bytes(m.avail)} free of ${f.bytes(m.total)}`))));
    if (s.psi) {
      const row = (l, v) => h("div", { class: "mini-row" }, h("span", { class: "lbl" }, l), h("div", { class: `meter${v > 10 ? " is-hot" : ""}` }, h("i", { style: { "--v": Math.min(1, v / 25).toFixed(3) } })), h("span", { class: "num" }, f.pct(v, 2)));
      patch(live.psi, row("Processor", s.psi.cpu_some), row("Memory", s.psi.mem_some), row("Memory, all", s.psi.mem_full), row("Disk IO", s.psi.io_some), row("Disk IO, all", s.psi.io_full));
    } else patch(live.psi, h("p", { class: "muted" }, "This kernel does not report pressure stall information."));
  }

  return {
    id: "system",
    title: "System",
    mount(r) { root = r; render(); load(); },
    update,
  };
}
