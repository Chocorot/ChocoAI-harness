// Motion helpers. Uses the vendored `motion` library (global `Motion`); without it, or with reduced motion, nothing animates
// and the UI still works. Durations are the shared tokens from ChocoHost-status ui-motion.md: 0.15 / 0.2 / 0.3 s.
export const dur = { fast: 0.15, base: 0.2, slow: 0.3 };
const M = () => globalThis.Motion;
export const reduced = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const ok = () => M() && !reduced();

export function enter(el, { y = 8, delay = 0 } = {}) {
  if (ok()) M().animate(el, { opacity: [0, 1], transform: [`translateY(${y}px)`, "translateY(0)"] }, { duration: dur.base, delay, ease: "easeOut" });
}
export function pop(el) {
  if (ok()) M().animate(el, { transform: ["scale(0.6)", "scale(1)"] }, { type: "spring", stiffness: 520, damping: 20 });
}
export function shake(el) {
  if (ok()) M().animate(el, { transform: ["translateX(0)", "translateX(-6px)", "translateX(6px)", "translateX(-4px)", "translateX(0)"] }, { duration: 0.35 });
}
export function stagger(els, opts) {
  els.slice(0, 12).forEach((el, i) => enter(el, { ...opts, delay: i * 0.03 })); // capped: long lists must not take seconds
}
// Slide a sheet in/out. `mobile` sheets rise from the bottom with a spring, desktop dialogs fade and scale.
export function sheetIn(panel, backdrop, mobile) {
  if (!ok()) return;
  M().animate(backdrop, { opacity: [0, 1] }, { duration: dur.base });
  M().animate(panel, mobile ? { transform: ["translateY(100%)", "translateY(0)"] } : { opacity: [0, 1], transform: ["translate(-50%,-48%) scale(.96)", "translate(-50%,-50%) scale(1)"] },
    mobile ? { type: "spring", stiffness: 380, damping: 36 } : { duration: dur.base, ease: "easeOut" });
}
export async function sheetOut(panel, backdrop, mobile) {
  if (!ok()) return;
  const a = M().animate(backdrop, { opacity: [1, 0] }, { duration: dur.fast });
  const b = M().animate(panel, mobile ? { transform: ["translateY(0)", "translateY(100%)"] } : { opacity: [1, 0] }, { duration: dur.base, ease: "easeIn" });
  await Promise.all([a.finished, b.finished].filter(Boolean)).catch(() => {});
}
