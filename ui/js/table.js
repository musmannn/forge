// A virtualised table: only the rows in view are in the DOM, so a thousand
// processes redraw every second without cost.

import { h, icon } from "./ui.js";

export class Table {
  /**
   * cols: [{ key, label, width, num, mono, render(row) -> Node|string, sortVal(row), heat(row) -> 0..1, total() -> string }]
   */
  constructor({ cols, rowKey, onSelect, onActivate, onContext, onToggle, onDelete, sort, label, empty }) {
    this.cols = cols;
    this.rowKey = rowKey;
    this.onSelect = onSelect;
    this.onActivate = onActivate;
    this.onContext = onContext;
    this.onToggle = onToggle;
    this.onDelete = onDelete;
    this.sort = sort || null;
    this.rows = [];
    this.sel = null;
    this.empty = empty;
    this.rowH = 32;
    this.pool = new Map();
    this.el = h("div", { class: "vt", tabindex: "0", role: "grid", "aria-label": label || "Table", "aria-rowcount": "0" });
    this.head = h("div", { class: "vt-head", role: "row" });
    this.body = h("div", { class: "vt-body", role: "rowgroup" });
    this.el.append(this.head, this.body);
    this.el.addEventListener("scroll", () => this.paint(), { passive: true });
    this.el.addEventListener("keydown", (e) => this.key(e));
    this.ro = new ResizeObserver(() => this.paint());
    this.ro.observe(this.el);
    this.buildHead();
  }

  destroy() {
    this.ro.disconnect();
  }

  setCols(cols) {
    this.cols = cols;
    this.pool.clear();
    this.body.replaceChildren();
    this.buildHead();
    this.paint();
  }

  template() {
    return this.cols.map((c) => c.width || "minmax(120px, 1fr)").join(" ");
  }

  buildHead() {
    this.head.style.gridTemplateColumns = this.template();
    this.head.replaceChildren(
      ...this.cols.map((c) => {
        const sorted = this.sort && this.sort.key === c.key;
        const b = h(
          "button",
          {
            type: "button",
            class: `vt-th${c.num ? " is-num" : ""}`,
            role: "columnheader",
            "aria-sort": sorted ? (this.sort.dir > 0 ? "ascending" : "descending") : null,
            title: c.title || null,
            onclick: () => {
              if (c.sortVal === false) return;
              if (this.sort && this.sort.key === c.key) this.sort = { key: c.key, dir: -this.sort.dir };
              else this.sort = { key: c.key, dir: c.num ? -1 : 1 };
              this.buildHead();
              this.onSort?.(this.sort);
            },
          },
          h("span", { class: "th-stack" }, c.total ? h("span", { class: "tot", "data-tot": c.key }, c.total()) : null, h("span", null, c.label)),
          sorted ? icon(this.sort.dir > 0 ? "up" : "down", "arrow") : null,
        );
        return b;
      }),
    );
  }

  updateTotals() {
    for (const c of this.cols) {
      if (!c.total) continue;
      const el = this.head.querySelector(`[data-tot="${c.key}"]`);
      if (el) el.textContent = c.total();
    }
  }

