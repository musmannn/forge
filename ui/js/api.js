// Bridge to the Rust side. In a plain browser (design preview), a sample
// machine stands in so the screens can be rendered and reviewed.

const T = window.__TAURI__;
export const isTauri = !!(T && T.core);
let demo = null;

async function demoMod() {
  if (!demo) demo = await import("./demo.js");
  return demo;
}

export async function invoke(cmd, args = {}) {
  if (isTauri) return T.core.invoke(cmd, args);
  return (await demoMod()).invoke(cmd, args);
}

export async function listen(event, cb) {
  if (isTauri && event === "snapshot" && T.core.Channel) {
    // a channel streams through the IPC protocol instead of evaluating script per sample
    const ch = new T.core.Channel();
    ch.onmessage = cb;
    await T.core.invoke("subscribe", { onSnapshot: ch });
    return () => {};
  }
  if (isTauri) return T.event.listen(event, (e) => cb(e.payload));
  return (await demoMod()).listen(event, cb);
}

export const NEEDS_ROOT = "needs-root: ";
export const needsRoot = (e) => String(e).startsWith(NEEDS_ROOT);
export const errText = (e) => String(e).replace(NEEDS_ROOT, "");
