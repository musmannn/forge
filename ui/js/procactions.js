// Everything you can do to a process, shared by every page that lists them.

import { invoke, needsRoot, errText } from "./api.js";
import { store, procRing } from "./store.js";
import { h, menu, dialog, toast, confirmDialog, copyText } from "./ui.js";
import { priorityName } from "./fmt.js";

export const hooks = { openDetails: null, go: null };

export const SIGNALS = [
  [1, "SIGHUP", "Hang up, many daemons reload their settings"],
  [2, "SIGINT", "Interrupt, as Ctrl+C in a terminal"],
  [3, "SIGQUIT", "Quit and dump core"],
  [4, "SIGILL", "Illegal instruction"],
  [5, "SIGTRAP", "Trace or breakpoint trap"],
  [6, "SIGABRT", "Abort"],
  [7, "SIGBUS", "Bus error"],
  [8, "SIGFPE", "Floating point exception"],
  [9, "SIGKILL", "Kill at once, cannot be caught"],
  [10, "SIGUSR1", "User defined 1"],
  [11, "SIGSEGV", "Segmentation fault"],
  [12, "SIGUSR2", "User defined 2"],
  [13, "SIGPIPE", "Broken pipe"],
  [14, "SIGALRM", "Timer"],
  [15, "SIGTERM", "Ask to end, the polite default"],
  [16, "SIGSTKFLT", "Stack fault"],
  [17, "SIGCHLD", "Child changed state"],
  [18, "SIGCONT", "Continue a suspended process"],
  [19, "SIGSTOP", "Suspend, cannot be caught"],
  [20, "SIGTSTP", "Suspend, as Ctrl+Z"],
  [21, "SIGTTIN", "Background read from terminal"],
  [22, "SIGTTOU", "Background write to terminal"],
  [23, "SIGURG", "Urgent socket data"],
  [24, "SIGXCPU", "CPU time limit exceeded"],
  [25, "SIGXFSZ", "File size limit exceeded"],
  [26, "SIGVTALRM", "Virtual timer"],
  [27, "SIGPROF", "Profiling timer"],
  [28, "SIGWINCH", "Window resized"],
  [29, "SIGIO", "I/O possible"],
  [30, "SIGPWR", "Power failure"],
  [31, "SIGSYS", "Bad system call"],
];

export const PRIORITIES = [
  ["Realtime", -20, "Ahead of nearly everything. Needs administrator rights."],
  ["High", -10, "Needs administrator rights."],
  ["Above normal", -5, "Needs administrator rights."],
  ["Normal", 0, "The default for programs you start."],
  ["Below normal", 5, ""],
  ["Low", 19, "Runs when the processor has time to spare."],
];

/** Run an action; if the kernel refuses, offer the same action through pkexec. */
export async function act(label, fn, okMessage) {
  try {
    const r = await fn(false);
    if (okMessage) toast(typeof okMessage === "function" ? okMessage(r) : okMessage);
    return r;
  } catch (e) {
    if (needsRoot(e)) {
      toast(`${label} needs administrator rights.`, {
        bad: true,
        action: {
          label: "Retry as administrator",
          run: async () => {
            try {
              const r = await fn(true);
              if (okMessage) toast(typeof okMessage === "function" ? okMessage(r) : okMessage);
            } catch (e2) {
              toast(`${label} failed: ${errText(e2)}`, { bad: true });
            }
          },
        },
      });
    } else {
      toast(`${label} failed: ${errText(e)}`, { bad: true });
    }
    return undefined;
  }
}

const label = (p) => p.app && p.kind === "app" ? p.app : p.name;

export async function endTask(p, kill = false) {
  if (store.settings.confirmEnd) {
    const ok = await confirmDialog(
      kill ? `Kill ${label(p)}?` : `End ${label(p)}?`,
      kill
        ? `Process ${p.pid} stops at once. Anything it has not saved is lost.`
        : `Forge asks process ${p.pid} to close (SIGTERM). Unsaved work in it may be lost.`,
      kill ? "Kill" : "End task",
      true,
    );
    if (!ok) return;
  }
  act(kill ? "Killing the process" : "Ending the task", (el) => invoke("signal_process", { pid: p.pid, sig: kill ? 9 : 15, elevated: el }));
}

