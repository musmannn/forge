// The process detail drawer: btop's info box grown into Task Manager's
// properties sheet.

import { invoke, errText } from "./api.js";
import { store, procRing, ring, windowSamples, cpuOf } from "./store.js";
import { h, icon, copyText } from "./ui.js";
import { trace } from "./chart.js";
import * as f from "./fmt.js";
import { appIcon } from "./procview.js";
import { endTask, suspendToggle, priorityDialog, affinityDialog, signalDialog, processMenu } from "./procactions.js";

let el, pid = null, tab = "general", details = null, canvas, facts, body, conns = null, prevFocus;

export function isOpen() {
  return pid != null;
}

export function currentPid() {
  return pid;
}

export function closeDrawer() {
  if (!el) return;
  el.classList.remove("is-open");
  el.setAttribute("aria-hidden", "true");
  pid = null;
  prevFocus?.focus?.();
}

export async function openDrawer(p) {
  if (!el) build();
  prevFocus = document.activeElement;
  pid = p;
  store.selected = p;
  details = null;
  conns = null;
  el.classList.add("is-open");
  el.removeAttribute("aria-hidden");
  render();
  el.querySelector(".drawer-head .btn").focus();
  load();
}

async function load() {
  const want = pid;
  try {
    const d = await invoke("process_details", { pid: want });
    if (want !== pid) return;
    details = d;
  } catch (e) {
    if (want !== pid) return;
    details = { error: errText(e) };
  }
  renderTab();
}

function build() {
  el = h("aside", { class: "drawer", "aria-label": "Process details", "aria-hidden": "true" });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeDrawer(); }
  });
  document.body.append(el);
}

function proc() {
  return store.procIndex.get(pid);
}

