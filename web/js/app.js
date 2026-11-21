// ChocoAI harness UI controller: routing, public vs signed-in chat, sheets, sign-in, theme, install. No framework, no build.
// What the page offers comes from GET /api/me (capabilities), never from names in this file. See docs/pwa-and-ui-design.md.
import { icon } from "./icons.js";
import { esc } from "./md.js";
import { readEvents } from "./sse.js";
import { Turn, el } from "./turn.js";
import { MAX_DOC_BYTES, MAX_FILES, MAX_TOTAL_B64, extOf, fmtSize, parseUserContent, shrinkImage, toBase64 } from "./attach.js";
import { enter, shake, sheetIn, sheetOut, stagger } from "./anim.js";

const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app"), col = $("#col"), msgs = $("#msgs"), input = $("#input"), sendBtn = $("#send"), jump = $("#jump");
const S = { me: null, sessions: [], sid: null, busy: false, polling: false, ctl: null, turn: null, poll: null, history: [], stick: true, install: null, atts: [] };
const HKEY = "choco.public.chat.v1", TKEY = "choco-harness-theme";
const coarse = () => matchMedia("(pointer: coarse)").matches;
const desktop = () => matchMedia("(min-width: 768px)").matches;
const user = () => S.me?.capabilities.history === "user";
const can = (tool) => S.me?.capabilities.tools.includes(tool);
const attCaps = () => S.me?.capabilities.attachments || { image: false, documents: [] };

// ---- storage (every access guarded: private windows and blocked storage must not break the app) ----------------------
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const loadHistory = () => { try { const h = JSON.parse(store.get(HKEY)); return Array.isArray(h) ? h.filter((m) => m && typeof m.content === "string") : []; } catch { return []; } };
const saveHistory = () => store.set(HKEY, JSON.stringify(S.history.slice(-100)));

// ---- helpers ---------------------------------------------------------------------------------------------------------
async function api(method, path, body) {
  const res = await fetch(path, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status });
  return data;
}
function toast(text) {
  const t = el("div", "toast"); t.textContent = text; $("#toast-root").append(t); enter(t, { y: 10 });
  setTimeout(() => t.remove(), 2600);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = el("textarea"); ta.value = text; ta.style.cssText = "position:fixed;opacity:0"; document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
}
// Two-step button for destructive actions (no native confirm dialogs): first press arms, second press within 3 s confirms.
function twoStep(btn, armedLabel, action) {
  let timer, label = btn.innerHTML;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (btn.classList.contains("armed")) { clearTimeout(timer); return action(); }
    btn.classList.add("armed"); btn.textContent = armedLabel;
    timer = setTimeout(() => { btn.classList.remove("armed"); btn.innerHTML = label; }, 3000);
  });
}

// ---- theme -----------------------------------------------------------------------------------------------------------
const getTheme = () => (["light", "dark"].includes(store.get(TKEY)) ? store.get(TKEY) : "system");
function setTheme(t) {
  if (t === "system") { store.del(TKEY); delete document.documentElement.dataset.theme; } else { store.set(TKEY, t); document.documentElement.dataset.theme = t; }
}