export async function endTree(p) {
  const ok = !store.settings.confirmEnd || (await confirmDialog(`End ${label(p)} and its children?`, `Every process started by ${p.pid} gets SIGTERM, children first.`, "End process tree", true));
  if (!ok) return;
  act("Ending the process tree", (el) => invoke("signal_tree", { pid: p.pid, sig: 15, elevated: el }));
}

export function suspendToggle(p) {
  const stopped = p.state === "T";
  act(stopped ? "Resuming" : "Suspending", (el) => invoke("signal_process", { pid: p.pid, sig: stopped ? 18 : 19, elevated: el }));
}

export function efficiencyToggle(p) {
  const on = p.policy !== 5;
  act("Changing efficiency mode", (el) => invoke("set_efficiency", { pid: p.pid, on, elevated: el }));
}

export function signalDialog(p) {
  let chosen = 15;
  const list = h("div", { class: "list", role: "radiogroup", "aria-label": "Signals", style: { maxHeight: "22rem", overflowY: "auto" } });
  for (const [n, name, what] of SIGNALS) {
    list.append(
      h(
        "label",
        { class: "check", style: { padding: "var(--space-2xs) 0", borderBottom: "var(--rule-hair) solid var(--color-rule)", display: "flex" } },
        h("input", { type: "radio", name: "sig", value: String(n), checked: n === 15, onchange: () => (chosen = n) }),
        h("span", { class: "measured", style: { width: "6.5rem" } }, `${n} ${name}`),
        h("span", { class: "muted" }, what),
      ),
    );
  }
  dialog({
    title: `Send a signal to ${label(p)}`,
    text: `Process ${p.pid}, owned by ${p.user}.`,
    body: list,
    actions: [
      { label: "Cancel" },
      { label: "Send signal", primary: true, run: () => { act("Sending the signal", (el) => invoke("signal_process", { pid: p.pid, sig: chosen, elevated: el })); } },
    ],
  });
}

export function priorityDialog(p) {
  let nice = p.nice;
  const out = h("output", { class: "measured" }, String(nice));
  const slider = h("input", { type: "range", min: "-20", max: "19", value: String(nice), "aria-label": "Nice value", style: { width: "100%", accentColor: "var(--color-accent)" }, oninput: (e) => { nice = +e.target.value; out.textContent = String(nice); sync(); } });
  const radios = PRIORITIES.map(([name, v, note]) =>
    h("label", { class: "check" }, h("input", { type: "radio", name: "prio", value: String(v), checked: priorityName(p.nice, 0) === name, onchange: () => { nice = v; slider.value = String(v); out.textContent = String(v); } }), h("span", null, name), note ? h("span", { class: "muted", style: { fontSize: "var(--text-xs)" } }, note) : null),
  );
  const sync = () => radios.forEach((r) => (r.querySelector("input").checked = +r.querySelector("input").value === nice));
  dialog({
    title: `Set priority for ${label(p)}`,
    text: `Now ${priorityName(p.nice, p.policy)}, nice ${p.nice}. Lower nice runs sooner.`,
    body: [h("div", { style: { display: "grid", gap: "var(--space-xs)" } }, radios), h("div", { class: "field" }, h("span", { class: "label" }, "Nice value ", out), slider)],
    actions: [{ label: "Cancel" }, { label: "Set priority", primary: true, run: () => { act("Changing priority", (el) => invoke("set_nice", { pid: p.pid, nice, elevated: el })); } }],
  });
}

