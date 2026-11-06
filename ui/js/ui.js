// Small DOM kit: element builder, icons, toasts, menus, dialogs.

// conditional children are written as `cond ? node : null`; never print them
for (const name of ["replaceChildren", "append", "prepend"]) {
  const orig = Element.prototype[name];
  Element.prototype[name] = function (...kids) {
    return orig.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false));
  };
}

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith("--")) el.style.setProperty(sk, sv);
          else el.style[sk] = sv;
        }
      }
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") el.innerHTML = v;
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

const P = {
  overview: '<rect x="3" y="3" width="8" height="10" rx="1.5"/><rect x="13" y="3" width="8" height="6" rx="1.5"/><rect x="13" y="11" width="8" height="10" rx="1.5"/><rect x="3" y="15" width="8" height="6" rx="1.5"/>',
  processes: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  performance: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  startup: '<path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  details: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9h18M3 14h18M9 9v11"/>',
  services: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  connections: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  system: '<rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  tree: '<path d="M5 4v12a2 2 0 0 0 2 2h4M5 9h6"/><rect x="13" y="6" width="7" height="5" rx="1"/><rect x="13" y="15" width="7" height="5" rx="1"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  leaf: '<path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19l7-7"/>',
  window: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 9h18"/>',
  pin: '<path d="M9 3h6l-1 6 4 4H6l4-4z"/><path d="M12 13v8"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 19h16"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  bolt: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="1.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
};

export function icon(name, cls) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.75");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  if (cls) s.setAttribute("class", cls);
  s.innerHTML = P[name] || "";
  return s;
}

export function logo() {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML =
    '<path d="M2.5 15h3l1.5-4 2 6 2-10 2 7 1.5-1.5h7" fill="none" stroke="var(--color-cool)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="11" cy="7" r="2" fill="var(--color-accent)"/>';
  return s;
}

// ---------- toasts ----------
let toastHost;
export function toast(message, opts = {}) {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const close = () => {
    t.classList.remove("is-open");
    setTimeout(() => t.remove(), 200);
  };
  const t = h(
    "div",
    { class: `toast${opts.bad ? " is-bad" : ""}` },
    h("p", null, message),
    opts.action ? h("button", { type: "button", class: "btn", onclick: () => { close(); opts.action.run(); } }, opts.action.label) : null,
    h("button", { type: "button", class: "btn btn--quiet btn--icon", "aria-label": "Dismiss", onclick: close }, icon("close")),
  );
  toastHost.append(t);
  requestAnimationFrame(() => t.classList.add("is-open"));
  setTimeout(close, opts.ms || (opts.action ? 9000 : 4500));
}

// ---------- context menu ----------
let openMenu = null;
export function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

/** items: [{label, icon?, key?, danger?, disabled?, run}] | "-" | {heading} */
export function menu(x, y, items, returnFocus) {
  closeMenu();
  const m = h("div", { class: "menu", role: "menu" });
  for (const it of items) {
    if (it === "-") m.append(h("hr"));
    else if (it.heading) m.append(h("div", { class: "menu-label" }, it.heading));
    else
      m.append(
        h(
          "button",
          {
            type: "button",
            role: "menuitem",
            class: it.danger ? "is-danger" : null,
            disabled: it.disabled,
            onclick: () => {
              closeMenu();
              returnFocus?.focus?.();
              it.run();
            },
          },
          it.icon ? icon(it.icon) : null,
          it.label,
          it.key ? h("span", { class: "k" }, it.key) : null,
        ),
      );
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + "px";
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + "px";
  openMenu = m;
  requestAnimationFrame(() => m.classList.add("is-open"));
  const btns = [...m.querySelectorAll("button:not(:disabled)")];
  btns[0]?.focus();
  m.addEventListener("keydown", (e) => {
    const i = btns.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    else if (e.key === "Escape") { e.preventDefault(); closeMenu(); returnFocus?.focus?.(); }
    e.stopPropagation();
  });
  return m;
}

document.addEventListener("pointerdown", (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});
window.addEventListener("blur", closeMenu);

// ---------- dialogs ----------
let dialogStack = [];
export function dialog({ title, text, body, actions, onClose, wide, cls }) {
  const prevFocus = document.activeElement;
  const scrim = h("div", { class: "scrim" });
  const close = (v) => {
    scrim.classList.remove("is-open");
    dialogStack = dialogStack.filter((d) => d !== api);
    setTimeout(() => scrim.remove(), 220);
    prevFocus?.focus?.();
    onClose?.(v);
  };
  const box = h(
    "div",
    { class: cls || "dialog", role: "dialog", "aria-modal": "true", "aria-label": title, style: wide ? { width: "min(46rem, calc(100% - 48px))" } : null },
    title || text ? h("div", { class: "dialog-head" }, title ? h("h2", null, title) : null, text ? h("p", null, text) : null) : null,
    body ? h("div", { class: "dialog-body" }, body) : null,
    actions ? h("div", { class: "dialog-foot" }, actions.map((a) => h("button", { type: "button", class: `btn${a.primary ? " btn--primary" : ""}${a.danger ? " btn--danger" : ""}`, onclick: () => { const r = a.run ? a.run() : a.value; if (r !== false) close(r); } }, a.label))) : null,
  );
  scrim.append(box);
  scrim.addEventListener("pointerdown", (e) => { if (e.target === scrim) close(); });
  scrim.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === "Tab") {
      const f = [...box.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
    e.stopPropagation();
  });
  document.body.append(scrim);
  requestAnimationFrame(() => scrim.classList.add("is-open"));
  const first = box.querySelector("input, select, textarea") || box.querySelector(".btn--primary") || box.querySelector("button");
  setTimeout(() => first?.focus(), 30);
  const api = { close, el: box };
  dialogStack.push(api);
  return api;
}

export function anyDialogOpen() {
  return dialogStack.length > 0 || !!document.querySelector(".scrim");
}

export function confirmDialog(title, text, okLabel, danger) {
  return new Promise((resolve) => {
    dialog({
      title,
      text,
      actions: [
        { label: "Cancel", value: false },
        { label: okLabel, primary: true, danger, value: true },
      ],
      onClose: (v) => resolve(!!v),
    });
  });
}

export function copyText(t) {
  navigator.clipboard?.writeText(t).then(
    () => toast("Copied to the clipboard."),
    () => toast("The clipboard refused the copy.", { bad: true }),
  );
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