// ---- messages area ---------------------------------------------------------------------------------------------------
const SUGGESTIONS = [ // `needs`: shown only when the caller's tools include it
  { text: "Explain how DNS works in simple terms" },
  { text: "Help me write a polite email declining a meeting" },
  { text: "Search the web for today's top tech news", needs: "web_search" },
  { text: "Make a 3-step plan to learn Python, then do step 1", needs: "update_plan" },
];
function scrollBottom(force) {
  if (force || S.stick) msgs.scrollTop = msgs.scrollHeight;
}
function onScroll() {
  S.stick = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
  jump.hidden = S.stick || !col.querySelector(".msg");
}
function clearMsgs() {
  S.turn = null; col.innerHTML = ""; S.stick = true; jump.hidden = true;
}
function showEmpty() {
  const chips = SUGGESTIONS.filter((s) => !s.needs || can(s.needs));
  const e = el("div", "empty");
  e.id = "empty";
  e.innerHTML = `<div class="logo">${icon("sparkle", 26)}</div><h2>How can I help?</h2><p>${user() ? "Your chats are saved to your account." : "Ask anything. Your chat stays on this device."}</p><div class="chips"></div>`;
  chips.forEach((s) => { const b = el("button", "chip"); b.type = "button"; b.textContent = s.text; b.addEventListener("click", () => send(s.text)); e.querySelector(".chips").append(b); });
  col.append(e);
  stagger([...e.children], { y: 10 });
}
const dropEmpty = () => $("#empty", col)?.remove();
// atts: [{kind: "image"|"file", name, url?, size?}] shown above the text (live: object URL of the shrunk photo; saved chats: the upload URL)
function addUser(text, atts = []) {
  dropEmpty();
  const m = el("div", "msg user"); const b = el("div", "bubble");
  for (const a of atts.filter((x) => x.kind === "image")) { const img = el("img", "photo"); img.src = a.url; img.alt = a.name; b.append(img); }
  const files = atts.filter((x) => x.kind === "file");
  if (files.length) { const box = el("div", "atts"); files.forEach((f) => box.append(attChip(f))); b.append(box); }
  if (text) b.append(document.createTextNode(text));
  m.append(b); col.append(m); enter(m, { y: 8 });
  scrollBottom(true);
}
function attChip(a, removable) {
  const c = el(a.url && !removable ? "a" : "div", "att");
  if (c.tagName === "A") { c.href = a.url; c.setAttribute("download", a.name); }
  c.innerHTML = `${a.kind === "image" && a.url ? `<img class="th" src="${esc(a.url)}" alt="">` : `<span class="th">${icon(a.kind === "image" ? "image" : "file", 20)}</span>`}<span class="nm"><b>${esc(a.name)}</b>${a.size ? `<small>${esc(fmtSize(a.size))}</small>` : ""}</span>`;
  if (removable) { const r = el("button", "rm", icon("x", 16)); r.type = "button"; r.setAttribute("aria-label", `Remove ${a.name}`); r.addEventListener("click", removable); c.append(r); }
  return c;
}
function newTurn(live = true) {
  dropEmpty();
  const row = el("div", "msg ai", `<div class="logo">${icon("sparkle", 16)}</div>`);
  col.append(row);
  const turn = new Turn(row, { live, onChange: () => scrollBottom(), onRetry: () => retry(turn), onContinue: () => send("continue") });
  turn.row = row;
  return (S.turn = turn);
}
function addActions(turn) {
  const a = el("div", "actions");
  const mk = (ic, label, fn) => { const b = el("button", "iconbtn", icon(ic, 18)); b.type = "button"; b.setAttribute("aria-label", label); b.addEventListener("click", fn); a.append(b); return b; };
  if (turn.answerText()) mk("copy", "Copy reply", async (e) => { await copy(turn.answerText()); e.currentTarget.innerHTML = icon("check", 18); setTimeout(() => { e.currentTarget.innerHTML = icon("copy", 18); }, 1500); });
  if (!user()) mk("refresh", "Regenerate", regenerate);
  if (a.children.length) turn.root.append(a);
}