export async function affinityDialog(p) {
  const n = store.snap?.ncpu || 1;
  let cur;
  try { cur = new Set(await invoke("get_affinity", { pid: p.pid })); } catch (e) { toast(errText(e), { bad: true }); return; }
  const info = store.cpuInfo || {};
  const pset = new Set(info.perf_cores || []), eset = new Set(info.eff_cores || []);
  const boxes = [];
  for (let i = 0; i < n; i++) {
    const kind = pset.has(i) ? " P" : eset.has(i) ? " E" : "";
    const b = h("input", { type: "checkbox", checked: cur.has(i), value: String(i) });
    boxes.push(b);
    boxes[i]._label = h("label", { class: "check" }, b, h("span", { class: "measured" }, `CPU ${i}${kind}`));
  }
  const all = h("label", { class: "check" }, h("input", { type: "checkbox", checked: cur.size === n, onchange: (e) => boxes.forEach((b) => (b.checked = e.target.checked)) }), h("span", null, "All processors"));
  const quick = [];
  if (pset.size && eset.size) {
    quick.push(h("button", { type: "button", class: "btn", onclick: () => boxes.forEach((b, i) => (b.checked = pset.has(i))) }, "Performance cores only"));
    quick.push(h("button", { type: "button", class: "btn", onclick: () => boxes.forEach((b, i) => (b.checked = eset.has(i))) }, "Efficient cores only"));
  }
  dialog({
    title: `Processor affinity for ${label(p)}`,
    text: "Which logical processors this process, and every thread in it, may run on.",
    body: [all, h("div", { class: "check-grid" }, boxes.map((b) => b._label)), quick.length ? h("div", { style: { display: "flex", gap: "var(--space-xs)", flexWrap: "wrap" } }, quick) : null],
    actions: [
      { label: "Cancel" },
      {
        label: "Set affinity",
        primary: true,
        run: () => {
          const cpus = boxes.filter((b) => b.checked).map((b) => +b.value);
          if (!cpus.length) { toast("Pick at least one processor.", { bad: true }); return false; }
          act("Setting affinity", (el) => invoke("set_affinity", { pid: p.pid, cpus, elevated: el }));
        },
      },
    ],
  });
}

export function dump(p) {
  act("Creating the dump file", (el) => invoke("core_dump", { pid: p.pid, elevated: el }), (path) => `Dump written to ${path}`);
}

export function processMenu(p, x, y, focusBack) {
  const stopped = p.state === "T";
  const items = [
    { label: "End task", icon: "close", key: "Del", run: () => endTask(p) },
    { label: "Kill", key: "Shift Del", danger: true, run: () => endTask(p, true) },
    { label: "End process tree", run: () => endTree(p) },
    "-",
    { label: stopped ? "Resume" : "Suspend", icon: stopped ? "play" : "pause", key: "z", run: () => suspendToggle(p) },
    { label: p.policy === 5 ? "Turn off efficiency mode" : "Efficiency mode", icon: "leaf", key: "e", run: () => efficiencyToggle(p) },
    { label: "Set priority", key: "n", run: () => priorityDialog(p) },
    { label: "Set affinity", run: () => affinityDialog(p) },
    { label: "Send signal", key: "s", run: () => signalDialog(p) },
    "-",
    { label: "Create dump file", icon: "download", run: () => dump(p) },
    { label: "Open file location", icon: "folder", disabled: !p.exe, run: () => act("Opening the folder", () => invoke("open_location", { pid: p.pid })) },
    { label: "Search online", icon: "external", run: () => act("Opening the browser", () => invoke("open_url", { url: `https://duckduckgo.com/?q=${encodeURIComponent(p.name + " linux process")}` })) },
    { label: "Copy command line", icon: "copy", run: () => copyText(p.cmd || p.name) },
  ];
  if (p.unit && p.unit.endsWith(".service")) items.push({ label: "Go to service", icon: "services", run: () => hooks.go?.("services", { unit: p.unit, user: p.kind !== "system" }) });
  items.push("-", { label: "Properties", icon: "info", key: "Enter", run: () => hooks.openDetails?.(p.pid) });
  menu(x, y, items, focusBack);
}

/** btop-style single-key actions on the selected process. */
export function processKey(e, p) {
  if (!p) return false;
  if (e.key === "Delete") { endTask(p, e.shiftKey); return true; }
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  switch (e.key) {
    case "z": suspendToggle(p); return true;
    case "e": efficiencyToggle(p); return true;
    case "n": priorityDialog(p); return true;
    case "s": signalDialog(p); return true;
    case "a": affinityDialog(p); return true;
  }
  return false;
}

export function cpuHistory(pid) {
  return procRing(pid).cpu;
}
