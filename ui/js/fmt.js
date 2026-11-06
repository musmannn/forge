const NB = "\u00a0";
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function bytes(n, digits = 1) {
  if (n == null || isNaN(n)) return "";
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  const d = i === 0 ? 0 : v >= 100 ? 0 : digits;
  return `${(n < 0 ? -v : v).toFixed(d)}${NB}${UNITS[i]}`;
}

export function rate(n) {
  if (n == null || isNaN(n)) return "";
  return `${bytes(n)}/s`;
}

export function bits(n) {
  // network speeds in bits, the way adapters are rated
  if (n == null || isNaN(n)) return "";
  const b = n * 8;
  const u = ["bps", "Kbps", "Mbps", "Gbps"];
  let i = 0, v = b;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${NB}${u[i]}`;
}

export function pct(v, d = 0) {
  if (v == null || isNaN(v)) return "";
  return `${v.toFixed(d)}%`;
}

export function mhz(v) {
  if (!v) return "";
  return v >= 1000 ? `${(v / 1000).toFixed(2)}${NB}GHz` : `${v}${NB}MHz`;
}

export function temp(c) {
  if (c == null) return "";
  return `${Math.round(c)}${NB}°C`;
}

export function duration(s) {
  if (s == null || isNaN(s)) return "";
  s = Math.floor(s);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function cpuTime(s) {
  if (s == null) return "";
  if (s < 60) return `${s.toFixed(1)}${NB}s`;
  return duration(s);
}

export function since(epochS) {
  if (!epochS) return "";
  const d = new Date(epochS * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function dateTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function int(n) {
  if (n == null) return "";
  return Number(n).toLocaleString();
}

export const STATE = {
  R: "Running", S: "Sleeping", D: "Waiting on disk", Z: "Zombie", T: "Suspended", t: "Traced",
  I: "Idle", X: "Dead", P: "Parked", W: "Paging", K: "Wakekill",
};

export function priorityName(nice, policy) {
  if (policy === 5) return "Efficiency";
  if (policy === 1 || policy === 2) return "Realtime";
  if (nice <= -15) return "Realtime";
  if (nice <= -5) return "High";
  if (nice < 0) return "Above normal";
  if (nice === 0) return "Normal";
  if (nice < 10) return "Below normal";
  return "Low";
}

// systemd escapes characters in unit names as \xNN
export function unit(u) {
  return (u || "").replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