// ---- chat flow -------------------------------------------------------------------------------------------------------
function setBusy(b) {
  S.busy = b;
  sendBtn.innerHTML = icon(b ? "stop" : "send", 20);
  sendBtn.setAttribute("aria-label", b ? "Stop" : "Send");
  sendBtn.disabled = !b && !input.value.trim();
}
function grow() {
  input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 152) + "px";
  if (!S.busy) sendBtn.disabled = !input.value.trim() && !S.atts.length;
}
async function send(text, atts = []) {
  if (S.busy) return;
  if (!user()) { S.history.push({ role: "user", content: text }); saveHistory(); }
  addUser(text, atts.map(({ kind, name, url, size }) => ({ kind, name, url, size })));
  await run(text, false, atts);
}
function retry(turn) {
  if (!user()) turn.row.remove(); // a visitor's failed attempt is redone from the history; a saved chat keeps what already happened
  run(null, true);
}
async function regenerate() {
  if (S.busy) return;
  while (S.history.length && S.history[S.history.length - 1].role !== "user") S.history.pop();
  saveHistory();
  col.lastElementChild?.remove();
  await run(null, true);
}
async function run(text, isRetry, atts = []) {
  setBusy(true);
  const turn = newTurn();
  const ctl = (S.ctl = new AbortController());
  let finished = false, failure = null, lost = false;
  try {
    let body;
    if (user()) body = isRetry ? { session: S.sid, retry: true } : { goal: text, session: S.sid || undefined, attachments: atts.length ? atts.map(({ name, data }) => ({ name, data })) : undefined };
    else { // a failed attempt is retried without its failure note; the page's history is the whole conversation
      while (S.history.length && S.history[S.history.length - 1].hidden) S.history.pop();
      body = { messages: S.history.map(({ role, content }) => ({ role, content })) };
    }
    const res = await fetch("/api/chat", { method: "POST", credentials: "same-origin", signal: ctl.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      turn.error({ kind: d.kind, msg: d.error || res.statusText, retryable: d.retryable, rid: d.rid });
      if (res.status === 401 && user()) { await refreshMe(); toast("Your session ended. Sign in again."); }
      return;
    }
    for await (const ev of readEvents(res)) {
      if (ev.t === "session") onSession(ev.id, text);
      else if (ev.t === "done") finished = true;
      else {
        if (ev.t === "error") failure = ev;
        turn.event(ev);
      }
    }
    lost = !finished && !failure; // the stream ended without done or error: a proxy or the phone dropped it
  } catch (e) {
    if (e.name === "AbortError") turn.root.append(el("div", "status", user() ? "Stopped. The assistant may still finish in the background." : "Stopped."));
    else lost = true;
  } finally {
    if (lost && user() && S.sid) { // the run goes on server side: wait for it instead of showing a failure
      S.polling = true; turn.setStatus("Connection lost. The assistant is still working, reconnecting…", "refresh", false); startPoll(S.sid);
    } else {
      if (lost) turn.error({ kind: "upstream_down", msg: "The connection was lost before the reply finished.", retryable: true });
      finishRun(turn, finished, failure, ctl.signal.aborted);
    }
  }
}
function finishRun(turn, finished, failure, aborted) {
  turn.end();
  if (!user()) { // public: the page owns the history
    const answer = turn.answerText();
    if (answer) S.history.push({ role: "assistant", content: answer });
    if (failure?.note) S.history.push({ role: "assistant", content: failure.note, hidden: true });
    saveHistory();
  } else if (aborted && S.sid) { S.polling = true; startPoll(S.sid); return; }
  if (finished && turn.answerText()) addActions(turn);
  setBusy(false); S.ctl = null;
  if (user()) refreshSessions();
}
function onSession(id, text) {
  if (S.sid === id) return;
  S.sid = id;
  history.replaceState(null, "", `#/c/${id}`); // URL is the state; replaceState does not trigger a route change
  $("#title").textContent = (text || "Chat").split("\n")[0].slice(0, 60);
}
function stop() {
  if (S.polling) { stopPoll(); setBusy(false); return; }
  S.ctl?.abort();
}
function startPoll(sid) {
  stopPoll(); S.polling = true; setBusy(true);
  S.poll = setInterval(async () => {
    try {
      const d = await api("GET", `/api/sessions/${sid}`);
      if (d.running) return;
      stopPoll();
      if (S.sid === sid) await openSession(sid);
      refreshSessions();
    } catch { /* keep trying; the network may be back soon */ }
  }, 2500);
}
function stopPoll() { clearInterval(S.poll); S.poll = null; S.polling = false; setBusy(false); }

// ---- attachments (signed in) -----------------------------------------------------------------------------------------
function renderAtts() {
  const box = $("#atts");
  box.hidden = !S.atts.length; box.innerHTML = "";
  S.atts.forEach((a, i) => box.append(attChip(a, () => { S.atts.splice(i, 1); renderAtts(); grow(); })));
  grow();
}
async function addFiles(files) {
  const caps = attCaps();
  for (const f of files) {
    if (S.atts.length >= MAX_FILES) { toast(`At most ${MAX_FILES} attachments.`); break; }
    try {
      if (f.type.startsWith("image/")) {
        if (!caps.image) { toast("This assistant can't look at photos yet."); continue; }
        if (S.atts.some((a) => a.kind === "image")) { toast("One photo per message."); continue; }
        const blob = await shrinkImage(f);
        S.atts.push({ kind: "image", name: f.name.replace(/\.[^.]*$/, "") + ".jpg", data: await toBase64(blob), url: URL.createObjectURL(blob), size: blob.size });
      } else {
        if (!caps.documents.includes(extOf(f.name))) { toast(`Can't read ${extOf(f.name) || "that kind of"} files.`); continue; }
        if (f.size > MAX_DOC_BYTES) { toast(`${f.name} is too large (limit ${fmtSize(MAX_DOC_BYTES)}).`); continue; }
        S.atts.push({ kind: "file", name: f.name, data: await toBase64(f), size: f.size });
      }
    } catch { toast(`Could not read ${f.name}.`); }
  }
  renderAtts();
}
const attSize = () => S.atts.reduce((n, a) => n + a.data.length, 0);
function setupAttach() {
  const c = attCaps(), on = c.image || c.documents.length;
  $("#attach").hidden = !on;
  $("#file").accept = [c.image ? "image/*" : "", ...c.documents].filter(Boolean).join(",");
  if (!on) { S.atts = []; renderAtts(); }
}

// ---- saved chats -----------------------------------------------------------------------------------------------------
const planSteps = (raw) => (Array.isArray(raw) ? raw : []).map((x) => (typeof x === "string" ? { text: x, status: "todo" } : { text: String(x?.text || ""), status: ["todo", "doing", "done"].includes(x?.status) ? x.status : "todo" })).filter((s) => s.text.trim()).slice(0, 20);
const NOTE = /^\[run failed: [^\]]*\]\s*/;
function replay(list) {
  let turn = null;
  const cur = () => turn || (turn = newTurn(false));
  for (const m of list) {
    if (m.role === "user") {
      turn?.end(); turn = null;
      const u = parseUserContent(m.content), base = `/api/sessions/${S.sid}/uploads/`;
      addUser(u.text, [...u.images.map((n) => ({ kind: "image", name: n, url: base + encodeURIComponent(n) })), ...u.files.map((n) => ({ kind: "file", name: n, url: base + encodeURIComponent(n) }))]);
    }
    else if (m.role === "assistant") {
      if (m.note) { cur().notice({ kind: "info", msg: "A previous reply failed: " + String(m.content).replace(NOTE, "") }); continue; }
      const t = cur();
      if (m.content) { t.text(m.content); t.flushNow(); t.closeCur(); }
      for (const tc of m.tool_calls || []) {
        let args; try { args = JSON.parse(tc.function.arguments || "{}"); } catch { args = tc.function.arguments; }
        t.tool({ id: tc.id, name: tc.function.name, args });
        if (tc.function.name === "update_plan" && args?.steps) t.plan(planSteps(args.steps));
      }
    } else if (m.role === "tool") cur().result({ id: m.tool_call_id, d: m.content, ok: !String(m.content).startsWith("error") });
  }
  turn?.end();
  if (turn?.answerText()) addActions(turn);
}
async function openSession(id) {
  S.ctl?.abort(); stopPoll(); S.sid = id;
  let d;
  try { d = await api("GET", `/api/sessions/${id}`); } catch { toast("That chat no longer exists."); S.sid = null; location.hash = "#/"; return; }
  clearMsgs(); replay(d.messages);
  const s = S.sessions.find((x) => x.id === id);
  $("#title").textContent = s ? chatTitle(s) : "Chat";
  markActive();
  if (d.running) { S.turn?.setStatus("The assistant is still working…", "sparkle", true); startPoll(id); }
  requestAnimationFrame(() => scrollBottom(true));
}
function newChat() {
  S.ctl?.abort(); stopPoll(); S.sid = null; clearMsgs();
  if (!user()) S.history.length ? replay(S.history.filter((m) => !m.hidden)) : showEmpty();
  else showEmpty();
  $("#title").textContent = user() ? "New chat" : "ChocoAI";
  markActive();
}
const chatTitle = (s) => (s.goal || "Chat").split("\n")[0].slice(0, 60);
const when = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
async function refreshSessions() {
  if (!user()) return;
  try { S.sessions = (await api("GET", "/api/sessions")).sessions; } catch { /* keep the old list */ }
  renderLists();
}
function renderLists() { document.querySelectorAll("[data-chatlist]").forEach(fillList); }
function fillList(root) {
  root.innerHTML = S.sessions.length ? "" : `<div class="list-empty">No chats yet.<br>Start one below.</div>`;
  for (const s of S.sessions) {
    const row = el("div", "row", `<button class="open" type="button"><span class="t"></span><small>${esc(when(s.created))}</small></button><button class="del" type="button" aria-label="Delete chat">${icon("trash", 18)}</button>`);
    row.dataset.id = s.id; row.dataset.on = String(s.id === S.sid);
    row.querySelector(".t").textContent = chatTitle(s);
    row.querySelector(".open").addEventListener("click", () => { closeSheet(); location.hash = `#/c/${s.id}`; });
    twoStep(row.querySelector(".del"), "Delete?", async () => {
      try { await api("DELETE", `/api/sessions/${s.id}`); } catch { return toast("Could not delete that chat."); }
      S.sessions = S.sessions.filter((x) => x.id !== s.id); renderLists();
      if (S.sid === s.id) location.hash = "#/";
    });
    root.append(row);
  }
  stagger([...root.children], { y: 6 });
}
function markActive() { document.querySelectorAll("[data-chatlist] .row").forEach((r) => { r.dataset.on = String(Number(r.dataset.id) === S.sid); }); }

