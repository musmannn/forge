// Canvas traces. Colours come from the CSS tokens, read once per colourway.

let palette = null;

export function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  palette = {
    cool: v("--color-cool"),
    accent: v("--color-accent"),
    muted: v("--color-muted"),
    rule: v("--color-rule"),
    ok: v("--color-ok"),
    bad: v("--color-bad"),
    paper2: v("--color-paper-2"),
    fill: parseFloat(v("--trace-fill")) || 0.2,
  };
  return palette;
}

export function colour(name) {
  if (!palette) readPalette();
  return palette[name] || name;
}

// canvas sizes come from a ResizeObserver, so drawing never forces a layout
const sizes = new WeakMap();
const ro = new ResizeObserver((entries) => {
  for (const e of entries) sizes.set(e.target, { w: e.contentRect.width, h: e.contentRect.height });
});

function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  let sz = sizes.get(canvas);
  if (!sz) {
    ro.observe(canvas);
    sz = { w: canvas.clientWidth, h: canvas.clientHeight };
    sizes.set(canvas, sz);
  }
  const { w, h } = sz;
  if (!w || !h) return null;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/**
 * series: [{ data: number[], colour: "cool"|"accent"|..., fill?: boolean, width?: number, dash?: boolean, alpha?: number, mirror?: boolean }]
 * opts: { max?: number, samples: number, grid?: number, pad?: number }
 */
export function trace(canvas, series, opts = {}) {
  if (!palette) readPalette();
  const f = fit(canvas);
  if (!f) return;
  const { ctx, w, h } = f;
  const n = Math.max(2, opts.samples || 60);
  const max = opts.max || Math.max(1, ...series.flatMap((s) => s.data)) * 1.1;
  const grid = opts.grid ?? 3;
  const mid = opts.mirror ? h / 2 : null;

  if (grid) {
    ctx.strokeStyle = palette.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i <= grid; i++) {
      const y = Math.round((h * i) / (grid + 1)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  }

  const step = w / (n - 1);
  for (const s of series) {
    const d = s.data;
    if (!d.length) continue;
    const c = palette[s.colour] || s.colour;
    const x0 = w - (d.length - 1) * step;
    const yOf = (v) => {
      const r = Math.min(1, Math.max(0, v / max));
      if (mid != null) return s.mirror ? mid + r * (mid - 1) : mid - r * (mid - 1);
      return h - 1 - r * (h - 2);
    };
    ctx.beginPath();
    for (let i = 0; i < d.length; i++) {
      const x = x0 + i * step, y = yOf(d[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (s.fill !== false) {
      ctx.save();
      const base = mid != null ? mid : h;
      ctx.lineTo(w, base);
      ctx.lineTo(x0, base);
      ctx.closePath();
      ctx.globalAlpha = (s.alpha ?? 1) * palette.fill;
      ctx.fillStyle = c;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      for (let i = 0; i < d.length; i++) {
        const x = x0 + i * step, y = yOf(d[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = c;
    ctx.globalAlpha = s.alpha ?? 1;
    ctx.lineWidth = s.width || 1.5;
    ctx.lineJoin = "round";
    ctx.setLineDash(s.dash ? [3, 3] : []);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }
  if (mid != null) {
    ctx.strokeStyle = palette.rule;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(w, Math.round(mid) + 0.5);
    ctx.stroke();
  }
}

// one value per column, newest at the right: the per-core strip
export function bars(canvas, values, opts = {}) {
  if (!palette) readPalette();
  const f = fit(canvas);
  if (!f) return;
  const { ctx, w, h } = f;
  const n = values.length || 1;
  const gap = opts.gap ?? 2;
  const bw = Math.max(1, (w - gap * (n - 1)) / n);
  const max = opts.max || 100;
  ctx.strokeStyle = palette.rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const g of [0.25, 0.5, 0.75]) { const y = Math.round(h * g) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
  values.forEach((v, i) => {
    const r = Math.min(1, Math.max(0, v / max));
    const bh = Math.max(1, r * h);
    const x = i * (bw + gap);
    ctx.fillStyle = r > 0.9 ? palette.bad : palette.cool;
    ctx.globalAlpha = 0.45 + 0.55 * r;
    ctx.fillRect(x, h - bh, bw, bh);
    ctx.globalAlpha = 1;
    // peak over the last few seconds, held like a meter
    const pk = opts.peaks?.[i];
    if (pk != null && pk > v) {
      ctx.fillStyle = palette.muted;
      ctx.fillRect(x, Math.round(h - Math.min(1, pk / max) * h), bw, 2);
    }
    // the core the picked process last ran on
    if (opts.mark === i) {
      ctx.fillStyle = palette.accent;
      ctx.fillRect(x, h - 4, bw, 4);
    }
  });
  ctx.globalAlpha = 1;
}

// nice ceiling for auto-scaled byte rates, so axes read as round numbers
export function niceMax(v) {
  if (v <= 0) return 1024;
  const p = Math.pow(2, Math.ceil(Math.log2(v * 1.15)));
  return Math.max(1024, p);
}
