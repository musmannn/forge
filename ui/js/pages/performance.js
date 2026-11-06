import { store, ring, saveSettings, windowSamples } from "../store.js";
import { patch, h } from "../ui.js";
import { trace, niceMax } from "../chart.js";
import { invoke } from "../api.js";
import * as f from "../fmt.js";

export function adapterKind(n) {
  if (n.wireless || n.name.startsWith("wl")) return "Wi-Fi";
  if (n.name.startsWith("ww")) return "Mobile broadband";
  if (n.virtual_if) return n.name.startsWith("tun") || n.name.startsWith("wg") || n.name.startsWith("tailscale") ? "VPN" : "Virtual";
  if (n.name.startsWith("en") || n.name.startsWith("eth")) return "Ethernet";
  return "Adapter";
}

const WINDOWS = [[60, "1 min"], [300, "5 min"], [1800, "30 min"], [3600, "1 hour"]];

export default function performancePage() {
  let root, list, mainEl, current = "cpu", items = [], view = {}, sys = null, keyOrder = [];

  function devices() {
    const s = store.snap;
    const out = [{ key: "cpu", name: "Processor", sub: () => `${f.pct(s.cpu.total)}  ${f.mhz(s.cpu.avg_freq_mhz)}`, data: () => ring("cpu"), max: 100 }];
    out.push({ key: "mem", name: "Memory", sub: () => `${f.bytes(s.mem.in_use)} of ${f.bytes(s.mem.total)}`, data: () => ring("mem"), max: 100 });
    s.disks.forEach((d) => out.push({ key: `disk:${d.name}`, name: `Disk ${d.name}`, sub: () => { const x = s.disks.find((y) => y.name === d.name); return x ? `${d.rotational ? "HDD" : "SSD"}  ${f.pct(x.active_pct)}` : ""; }, data: () => ring(`disk.${d.name}`), max: 100 }));
    s.net
      .filter((n) => n.name !== "lo" && (store.settings.showVirtualNet || !n.virtual_if) && (n.up || n.rx_total + n.tx_total > 0))
      .forEach((n) => out.push({ key: `net:${n.name}`, name: `${adapterKind(n)} ${n.name}`, sub: () => { const x = s.net.find((y) => y.name === n.name); return x ? `Down ${f.bits(x.rx_bps)}  Up ${f.bits(x.tx_bps)}` : ""; }, data: () => ring(`net.${n.name}.rx`), auto: true }));
    s.gpus.forEach((g, i) => out.push({ key: `gpu:${i}`, name: `GPU ${i}`, sub: () => `${(g.name || "").replace(/\[|\]/g, "").slice(0, 26)}  ${s.gpus[i]?.busy_pct != null ? f.pct(s.gpus[i].busy_pct) : ""}`, data: () => ring(`gpu.${i}`), max: 100 }));
    if (s.battery) out.push({ key: "bat", name: "Battery", sub: () => `${f.pct(s.battery.pct)}  ${s.battery.status.toLowerCase()}`, data: () => ring("bat"), max: 100 });
    return out;
  }

  function buildList() {
    items = devices();
    keyOrder = items.map((d) => d.key);
    if (!keyOrder.includes(current)) current = "cpu";
    list.replaceChildren(
      ...items.map((d) => {
        const c = h("canvas", { "aria-hidden": "true" });
        d.canvas = c;
        d.subEl = h("span");
        d.btn = h("button", { type: "button", class: "perf-item", "aria-current": String(d.key === current), onclick: () => select(d.key) }, h("div", { class: "trace" }, c), h("div", { style: { minWidth: "0" } }, h("b", null, d.name), d.subEl));
        return d.btn;
      }),
    );
  }

  function select(key) {
    current = key;
    items.forEach((d) => d.btn.setAttribute("aria-current", String(d.key === key)));
    buildMain();
    update();
  }

  const fact = (k, v, text) => h("div", null, h("dt", null, k), h("dd", { class: text ? "text" : null, title: String(v ?? "") }, v ?? ""));
  const caption = (l, r) => h("div", { class: "trace-caption" }, h("span", null, l), h("span", null, r));
  const winLabel = () => WINDOWS.find((w) => w[0] === store.settings.windowSecs)?.[1] || `${store.settings.windowSecs} s`;

  function head(title, model, extra) {
    return h("div", { class: "perf-title" }, h("h2", null, title), extra || null, h("span", { class: "model" }, model || ""));
  }

  function windowSeg() {
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Time shown" },
      WINDOWS.map(([s, l]) => h("button", { type: "button", "aria-pressed": String(store.settings.windowSecs === s), onclick: () => { saveSettings({ windowSecs: s }); buildMain(); update(); } }, l)));
    return seg;
  }

  function buildMain() {
    view = { key: current };
    const s = store.snap;
    const big = () => { const c = h("canvas", { role: "img", "aria-label": "Use over time" }); return [h("div", { class: "trace big-trace" }, c), c]; };
    if (current === "cpu") {
      const info = store.cpuInfo || {};
      const mode = store.settings.perfCpuView;
      const hybrid = (info.perf_cores || []).length && (info.eff_cores || []).length;
      const seg = h("div", { class: "seg", role: "group", "aria-label": "Graph" },
        [["overall", "Overall"], ["logical", "Logical processors"], ...(hybrid ? [["types", "Core types"]] : [])].map(([k, l]) =>
          h("button", { type: "button", "aria-pressed": String(mode === k), onclick: () => { saveSettings({ perfCpuView: k }); buildMain(); update(); } }, l)));
      let graph;
      if (mode === "logical") {
        const cols = Math.ceil(Math.sqrt(s.cpu.cores.length * 1.6));
        view.cores = s.cpu.cores.map((_, i) => h("canvas", { role: "img", "aria-label": `Logical processor ${i}` }));
        graph = h("div", { class: "cores-grid", style: { "--cols": cols } }, view.cores.map((c, i) => h("div", { class: "trace" }, h("span", { class: "cap" }, `${i}${(info.perf_cores || []).includes(i) ? " P" : (info.eff_cores || []).includes(i) ? " E" : ""}`), c)));
      } else if (mode === "types") {
        view.pc = h("canvas", { role: "img", "aria-label": "Performance cores" });
        view.ec = h("canvas", { role: "img", "aria-label": "Efficient cores" });
        graph = h("div", { class: "duo" }, h("div", null, h("div", { class: "trace" }, view.pc), caption(`Performance cores, ${info.perf_cores.length}`, "100%")), h("div", null, h("div", { class: "trace" }, view.ec), caption(`Efficient cores, ${info.eff_cores.length}`, "100%")));
      } else {
        const [t, c] = big();
        view.big = c;
        graph = h("div", null, t, caption(`Use over ${winLabel()}`, "100%"));
      }
      view.live = h("dl", { class: "facts facts--big" });
      const caches = (info.caches || []).map(([k, v]) => fact(`${k} cache`, f.bytes(v)));
      mainEl.replaceChildren(
        head("Processor", info.model),
        h("div", { style: { display: "flex", gap: "var(--space-sm)", flexWrap: "wrap" } }, seg, windowSeg()),
        graph,
        view.live,
        h("dl", { class: "facts" },
          fact("Base speed", f.mhz(info.base_mhz)), fact("Maximum speed", f.mhz(info.max_mhz)), fact("Minimum speed", f.mhz(info.min_mhz)),
          fact("Sockets", info.sockets), fact("Cores", info.cores), fact("Logical processors", info.threads),
          hybrid ? fact("Core types", `${info.perf_cores.length} performance, ${info.eff_cores.length} efficient`, true) : null,
          fact("Virtualization", info.virtualization, true), fact("Running in a VM", info.hypervisor ? "Yes" : "No", true),
          ...caches, fact("Governor", info.governor, true), fact("Energy preference", info.energy_pref, true), fact("Microcode", info.microcode)),
      );
    } else if (current === "mem") {
      const [t, c] = big();
      view.big = c;
      view.bar = h("div", { class: "stackbar", role: "img", "aria-label": "Memory composition" });
      view.barLegend = h("div", { class: "legend" });
      view.live = h("dl", { class: "facts facts--big" });
      view.more = h("dl", { class: "facts" });
      mainEl.replaceChildren(head("Memory", `${f.bytes(s.mem.total)} installed`), windowSeg(), h("div", null, t, caption(`Memory in use over ${winLabel()}`, f.bytes(s.mem.total))),
        h("div", { style: { display: "grid", gap: "var(--space-xs)" } }, h("h3", null, "Memory composition"), view.bar, view.barLegend), view.live, view.more);
    } else if (current.startsWith("disk:")) {
      const name = current.slice(5);
      const d = s.disks.find((x) => x.name === name) || {};
      view.a = h("canvas", { role: "img", "aria-label": "Active time" });
      view.b = h("canvas", { role: "img", "aria-label": "Transfer rate, reads above the line and writes below" });
      view.bmax = h("span");
      view.live = h("dl", { class: "facts facts--big" });
      view.more = h("dl", { class: "facts" });
      view.mounts = h("ul", { class: "list" });
      mainEl.replaceChildren(head(`Disk ${name}`, d.model), windowSeg(),
        h("div", { class: "duo" }, h("div", null, h("div", { class: "trace" }, view.a), caption("Active time", "100%")), h("div", null, h("div", { class: "trace" }, view.b), caption("Read above, write below", view.bmax))),
        view.live, view.more, h("h3", null, "Volumes on this disk"), view.mounts);
    } else if (current.startsWith("net:")) {
      const name = current.slice(4);
      const n = s.net.find((x) => x.name === name) || {};
      const [t, c] = big();
      view.big = c;
      view.max = h("span");
      view.live = h("dl", { class: "facts facts--big" });
      view.more = h("dl", { class: "facts" });
      const ad = sys?.adapters.find((a) => a.name === name);
      mainEl.replaceChildren(head(adapterKind(n), name), windowSeg(),
        h("div", null, t, caption(`Receive above, send below, over ${winLabel()}`, view.max)), view.live, view.more,
        ad ? h("dl", { class: "kv" }, h("dt", null, "Addresses"), h("dd", { class: "measured" }, ad.addrs.join("\n") || "None"), ad.connection ? [h("dt", null, "Connection"), h("dd", null, ad.connection)] : null, ad.driver ? [h("dt", null, "Driver"), h("dd", { class: "measured" }, ad.driver)] : null, h("dt", null, "MTU"), h("dd", { class: "measured" }, String(ad.mtu))) : null);
    } else if (current.startsWith("gpu:")) {
      const i = +current.slice(4);
      const g = s.gpus[i] || {};
      const [t, c] = big();
      view.big = c;
      view.engines = g.engines.map(([e]) => [e, h("canvas", { role: "img", "aria-label": `${e} engine` })]);
      view.live = h("dl", { class: "facts facts--big" });
      view.more = h("dl", { class: "facts" });
      mainEl.replaceChildren(head(`GPU ${i}`, g.name), windowSeg(), h("div", null, t, caption(`Busy over ${winLabel()}, from ${g.source || "the driver"}`, "100%")),
        view.engines.length ? h("div", { class: "duo" }, view.engines.map(([e, cv]) => h("div", null, h("div", { class: "trace" }, cv), caption(e, "100%")))) : null,
        view.live, view.more);
    } else if (current === "bat") {
      const [t, c] = big();
      view.big = c;
      view.live = h("dl", { class: "facts facts--big" });
      view.more = h("dl", { class: "facts" });
      mainEl.replaceChildren(head("Battery", (sys?.battery || []).map((x) => x[1]).join(" ")), windowSeg(), h("div", null, t, caption(`Charge over ${winLabel()}`, "100%")), view.live, view.more);
    }
  }

  function update() {
    const s = store.snap;
    if (!s) return;
    if (!items.length || devices().length !== items.length) { buildList(); buildMain(); }
    const n = windowSamples();
    for (const d of items) {
      const data = d.data().last(60);
      trace(d.canvas, [{ data, colour: "cool", width: 1 }], { samples: 60, max: d.auto ? niceMax(Math.max(...data, 1)) : d.max, grid: 0 });
      d.subEl.textContent = d.sub();
    }
    if (current === "cpu") {
      const c = s.cpu;
      if (view.big) trace(view.big, [{ data: ring("cpu").last(n), colour: "cool" }, { data: ring("cpu.sys").last(n), colour: "cool", fill: false, width: 1, alpha: 0.5 }], { samples: n, max: 100, grid: 9 });
      if (view.cores) view.cores.forEach((cv, i) => trace(cv, [{ data: ring(`core.${i}`).last(n), colour: "cool", width: 1 }], { samples: n, max: 100, grid: 1 }));
      if (view.pc) {
        const info = store.cpuInfo;
        const avg = (set) => { const rs = set.map((i) => ring(`core.${i}`).last(n)); return rs[0].map((_, k) => rs.reduce((a, r) => a + (r[k] || 0), 0) / rs.length); };
        trace(view.pc, [{ data: avg(info.perf_cores), colour: "cool" }], { samples: n, max: 100 });
        trace(view.ec, [{ data: avg(info.eff_cores), colour: "cool" }], { samples: n, max: 100 });
      }
      patch(view.live, fact("Use", f.pct(c.total)), fact("Speed", f.mhz(c.avg_freq_mhz)), fact("Processes", f.int(c.procs)), fact("Threads", f.int(c.threads)), fact("Open files", f.int(c.fds)), fact("Up time", f.duration(c.uptime_s)), fact("Temperature", f.temp(c.temp_c) || "Not reported"), fact("Load average", c.load.map((x) => x.toFixed(2)).join(" ")));
    } else if (current === "mem") {
      const m = s.mem;
      trace(view.big, [{ data: ring("mem").last(n), colour: "cool" }], { samples: n, max: 100, grid: 3 });
      patch(view.bar, h("i", { class: "s1", style: { "--v": m.in_use } }), h("i", { class: "s2", style: { "--v": m.modified } }), h("i", { class: "s3", style: { "--v": m.standby } }), h("i", { class: "s4", style: { "--v": m.free } }));
      patch(view.barLegend, 
        h("span", null, h("i", { class: "swatch" }), "In use ", h("b", null, f.bytes(m.in_use))),
        h("span", null, h("i", { class: "swatch swatch--2" }), "Modified ", h("b", null, f.bytes(m.modified))),
        h("span", null, h("i", { class: "swatch swatch--muted" }), "Cached ", h("b", null, f.bytes(m.standby))),
        h("span", null, "Free ", h("b", null, f.bytes(m.free))));
      patch(view.live, fact("In use", f.bytes(m.in_use)), fact("Available", f.bytes(m.available)), fact("Committed", `${f.bytes(m.committed)} / ${f.bytes(m.commit_limit)}`), fact("Cached", f.bytes(m.cached)), fact("Swap", m.swap_total ? `${f.bytes(m.swap_used)} / ${f.bytes(m.swap_total)}` : "None"));
      patch(view.more, fact("Buffers", f.bytes(m.buffers)), fact("Shared", f.bytes(m.shared)), fact("Kernel slab", f.bytes(m.slab)), fact("Page tables", f.bytes(m.page_tables)), fact("Kernel stacks", f.bytes(m.kernel_stack)), fact("Swap cached", f.bytes(m.swap_cached)), m.zswap ? fact("Compressed in zswap", f.bytes(m.zswap)) : null, m.hugepages_total ? fact("Huge pages", f.bytes(m.hugepages_total)) : null, s.psi ? fact("Stalled on memory", f.pct(s.psi.mem_some, 1)) : null);
    } else if (current.startsWith("disk:")) {
      const name = current.slice(5);
      const d = s.disks.find((x) => x.name === name);
      if (!d) return;
      trace(view.a, [{ data: ring(`disk.${name}`).last(n), colour: "cool" }], { samples: n, max: 100 });
      const r = ring(`disk.${name}.r`), w = ring(`disk.${name}.w`);
      const mx = niceMax(Math.max(r.max(n), w.max(n)));
      view.bmax.textContent = f.rate(mx);
      trace(view.b, [{ data: r.last(n), colour: "cool" }, { data: w.last(n), colour: "cool", mirror: true, alpha: 0.6 }], { samples: n, max: mx, mirror: true, grid: 0 });
      const mounts = s.mounts.filter((m) => m.disk === name);
      patch(view.live, fact("Active time", f.pct(d.active_pct)), fact("Average response", `${d.avg_ms.toFixed(1)}\u00a0ms`), fact("Read speed", f.rate(d.read_bps)), fact("Write speed", f.rate(d.write_bps)));
      patch(view.more, fact("Capacity", f.bytes(d.size)), fact("Formatted", f.bytes(mounts.reduce((a, m) => a + m.total, 0))), fact("System disk", mounts.some((m) => m.mount === "/") ? "Yes" : "No", true), fact("Type", d.rotational ? "Hard disk" : "Solid state", true), fact("Removable", d.removable ? "Yes" : "No", true), fact("In the queue", String(d.queue)), fact("Read since boot", f.bytes(d.read_total)), fact("Written since boot", f.bytes(d.write_total)), sys ? fact("Connection", (sys.disks.find((x) => x[0] === name) || [])[1] || "", true) : null);
      patch(view.mounts, ...(mounts.length ? mounts.map((m) => h("li", null, h("span", null, `${m.mount} `, h("span", { class: "muted" }, `${m.fs}, ${m.dev}`)), h("span", { class: "measured" }, `${f.bytes(m.used)} used of ${f.bytes(m.total)}`))) : [h("li", null, h("span", { class: "muted" }, "No mounted volumes."), h("span"))]));
    } else if (current.startsWith("net:")) {
      const name = current.slice(4);
      const x = s.net.find((y) => y.name === name);
      if (!x) return;
      const r = ring(`net.${name}.rx`), t = ring(`net.${name}.tx`);
      const mx = niceMax(Math.max(r.max(n), t.max(n)));
      view.max.textContent = f.bits(mx);
      trace(view.big, [{ data: r.last(n), colour: "cool" }, { data: t.last(n), colour: "cool", mirror: true, alpha: 0.6 }], { samples: n, max: mx, mirror: true, grid: 0 });
      patch(view.live, fact("Receive", f.bits(x.rx_bps)), fact("Send", f.bits(x.tx_bps)), fact("Received", f.bytes(x.rx_total)), fact("Sent", f.bytes(x.tx_total)));
      patch(view.more, fact("State", x.up ? "Connected" : "Down", true), fact("Link speed", x.speed_mbps ? `${x.speed_mbps}\u00a0Mbps` : "Not reported"), fact("Hardware address", x.mac), fact("Packets in", f.int(x.rx_packets)), fact("Packets out", f.int(x.tx_packets)), fact("Errors", f.int(x.errors)), fact("Dropped", f.int(x.drops)));
    } else if (current.startsWith("gpu:")) {
      const i = +current.slice(4);
      const g = s.gpus[i];
      if (!g) return;
      trace(view.big, [{ data: ring(`gpu.${i}`).last(n), colour: "cool" }], { samples: n, max: 100, grid: 3 });
      view.engines.forEach(([e, cv]) => trace(cv, [{ data: ring(`gpu.${i}.${e}`).last(n), colour: "cool" }], { samples: n, max: 100, grid: 1 }));
      const using = s.procs.filter((p) => p.gpu != null && p.gpu > 0.05).sort((a, b) => b.gpu - a.gpu).slice(0, 3).map((p) => p.name).join(", ");
      patch(view.live, fact("Busy", g.busy_pct != null ? f.pct(g.busy_pct) : "Not reported"), fact("Clock", g.freq_mhz ? f.mhz(g.freq_mhz) : "Idle"), g.vram_total ? fact("Video memory", `${f.bytes(g.vram_used)} / ${f.bytes(g.vram_total)}`) : fact("Video memory", "Shared with the system", true), fact("Temperature", f.temp(g.temp_c) || "Not reported"));
      patch(view.more, fact("Driver", g.driver), fact("PCI slot", g.slot), fact("Maximum clock", f.mhz(g.max_freq_mhz)), g.power_w ? fact("Power", `${g.power_w.toFixed(1)}\u00a0W`) : null, fact("Busiest now", using || "Nothing measurable", true));
    } else if (current === "bat") {
      const b = s.battery;
      if (!b) return;
      trace(view.big, [{ data: ring("bat").last(n), colour: "cool" }], { samples: n, max: 100, grid: 3 });
      patch(view.live, fact("Charge", f.pct(b.pct)), fact("Status", b.status, true), fact("Power draw", b.power_w ? `${b.power_w.toFixed(1)}\u00a0W` : "Not reported"), fact(b.status === "Charging" ? "Full in" : "Time left", b.secs_left ? f.duration(b.secs_left) : "Not reported"));
      patch(view.more, fact("Health", b.health_pct ? f.pct(b.health_pct) : "Not reported"), fact("Charge cycles", b.cycles ?? "Not reported"), fact("Mains power", b.ac_online ? "Connected" : "Unplugged", true), ...(sys?.battery || []).map(([k, v]) => fact(k, v, true)));
    }
  }

  return {
    id: "performance",
    title: "Performance",
    flush: true,
    mount(r) {
      root = r;
      if (this.params?.device) current = this.params.device;
      list = h("nav", { class: "perf-list", "aria-label": "Devices" });
      mainEl = h("div", { class: "perf-main" });
      root.append(h("div", { class: "perf" }, list, mainEl));
      if (!store.snap) { mainEl.append(h("div", { class: "skeleton" }, h("i"), h("i"), h("i"))); return; }
      buildList();
      buildMain();
      update();
      invoke("system_info").then((x) => { sys = x; if (current.startsWith("net:") || current === "bat" || current.startsWith("disk:")) { buildMain(); update(); } }).catch(() => {});
    },
    update,
    settings() { buildList(); buildMain(); update(); },
    keys(e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "j" || e.key === "k") {
        const i = keyOrder.indexOf(current);
        const d = e.key === "ArrowDown" || e.key === "j" ? 1 : -1;
        select(keyOrder[(i + d + keyOrder.length) % keyOrder.length]);
        items.find((x) => x.key === current)?.btn.focus();
        return true;
      }
      return false;
    },
  };
}