// ---- sheets ----------------------------------------------------------------------------------------------------------
let sheet = null;
function openSheet(title, build) {
  closeSheet(true);
  const mobile = !desktop();
  const backdrop = el("div", "backdrop"), panel = el("div", "sheet", `<div class="grab"></div><div class="sheet-h"><h2></h2><button class="iconbtn" type="button" aria-label="Close">${icon("x", 20)}</button></div><div class="sheet-b"></div>`);
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-label", title);
  panel.querySelector("h2").textContent = title;
  build(panel.querySelector(".sheet-b"));
  $("#sheet-root").append(backdrop, panel);
  sheet = { backdrop, panel, mobile, opener: document.activeElement };
  sheetIn(panel, backdrop, mobile);
  const close = () => closeSheet();
  backdrop.addEventListener("click", close); panel.querySelector(".sheet-h .iconbtn").addEventListener("click", close);
  if (mobile) dragToClose(panel, close);
  panel.querySelector(".sheet-h .iconbtn").focus({ preventScroll: true });
}
async function closeSheet(now) {
  const s = sheet; if (!s) return; sheet = null;
  if (!now) await sheetOut(s.panel, s.backdrop, s.mobile);
  s.panel.remove(); s.backdrop.remove(); s.opener?.focus?.({ preventScroll: true });
}
function dragToClose(panel, close) {
  let y0 = null, dy = 0, t0 = 0;
  const handle = panel.querySelector(".grab"), head = panel.querySelector(".sheet-h h2");
  const down = (e) => { y0 = e.clientY; dy = 0; t0 = Date.now(); e.currentTarget.setPointerCapture?.(e.pointerId); };
  const move = (e) => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); panel.style.transform = `translateY(${dy}px)`; };
  const up = () => {
    if (y0 == null) return;
    const fast = dy / Math.max(1, Date.now() - t0) > 0.6; y0 = null;
    if (dy > 110 || fast) close(); else { panel.style.transition = "transform .2s"; panel.style.transform = ""; setTimeout(() => { panel.style.transition = ""; }, 220); }
  };
  [handle, head.parentElement].forEach((h) => { h.style.touchAction = "none"; h.addEventListener("pointerdown", down); h.addEventListener("pointermove", move); h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up); });
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sheet) closeSheet(); });

