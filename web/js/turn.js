// One assistant turn on screen: thinking panel, streamed answer, tool cards, plan checklist, status line, notices, errors.
// Fed either live (SSE events, see docs/chat-streaming.md) or from a saved chat (replay). Everything about how a tool or an
// error kind looks is a row in a table below, so a new tool or error kind needs no code here.
import { esc, renderBlock, splitBlocks } from "./md.js";
import { splitThink } from "./sse.js";
import { icon } from "./icons.js";
import { enter, pop } from "./anim.js";

export const TOOL_UI = {
  read_file: { icon: "file", label: "Reading file", arg: "path" },
  edit_file: { icon: "file", label: "Editing file", arg: "path" },
  write_file: { icon: "file", label: "Writing file", arg: "path" },
  run_bash: { icon: "terminal", label: "Running command", arg: "command" },
  web_fetch: { icon: "globe", label: "Reading page", arg: "url" },
  web_search: { icon: "search", label: "Searching the web", arg: "query" },
  delegate: { icon: "users", label: "Helper", arg: "task" },
  update_plan: { hidden: true }, // shown as the plan checklist instead
};
export const ERROR_ICON = { busy: "clock", rate_limited: "clock", upstream_down: "cloudoff", upstream_timeout: "clock", auth: "lock",
  forbidden: "lock", login_unavailable: "lock", context_overflow: "layers" };
const toolUi = (name) => TOOL_UI[name] || { icon: "wrench", label: name, arg: null };

function argSummary(ui, args) {
  const v = ui.arg && args && typeof args === "object" ? args[ui.arg] : null;
  const s = typeof v === "string" ? v : Object.values(args && typeof args === "object" ? args : {}).find((x) => typeof x === "string") || "";
  return s.replace(/^https?:\/\//, "").replace(/\s+/g, " ").slice(0, 90);
}
export const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const secs = (ms) => (ms < 10000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)) + "s";
const thought = (ms) => (ms < 1000 ? "Thought for a moment" : `Thought for ${Math.round(ms / 1000)}s`);

export class Turn {
  // opts: live (animate + show "Thinking"), onChange(), onRetry(), onContinue()
  constructor(host, opts = {}) {
    this.opts = { live: true, onChange() {}, ...opts };
    this.root = el("div", "turn" + (this.opts.live ? " live" : ""));
    host.append(this.root);
    this.cur = null; this.parts = []; this.tools = new Map(); this.hidden = new Set(); this.planEl = null;
    this.statusEl = null; this.dirty = false; this.timers = new Set(); this.sawContent = false;
    if (this.opts.live) this.setStatus("Thinking…", "sparkle", true);
  }

  // ---- entry point for streamed events -------------------------------------------------------------------------
  event(ev) {
    if (ev.sub) return this.subEvent(ev);
    switch (ev.t) {
      case "queued": return this.setStatus(`Waiting in line · ${ev.pos} ahead`, "clock", false);
      case "status": if (ev.phase === "model" && !this.sawContent) this.setStatus(ev.turn > 1 ? `Thinking… step ${ev.turn}` : "Thinking…", "sparkle", true); return;
      case "think": return this.think(ev.d);
      case "text": return this.text(ev.d);
      case "tool": return this.tool(ev);
      case "result": return this.result(ev);
      case "plan": return this.plan(ev.steps);
      case "notice": return this.notice(ev);
      case "retrying": return this.retrying(ev);
      case "error": return this.error(ev);
    }
  }

  // ---- parts ---------------------------------------------------------------------------------------------------
  append(node) { this.statusEl ? this.root.insertBefore(node, this.statusEl) : this.root.append(node); }
  ensure(kind) {
    if (this.cur?.kind === kind) return this.cur;
    this.closeCur();
    const p = { kind, raw: "", nodes: [], srcs: [] };
    if (kind === "text") { p.el = el("div", "part-text md"); this.append(p.el); }
    else this.makeThink(p);
    this.parts.push(p);
    return (this.cur = p);
  }
  makeThink(p, before) {
    p.t0 = Date.now(); p.userToggled = false;
    p.el = el("div", "think");
    p.el.dataset.open = "true";
    p.el.innerHTML = `<button class="fold-h" type="button" aria-expanded="true"><span class="pulse-ic">${icon("sparkle", 16)}</span><span class="lbl shimmer">Thinking…</span><span class="time">0s</span>${icon("chevron", 16, "chev")}</button><div class="fold"><div class="fold-in"><div class="think-body"></div></div></div>`;
    p.body = p.el.querySelector(".think-body"); p.lbl = p.el.querySelector(".lbl"); p.time = p.el.querySelector(".time");
    p.el.querySelector(".fold-h").addEventListener("click", () => { p.userToggled = true; this.toggle(p.el); });
    before ? this.root.insertBefore(p.el, before) : this.append(p.el);
    p.timer = setInterval(() => { p.time.textContent = secs(Date.now() - p.t0); }, 1000);
    this.timers.add(p.timer);
    if (this.opts.live) enter(p.el, { y: 4 });
    return p;
  }
  toggle(node) {
    const open = node.dataset.open !== "true";
    node.dataset.open = String(open);
    node.querySelector(".fold-h").setAttribute("aria-expanded", String(open));
  }
  finishThink(p) {
    if (p.done) return;
    p.done = true;
    clearInterval(p.timer); this.timers.delete(p.timer);
    if (!p.raw.trim()) return p.el.remove();
    p.lbl.classList.remove("shimmer"); p.lbl.textContent = thought(Date.now() - p.t0);
    p.el.querySelector(".pulse-ic").classList.remove("pulse-ic"); p.time.remove();
    if (!p.userToggled) { p.el.dataset.open = "false"; p.el.querySelector(".fold-h").setAttribute("aria-expanded", "false"); }
  }
  closeCur() {
    const p = this.cur;
    if (!p) return;
    this.cur = null;
    this.render(p);
    if (p.kind === "think") this.finishThink(p);
    else if (p.tp) this.finishThink(p.tp);
  }