function render() {
  const p = proc() || { pid, name: `Process ${pid}`, user: "" };
  const src = appIcon(p.icon);
  canvas = h("canvas", { "aria-label": `CPU use of ${p.name} over time`, role: "img" });
  facts = h("dl", { class: "facts" });
  body = h("div", { style: { display: "grid", gap: "var(--space-md)" } });
  const tabs = [
    ["general", "General"], ["threads", "Threads"], ["files", "Open files"], ["env", "Environment"],
    ["memory", "Memory"], ["sockets", "Sockets"], ["limits", "Limits"], ["ns", "Namespaces"],
  ];
  const tabBar = h("div", { class: "tabs", role: "tablist" }, tabs.map(([k, l]) =>
    h("button", { type: "button", class: "tab", role: "tab", "aria-selected": String(tab === k), onclick: (e) => { tab = k; tabBar.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", "false")); e.currentTarget.setAttribute("aria-selected", "true"); renderTab(); } }, l)));
  el.replaceChildren(
    h("div", { class: "drawer-head" },
      src ? h("img", { class: "ico", src, alt: "", width: "24", height: "24" }) : null,
      h("h2", null, p.name, " ", h("span", { class: "muted measured", style: { fontSize: "var(--text-sm)" } }, String(pid))),
      h("button", { type: "button", class: "btn btn--quiet btn--icon", "aria-label": "Close details", onclick: closeDrawer }, icon("close"))),
    h("div", { class: "drawer-body" },
      h("div", null, h("div", { class: "trace" }, canvas), h("div", { class: "legend", style: { marginTop: "var(--space-2xs)" } }, h("span", null, h("i", { class: "swatch swatch--amber" }), "This process"), h("span", null, h("i", { class: "swatch swatch--muted" }), "Whole machine"))),
      facts, tabBar, body),
    h("div", { class: "drawer-actions" },
      h("button", { type: "button", class: "btn", onclick: () => proc() && endTask(proc()) }, "End task"),
      h("button", { type: "button", class: "btn", onclick: () => proc() && suspendToggle(proc()) }, p.state === "T" ? "Resume" : "Suspend"),
      h("button", { type: "button", class: "btn", onclick: () => proc() && priorityDialog(proc()) }, "Priority"),
      h("button", { type: "button", class: "btn", onclick: () => proc() && affinityDialog(proc()) }, "Affinity"),
      h("button", { type: "button", class: "btn", onclick: () => proc() && signalDialog(proc()) }, "Signal"),
      h("button", { type: "button", class: "btn btn--quiet btn--icon", "aria-label": "More actions", onclick: (e) => { const b = e.currentTarget.getBoundingClientRect(); proc() && processMenu(proc(), b.left - 180, b.top - 360, e.currentTarget); } }, icon("more"))),
  );
  update();
  renderTab();
}

export function update() {
  if (pid == null || !el) return;
  const p = proc();
  const n = windowSamples();
  if (canvas) {
    const series = [{ data: ring("cpu").last(n), colour: "muted", fill: false, width: 1, alpha: 0.8 }];
    if (p) series.push({ data: procRing(pid).cpu.last(n).map((v) => (store.settings.cpuMode === "core" ? v * (store.snap?.ncpu || 1) : v)), colour: "accent" });
    trace(canvas, series, { samples: n, max: store.settings.cpuMode === "core" ? 100 * (store.snap?.ncpu || 1) : 100 });
  }
  if (!facts) return;
  if (!p) {
    facts.replaceChildren(h("div", null, h("dt", null, "State"), h("dd", { class: "text" }, "Exited")));
    return;
  }
  const row = (k, v, text) => h("div", null, h("dt", null, k), h("dd", { class: text ? "text" : null, title: String(v) }, v));
  facts.replaceChildren(
    row("CPU", f.pct(cpuOf(p), 1)),
    row("Memory", f.bytes(p.mem_private || p.mem)),
    row("Resident", f.bytes(p.mem)),
    row("Swap", f.bytes(p.swap)),
    row("Disk read", f.rate(p.read_bps)),
    row("Disk write", f.rate(p.write_bps)),
    row("GPU", p.gpu != null ? f.pct(p.gpu, 1) : "None"),
    row("Threads", f.int(p.threads)),
    row("State", f.STATE[p.state] || p.state, true),
    row("Priority", `${f.priorityName(p.nice, p.policy)}, ${p.nice}`, true),
    row("User", p.user, true),
    row("Started", f.since(p.start_s)),
    row("CPU time", f.cpuTime(p.cpu_time_s)),
    row("Last core", String(p.last_cpu)),
    p.container ? row("Sandbox", p.container, true) : null,
    p.unit ? row("Unit", p.unit, true) : null,
  );
}

function kv(pairs) {
  return h("dl", { class: "kv" }, pairs.filter(([, v]) => v !== "" && v != null).flatMap(([k, v, mono]) => [h("dt", null, k), h("dd", { class: mono ? "measured" : null }, v)]));
}

async function renderTab() {
  if (!body) return;
  if (!details) {
    body.replaceChildren(h("div", { class: "skeleton", style: { padding: "0" } }, h("i"), h("i"), h("i")));
    return;
  }
  if (details.error) {
    body.replaceChildren(h("div", { class: "state state--error", style: { padding: "0" } }, h("h3", null, "Forge could not read this process"), h("p", null, details.error)));
    return;
  }
  const d = details;
  const refresh = h("button", { type: "button", class: "btn btn--quiet", onclick: () => { details = null; conns = null; renderTab(); load(); } }, icon("refresh"), "Read again");
  let content;
  switch (tab) {
    case "general":
      content = [
        h("div", { style: { display: "flex", gap: "var(--space-xs)" } }, h("button", { type: "button", class: "btn", onclick: () => copyText(d.argv.join(" ")) }, icon("copy"), "Copy command"), refresh),
        h("pre", { class: "codebox" }, d.argv.length ? d.argv.join(" ") : `[${d.name}]`),
        kv([
          ["Program", d.exe, true], ["Working folder", d.cwd, true], ["Root", d.root !== "/" ? d.root : "", true],
          ["Parent", `${d.parent_name} (${d.ppid})`], ["State", d.state], ["Scheduling", d.policy], ["Nice", String(d.nice)],
          ["OOM score", d.oom_score != null ? `${d.oom_score} (adjust ${d.oom_adj})` : ""],
          ["Allowed processors", compactList(d.affinity), true], ["Waiting in", d.wchan, true],
          ["Context switches", `${f.int(d.ctx_voluntary)} voluntary, ${f.int(d.ctx_involuntary)} forced`],
          ["Control group", d.cgroup, true], ["User and group ids", `${d.uid} / ${d.gid}`, true],
          ["Seccomp", d.seccomp], ["Effective capabilities", d.capabilities, true],
        ]),
      ];
      break;
    case "threads":
      content = [h("p", { class: "muted" }, `${d.threads.length} threads, busiest first.`), h("ul", { class: "list" }, d.threads.map((t) => h("li", null, h("span", null, `${t.name} `, h("span", { class: "measured" }, `${t.tid}`)), h("span", { class: "measured" }, `${f.cpuTime(t.cpu_time_s)}  cpu ${t.last_cpu}  ${t.state}`))))];
      break;
    case "files":
      content = [h("p", { class: "muted" }, `${d.fd_count} open descriptors${d.fd_count > d.fds.length ? `, first ${d.fds.length} shown` : ""}.`),
        d.fds.length ? h("ul", { class: "list" }, d.fds.map((x) => h("li", null, h("span", { title: x.target }, x.target), h("span", { class: "measured" }, String(x.fd))))) : h("p", { class: "muted" }, "Forge cannot list this process's files without administrator rights.")];
      break;
    case "env":
      content = d.env_readable && d.env.length
        ? [h("button", { type: "button", class: "btn", style: { justifySelf: "start" }, onclick: () => copyText(d.env.join("\n")) }, icon("copy"), "Copy all"), h("pre", { class: "codebox" }, d.env.join("\n"))]
        : [h("p", { class: "muted" }, "The kernel only shows a process's environment to its owner.")];
      break;
    case "memory":
      content = [kv(d.memory.map(([k, v]) => [memLabel(k), f.bytes(v), true])), h("h3", null, "Largest mapped files"), h("p", { class: "muted" }, `${f.int(d.map_count)} mappings in all.`), h("ul", { class: "list" }, d.maps.slice(0, 60).map(([p, s]) => h("li", null, h("span", { title: p }, p), h("span", { class: "measured" }, f.bytes(s)))))];
      break;
    case "sockets": {
      if (!conns) {
        body.replaceChildren(h("div", { class: "skeleton", style: { padding: "0" } }, h("i"), h("i")));
        try { conns = (await invoke("list_connections")).filter((c) => c.pid === pid); } catch { conns = []; }
        if (tab !== "sockets") return;
      }
      content = conns.length
        ? h("ul", { class: "list" }, conns.map((c) => h("li", null, h("span", { class: "measured" }, `${c.proto} ${c.local}:${c.local_port}${c.remote_port ? ` to ${c.remote}:${c.remote_port}` : ""}`), h("span", null, c.state))))
        : h("p", { class: "muted" }, "No network sockets open.");
      break;
    }
    case "limits":
      content = h("ul", { class: "list" }, d.limits.map(([n, s, hh]) => h("li", null, h("span", null, n), h("span", { class: "measured" }, s === hh ? s : `${s} soft, ${hh} hard`))));
      break;
    case "ns":
      content = kv(d.namespaces.map(([k, v]) => [k, v, true]));
      break;
  }
  body.replaceChildren(...[content].flat());
}

function memLabel(k) {
  return {
    VmPeak: "Peak virtual", VmSize: "Virtual", VmHWM: "Peak resident", VmRSS: "Resident", RssAnon: "Private (anonymous)",
    RssFile: "File backed", RssShmem: "Shared memory", VmData: "Data", VmStk: "Stack", VmExe: "Program code", VmLib: "Libraries",
    VmPTE: "Page tables", VmSwap: "Swapped out", Pss: "Proportional share", Shared_Clean: "Shared clean", Shared_Dirty: "Shared dirty",
    Private_Clean: "Private clean", Private_Dirty: "Private dirty",
  }[k] || k;
}

function compactList(a) {
  if (!a || !a.length) return "";
  const out = [];
  let s = a[0], p = a[0];
  for (let i = 1; i <= a.length; i++) {
    if (a[i] === p + 1) { p = a[i]; continue; }
    out.push(s === p ? `${s}` : `${s}-${p}`);
    s = p = a[i];
  }
  return out.join(", ");
}