function chatsSheet() {
  openSheet("Chats", (b) => {
    const nb = el("button", "btn primary wide", `${icon("plus", 18)} New chat`); nb.type = "button"; nb.addEventListener("click", () => { closeSheet(); goNew(); });
    const list = el("div", "list"); list.dataset.chatlist = "";
    b.append(nb, list); fillList(list);
  });
}
function accountSheet() {
  openSheet("Account", (b) => {
    const signedIn = !!S.me.address;
    if (signedIn) {
      b.append(el("div", "id-card", `<div class="avatar">${esc(S.me.address[0])}</div><div><b>${esc(S.me.address)}</b><small>${S.me.capabilities.shell ? "Shell access enabled" : "Signed in"}</small></div>`));
    } else {
      const note = el("p", "note", "You are using the public chat. It has no tools, and your conversation is stored only in this browser.");
      b.append(note);
      if (S.me.capabilities.login) { const bt = el("button", "btn primary wide", `${icon("login", 18)} Sign in`); bt.type = "button"; bt.addEventListener("click", () => { closeSheet(); location.hash = "#/login"; }); b.append(bt); }
    }
    const seg = el("div", "seg");
    const draw = () => { seg.innerHTML = ["system", "light", "dark"].map((t) => `<button type="button" data-t="${t}" aria-pressed="${getTheme() === t}">${icon({ system: "monitor", light: "sun", dark: "moon" }[t], 16)} ${t[0].toUpperCase() + t.slice(1)}</button>`).join(""); };
    draw(); seg.addEventListener("click", (e) => { const t = e.target.closest("[data-t]")?.dataset.t; if (t) { setTheme(t); draw(); } });
    b.append(seg);
    if (S.install) { const ib = el("button", "btn wide", `${icon("download", 18)} Install app`); ib.type = "button"; ib.addEventListener("click", async () => { S.install.prompt(); await S.install.userChoice; S.install = null; closeSheet(); }); b.append(ib); }
    else if (/iphone|ipad/i.test(navigator.userAgent) && !navigator.standalone) b.append(el("p", "note", "To install: tap Share, then Add to Home Screen."));
    if (!signedIn && S.history.length) {
      const rb = el("button", "btn danger wide", `${icon("trash", 18)} Reset chat`); rb.type = "button";
      twoStep(rb, "Tap again to erase this chat", () => { S.history = []; saveHistory(); closeSheet(); newChat(); toast("Chat reset."); });
      b.append(rb);
    }
    if (signedIn) {
      const ob = el("button", "btn wide", `${icon("logout", 18)} Sign out`); ob.type = "button";
      ob.addEventListener("click", async () => { try { await api("POST", "/api/logout"); } catch { /* cookie is cleared by the server; a failure here changes nothing for the user */ } closeSheet(); S.sid = null; await refreshMe(); location.hash = "#/"; newChat(); });
      b.append(ob);
    }
  });
}