  think(d) { this.content(); const p = this.ensure("think"); p.raw += d; this.markDirty(); }
  text(d) { this.content(); const p = this.ensure("text"); p.raw += d; this.markDirty(); }
  content() { this.sawContent = true; this.clearStatus(); }

  markDirty() {
    if (this.dirty) return;
    this.dirty = true;
    this.raf = requestAnimationFrame(() => this.flushNow());
  }
  flushNow() {
    this.dirty = false;
    cancelAnimationFrame(this.raf);
    if (this.cur) this.render(this.cur);
    this.opts.onChange();
  }
  render(p) {
    if (p.kind === "think") {
      p.body.textContent = p.raw.trim();
      p.body.scrollTop = p.body.scrollHeight;
      return;
    }
    const { think, answer } = splitThink(p.raw);
    if (think || /^\s*<think>/.test(p.raw)) { // reasoning written inline in the answer: show it in a thinking panel too
      if (!p.tp) p.tp = this.makeThink({ kind: "think", raw: "" }, p.el);
      p.tp.raw = think; p.tp.body.textContent = think.trim(); p.tp.body.scrollTop = p.tp.body.scrollHeight;
      if (answer) this.finishThink(p.tp);
    }
    const blocks = splitBlocks(answer);
    blocks.forEach((src, i) => {
      let node = p.nodes[i];
      if (!node) {
        node = el("div", "blk", renderBlock(src));
        p.el.append(node); p.nodes[i] = node; p.srcs[i] = src;
        if (this.opts.live) enter(node, { y: 4 });
      } else if (p.srcs[i] !== src) { node.innerHTML = renderBlock(src); p.srcs[i] = src; }
    });
    while (p.nodes.length > blocks.length) { p.nodes.pop().remove(); p.srcs.pop(); }
  }

  // ---- tools ---------------------------------------------------------------------------------------------------
  tool(ev) {
    const ui = toolUi(ev.name);
    const key = `${ev.sub || ""}:${ev.id}`;
    if (ui.hidden) return this.hidden.add(key);
    this.content();
    if (!ev.sub) this.closeCur();
    const card = el("div", "tool");
    card.dataset.state = "running"; card.dataset.open = "false";
    card.innerHTML = `<button class="fold-h tool-h" type="button" aria-expanded="false"><span class="state">${icon("refresh", 16, "spin")}</span>${icon(ui.icon, 16)}<span class="tn">${esc(ui.label)}</span><span class="ta">${esc(argSummary(ui, ev.args))}</span>${icon("chevron", 16, "chev")}</button><div class="fold"><div class="fold-in"><div class="sec"><label>Input</label><pre class="in"></pre></div><div class="sec" hidden><label>Result</label><pre class="res"></pre></div><div class="sub"></div></div></div>`;
    card.querySelector(".in").textContent = (typeof ev.args === "string" ? ev.args : JSON.stringify(ev.args, null, 2)).slice(0, 3000);
    card.querySelector(".fold-h").addEventListener("click", () => this.toggle(card));
    card.t0 = Date.now();
    this.tools.set(key, card);
    if (ev.sub) this.tools.get(`:${ev.sub}`)?.querySelector(".sub").append(card);
    else this.append(card);
    if (this.opts.live) enter(card, { y: 4 });
    this.opts.onChange();
  }
  result(ev) {
    const key = `${ev.sub || ""}:${ev.id}`;
    const card = this.tools.get(key);
    if (!card) return void this.hidden.delete(key);
    const ok = ev.ok !== false;
    card.dataset.state = ok ? "ok" : "fail";
    card.querySelector(".state").innerHTML = icon(ok ? "check" : "x", 16);
    const res = card.querySelector(".res");
    res.textContent = String(ev.d ?? "").slice(0, 3000);
    res.parentElement.hidden = false;
    if (this.opts.live && card.t0) card.querySelector(".fold-h").insertBefore(el("span", "time", secs(Date.now() - card.t0)), card.querySelector(".chev"));
    if (!ok) { card.dataset.open = "true"; card.querySelector(".fold-h").setAttribute("aria-expanded", "true"); }
    this.opts.onChange();
  }
  subEvent(ev) { // output of a delegated helper, shown inside its delegate card
    const card = this.tools.get(`:${ev.sub}`);
    if (!card) return;
    if (ev.t === "tool") this.tool(ev);
    else if (ev.t === "result") this.result(ev);
    else if (ev.t === "text") {
      const sub = card.querySelector(".sub");
      let note = sub.querySelector(":scope > .sub-note");
      if (!note) { note = el("div", "sub-note"); sub.append(note); }
      note.textContent += ev.d;
    }
  }