  sortRows(rows) {
    if (!this.sort) return rows;
    const c = this.cols.find((x) => x.key === this.sort.key);
    if (!c) return rows;
    const get = c.sortVal || ((r) => r[c.key]);
    const d = this.sort.dir;
    return rows.sort((a, b) => {
      const x = get(a), y = get(b);
      if (typeof x === "string" || typeof y === "string") return d * String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true, sensitivity: "base" });
      return d * ((x ?? -Infinity) - (y ?? -Infinity));
    });
  }

  /** rows: [{ key, data, group?: {label, count, expanded}, depth, kids, expanded, dim }] */
  setRows(rows) {
    this.rows = rows;
    this.el.setAttribute("aria-rowcount", String(rows.length));
    this.body.style.height = rows.length * this.rowH + "px";
    if (this.sel != null && !rows.some((r) => r.key === this.sel)) {
      // keep the selection if the row is only hidden by grouping
    }
    this.updateTotals();
    this.paint();
  }

  index(key) {
    return this.rows.findIndex((r) => r.key === key);
  }

  select(key, scroll = true) {
    this.sel = key;
    const i = this.index(key);
    if (scroll && i >= 0) {
      const top = i * this.rowH, bottom = top + this.rowH;
      const head = this.head.offsetHeight;
      if (top < this.el.scrollTop) this.el.scrollTop = top;
      else if (bottom > this.el.scrollTop + this.el.clientHeight - head) this.el.scrollTop = bottom - this.el.clientHeight + head;
    }
    this.paint();
    const row = this.rows[i];
    if (row) this.onSelect?.(row);
  }

  paint() {
    const st = this.el.scrollTop;
    const vh = this.el.clientHeight;
    const first = Math.max(0, Math.floor(st / this.rowH) - 4);
    const last = Math.min(this.rows.length, Math.ceil((st + vh) / this.rowH) + 4);
    const tpl = this.template();
    const live = new Set();
    if (!this.rows.length && this.empty) {
      if (!this.emptyEl) {
        this.emptyEl = h("div", { class: "vt-empty" }, this.empty());
        this.el.append(this.emptyEl);
      }
    } else if (this.emptyEl) {
      this.emptyEl.remove();
      this.emptyEl = null;
    }
    for (let i = first; i < last; i++) {
      const r = this.rows[i];
      live.add(r.key);
      let el = this.pool.get(r.key);
      if (!el) {
        el = h("div", { role: "row" });
        el.addEventListener("click", (e) => {
          if (e.target.closest(".tw")) return;
          const row = el._row;
          this.el.focus({ preventScroll: true });
          if (row.group) { this.onToggle?.(row); return; }
          this.select(row.key, false);
        });
        el.addEventListener("dblclick", () => { if (!el._row.group) this.onActivate?.(el._row); });
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const row = el._row;
          if (row.group) return;
          this.select(row.key, false);
          this.onContext?.(row, e.clientX, e.clientY);
        });
        this.pool.set(r.key, el);
        this.body.append(el);
      }
      el._row = r;
      el.className = `vt-row${r.group ? " is-group" : ""}${r.key === this.sel ? " is-sel" : ""}${r.dim ? " is-dim" : ""}`;
      el.style.gridTemplateColumns = tpl;
      el.style.transform = `translateY(${i * this.rowH}px)`;
      el.setAttribute("aria-rowindex", String(i + 1));
      el.setAttribute("aria-selected", r.key === this.sel ? "true" : "false");
      this.fill(el, r);
    }
    for (const [k, el] of this.pool) {
      if (!live.has(k)) {
        el.remove();
        this.pool.delete(k);
      }
    }
  }

  fill(el, r) {
    const cells = [];
    if (r.group) {
      const tw = h("button", { type: "button", class: "tw", "aria-expanded": String(!!r.group.expanded), "aria-label": r.group.expanded ? "Collapse" : "Expand", tabindex: "-1", onclick: () => this.onToggle?.(r) }, icon("chevron"));
      cells.push(h("div", { class: "vt-td", role: "gridcell", style: { gridColumn: "1 / 2" } }, tw, h("span", { class: "t" }, r.group.label, " ", h("span", { class: "cnt" }, `(${r.group.count})`))));
      for (let i = 1; i < this.cols.length; i++) {
        const c = this.cols[i];
        const v = c.groupVal ? c.groupVal(r) : "";
        cells.push(h("div", { class: `vt-td${c.num ? " is-num" : ""}`, role: "gridcell" }, v));
      }
      el.replaceChildren(...cells);
      return;
    }
    this.cols.forEach((c, ci) => {
      const td = h("div", { class: `vt-td${c.num ? " is-num" : ""}${c.mono ? " is-mono" : ""}`, role: "gridcell" });
      if (ci === 0 && (r.depth != null || r.kids != null)) {
        if (r.depth) td.style.paddingLeft = `calc(var(--space-sm) + ${r.depth * 16}px)`;
        if (r.kids) {
          td.append(h("button", { type: "button", class: "tw", tabindex: "-1", "aria-expanded": String(!!r.expanded), "aria-label": r.expanded ? "Collapse" : "Expand", onclick: () => this.onToggle?.(r) }, icon("chevron")));
        } else if (r.depth != null) td.append(h("span", { class: "tw-pad" }));
      }
      const v = c.render ? c.render(r.data, r) : r.data[c.key];
      if (v instanceof Node) td.append(v);
      else if (Array.isArray(v)) td.append(...v.filter(Boolean));
      else td.append(h("span", { class: "t" }, v ?? ""));
      if (c.heat) {
        const hv = c.heat(r.data);
        if (hv > 0.01) {
          td.classList.add("heat");
          td.style.setProperty("--h", Math.min(1, hv).toFixed(3));
          if (hv > 0.9) td.classList.add("is-hot");
        }
      }
      if (c.titleOf) td.title = c.titleOf(r.data);
      cells.push(td);
    });
    el.replaceChildren(...cells);
  }

  key(e) {
    if (e.target !== this.el) return;
    const n = this.rows.length;
    if (!n) return;
    let i = this.index(this.sel);
    const page = Math.max(1, Math.floor(this.el.clientHeight / this.rowH) - 1);
    const go = (j) => { e.preventDefault(); this.select(this.rows[Math.max(0, Math.min(n - 1, j))].key); };
    switch (e.key) {
      case "ArrowDown": case "j": return go(i < 0 ? 0 : i + 1);
      case "ArrowUp": case "k": return go(i < 0 ? 0 : i - 1);
      case "PageDown": return go(i + page);
      case "PageUp": return go(i - page);
      case "Home": case "g": return go(0);
      case "End": case "G": return go(n - 1);
      case "ArrowRight": case "ArrowLeft": case " ": {
        const r = this.rows[i];
        if (!r) return;
        const open = r.group ? r.group.expanded : r.expanded;
        if ((r.group || r.kids) && (e.key === " " || (e.key === "ArrowRight") !== !!open)) { e.preventDefault(); this.onToggle?.(r); }
        return;
      }
      case "Enter": {
        const r = this.rows[i];
        if (!r) return;
        e.preventDefault();
        if (r.group) this.onToggle?.(r);
        else this.onActivate?.(r);
        return;
      }
      case "Delete": {
        const r = this.rows[i];
        if (r && !r.group) { e.preventDefault(); this.onDelete?.(r, e.shiftKey); }
        return;
      }
      case "ContextMenu": case "F10": {
        if (e.key === "F10" && !e.shiftKey) return;
        const r = this.rows[i];
        const row = this.pool.get(this.sel);
        if (r && row && !r.group) {
          e.preventDefault();
          const b = row.getBoundingClientRect();
          this.onContext?.(r, b.left + 40, b.bottom);
        }
        return;
      }
    }
  }
}