// ---- sign-in ---------------------------------------------------------------------------------------------------------
const POINTS = [ // shown beside the sign-in form on wide screens
  { ic: "chat", title: "Saved chats", body: "Pick up any conversation on any device." },
  { ic: "globe", title: "Web search and reading", body: "The assistant can look things up and cite where it found them." },
  { ic: "list", title: "Plans for bigger tasks", body: "It breaks work into steps and ticks them off as it goes." },
];
function showLogin() {
  if (!S.me.capabilities.login) { location.hash = "#/"; return; }
  const root = $("#login-root");
  root.innerHTML = `<div class="login"><section class="login-l"><button class="iconbtn close" type="button" aria-label="Close">${icon("x", 20)}</button>
    <div class="login-box"><header><div class="logo">${icon("sparkle", 24)}</div><h2>Sign in</h2><p>Use your mail account.</p></header>
    <div class="card err" role="alert" hidden>${icon("alert", 18)}<div class="body"></div></div>
    <form class="form"><label class="field">Email<input name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" required></label>
    <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn primary wide" type="submit">Sign in</button></form>
    <p class="note">Your password is checked against your mailbox and is never stored here.</p></div></section>
    <aside class="login-r"><q>Your assistant, with memory, tools and a plan.</q><ul class="points">${POINTS.map((p) => `<li><span class="pi">${icon(p.ic, 18)}</span><span><b>${esc(p.title)}</b><small>${esc(p.body)}</small></span></li>`).join("")}</ul></aside></div>`;
  enter($(".login", root), { y: 12 });
  const form = $("form", root), err = $(".card.err", root), btn = $("button[type=submit]", form);
  $(".close", root).addEventListener("click", () => { location.hash = "#/"; });
  form.email.focus({ preventScroll: true });
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); err.hidden = true; btn.disabled = true; btn.textContent = "Signing in…";
    try {
      await api("POST", "/api/login", { email: form.email.value, password: form.password.value });
      await refreshMe(); newChat(); location.hash = "#/";
    } catch (x) {
      $(".body", err).textContent = x.message || "Could not sign in."; err.hidden = false; shake(err); form.password.value = ""; form.password.focus();
    } finally { btn.disabled = false; btn.textContent = "Sign in"; }
  });
}
const hideLogin = () => { $("#login-root").innerHTML = ""; };