  plan(steps) {
    this.content(); this.closeCur();
    if (!this.planEl) { this.planEl = el("div", "plan"); this.append(this.planEl); if (this.opts.live) enter(this.planEl, { y: 4 }); }
    const prev = new Map([...this.planEl.querySelectorAll("li")].map((li) => [li.dataset.t, li.dataset.s]));
    const done = steps.filter((s) => s.status === "done").length;
    this.planEl.innerHTML = `<div class="plan-h">${icon("list", 16)}<span>Plan</span><span>${done}/${steps.length}</span></div><ol>${steps.map((s) =>
      `<li data-s="${esc(s.status)}" data-t="${esc(s.text)}"><span class="state">${s.status === "done" ? icon("check", 12) : ""}</span><span>${esc(s.text)}</span></li>`).join("")}</ol>`;
    if (this.opts.live) this.planEl.querySelectorAll("li").forEach((li) => { if (li.dataset.s === "done" && prev.get(li.dataset.t) !== "done") pop(li.querySelector(".state")); });
    this.opts.onChange();
  }

  // ---- status, notices, errors ---------------------------------------------------------------------------------
  setStatus(text, ic, shimmer) {
    if (!this.statusEl) { this.statusEl = el("div", "status"); this.root.append(this.statusEl); }
    this.statusEl.innerHTML = `${icon(ic, 16, ic === "sparkle" ? "pulse-ic" : "")}<span class="${shimmer ? "shimmer" : ""}">${esc(text)}</span>`;
    this.opts.onChange();
  }
  clearStatus() { clearInterval(this.countdown); this.statusEl?.remove(); this.statusEl = null; }
  retrying(ev) {
    if (ev.reset && this.cur) { // a half-streamed reply is being redone: drop it
      clearInterval(this.cur.timer); clearInterval(this.cur.tp?.timer); this.cur.tp?.el.remove(); this.cur.el.remove();
      this.parts.splice(this.parts.indexOf(this.cur), 1); this.cur = null;
    }
    this.sawContent = false;
    let left = Math.round(ev.in || 0);
    const say = () => this.setStatus(left > 0 ? `${ev.msg} Retrying in ${left}s…` : `${ev.msg} Retrying…`, "refresh", false);
    say();
    clearInterval(this.countdown);
    if (left > 0) this.countdown = setInterval(() => { left = Math.max(0, left - 1); say(); }, 1000);
  }
  notice(ev) {
    this.content(); this.closeCur();
    const card = el("div", "card warn", `${icon("alert", 18)}<div class="body"><div>${esc(ev.msg || "Stopped.")}</div></div>`);
    if (ev.kind === "budget" && this.opts.onContinue) {
      const b = el("button", "btn", "Continue"); b.type = "button";
      b.addEventListener("click", () => { b.remove(); this.opts.onContinue(); });
      card.querySelector(".body").append(b);
    }
    this.append(card);
    if (this.opts.live) enter(card, { y: 4 });
    this.opts.onChange();
  }
  error(ev) {
    this.content(); this.closeCur();
    const card = el("div", "card err", `${icon(ERROR_ICON[ev.kind] || "alert", 18)}<div class="body"><div>${esc(ev.msg || ev.d || "Something went wrong.")}</div>${ev.rid ? `<small>Reference ${esc(ev.rid)}</small>` : ""}</div>`);
    if (ev.retryable && this.opts.onRetry) {
      const b = el("button", "btn", `${icon("refresh", 16)} Try again`); b.type = "button";
      b.addEventListener("click", () => { card.remove(); this.opts.onRetry(); });
      card.querySelector(".body").append(b);
    }
    this.append(card);
    if (this.opts.live) enter(card, { y: 4 });
    this.opts.onChange();
  }

  // ---- finishing -----------------------------------------------------------------------------------------------
  end() {
    this.closeCur();
    this.clearStatus();
    this.flushNow();
    this.timers.forEach(clearInterval);
    this.root.classList.remove("live");
  }
  answerText() {
    return this.parts.filter((p) => p.kind === "text").map((p) => splitThink(p.raw).answer.trim()).filter(Boolean).join("\n\n");
  }
}