// ---- who am I / routing ------------------------------------------------------------------------------------------------
async function refreshMe() {
  try { S.me = await api("GET", "/api/me"); } catch { S.me = { mode: "public", address: null, capabilities: { login: false, tools: [], shell: false, history: "client" } }; toast("Can't reach the server."); }
  applyMode();
  if (user()) await refreshSessions(); else { S.sessions = []; S.history = loadHistory(); }
}
function applyMode() {
  const u = user();
  app.dataset.store = u ? "user" : "client";
  setupAttach();
  $("#btn-chats").hidden = !u; $("#btn-new").hidden = !u;
  $("#btn-account").innerHTML = S.me.address ? `<span class="avatar" style="width:30px;height:30px;font-size:.85rem">${esc(S.me.address[0])}</span>` : icon("user", 22);
  $("#fine").textContent = u ? "Saved to your account. The assistant can make mistakes." : "Your chat stays on this device. The assistant can make mistakes.";
  const side = $("#side");
  side.innerHTML = u ? `<div class="side-h"><div class="brand"><div class="logo">${icon("sparkle", 16)}</div>ChocoAI</div><button class="iconbtn" id="side-new" type="button" aria-label="New chat">${icon("plus", 20)}</button></div><div class="list" data-chatlist></div><div class="side-f"><button class="me" id="side-me" type="button"><span class="avatar">${esc(S.me.address?.[0] || "?")}</span><span>${esc(S.me.address || "")}</span></button></div>` : "";
  if (u) { $("#side-new").addEventListener("click", goNew); $("#side-me").addEventListener("click", accountSheet); fillList($("[data-chatlist]", side)); }
}
function goNew() { if (location.hash === "#/" || location.hash === "") newChat(); else location.hash = "#/"; input.focus(); }
function route(first) {
  const h = location.hash.replace(/^#/, "") || "/";
  if (h === "/login") return showLogin();
  hideLogin();
  const m = /^\/c\/(\d+)$/.exec(h);
  if (m && user()) return openSession(Number(m[1]));
  if (m) { location.hash = "#/"; return; }
  if (first === true || S.sid !== null) newChat();
}

// ---- boot ------------------------------------------------------------------------------------------------------------
function initViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const fit = () => { document.documentElement.style.setProperty("--app-h", vv.height + "px"); if (document.activeElement === input) scrollBottom(true); };
  vv.addEventListener("resize", fit); vv.addEventListener("scroll", () => window.scrollTo(0, 0)); fit();
}
function wire() {
  $("#btn-chats").innerHTML = icon("menu", 22); $("#btn-new").innerHTML = icon("plus", 22);
  jump.innerHTML = `${icon("arrowdown", 16)} Latest`;
  $("#attach").innerHTML = icon("paperclip", 22);
  $("#attach").addEventListener("click", () => $("#file").click());
  $("#file").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });
  input.addEventListener("paste", (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length && !$("#attach").hidden) { e.preventDefault(); addFiles(fs); } });
  const wrap = $("#composer-wrap");
  ["dragenter", "dragover"].forEach((t) => wrap.addEventListener(t, (e) => { if (!$("#attach").hidden && e.dataTransfer?.types.includes("Files")) { e.preventDefault(); wrap.classList.add("dropping"); } }));
  ["dragleave", "drop"].forEach((t) => wrap.addEventListener(t, () => wrap.classList.remove("dropping")));
  wrap.addEventListener("drop", (e) => { if (!$("#attach").hidden && e.dataTransfer?.files.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } });
  $("#btn-chats").addEventListener("click", chatsSheet); $("#btn-new").addEventListener("click", goNew);
  $("#btn-account").addEventListener("click", accountSheet);
  jump.addEventListener("click", () => { S.stick = true; msgs.scrollTo({ top: msgs.scrollHeight, behavior: "smooth" }); });
  msgs.addEventListener("scroll", onScroll, { passive: true });
  col.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]"); if (!b) return;
    await copy(b.closest(".code").querySelector("code").textContent); b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy"; }, 1500);
  });
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !coarse() && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); } });
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (S.busy) return stop();
    const text = input.value.trim();
    if (!text && !S.atts.length) return;
    if (attSize() > MAX_TOTAL_B64) return toast("That is too much to send at once. Remove a file.");
    const atts = S.atts; S.atts = []; renderAtts();
    input.value = ""; grow(); send(text, atts);
  });
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.install = e; });
  addEventListener("hashchange", () => route());
  setBusy(false);
}
async function boot() {
  wire(); initViewport();
  await refreshMe();
  route(true);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}
boot();
