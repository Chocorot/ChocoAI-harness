#!/usr/bin/env python3
"""Tiny coding-agent harness for small-context local models. Stdlib only."""
import argparse
import hmac
import http.client
import json
import os
import re
import shutil
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import attach
import auth
import automations
import db
import errors
import runq
import settings
import tools

VERSION = "0.8.0"
KEEPALIVE = 10  # seconds between SSE comment pings; keeps proxies (Cloudflare) from cutting a silent stream
MAX_BODY = 1_000_000  # bytes accepted on a request
DRAIN = 20_000_000  # most of a refused body we read before answering
AUTO_PATH = r"/api/automations(?:/(\d+)(/run)?)?"
ATTACH_BODY = 9_000_000  # signed-in chat requests may carry attachments (base64: up to ~6 MB of files)
BULKY = {"read_file", "web_fetch", "web_search"}  # results old enough to be re-fetched are replaced by a stub when compacting
HELPER_PROMPT = (" You are a helper working on one subtask for another agent. Do only that task, then finish with a short "
                 "summary (under 150 words) of what you found or did.")

COMPACT_AT = settings.default("compact_at")  # default only; the live value is settings.get("compact_at")


def load_env(path=".env"):
    if os.path.exists(path):
        for line in Path(path).read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("\"'"))


def est_tokens(messages):
    # shortcut: chars/4 heuristic, ~20% off for code/CJK; upgrade to backend usage counts if it matters
    return len(json.dumps(messages)) // 4


def compact(messages, limit=None, keep=None):
    """Shrink old tool traffic; keep system, original goal and the last `keep_turns` turns intact.
    `limit`/`keep` override the settings (used to shrink harder after a context overflow)."""
    if est_tokens(messages) <= (limit or settings.get("compact_at")):
        return messages
    keep = keep or settings.get("keep_turns")
    turns = [i for i, m in enumerate(messages) if m["role"] == "assistant"]
    if len(turns) <= keep:
        return messages
    cut = turns[-keep]  # a turn = assistant msg + its tool results, so cutting here never orphans a tool msg
    names = {tc["id"]: tc["function"]["name"] for m in messages[:cut] for tc in m.get("tool_calls", [])}
    out = messages[:2]
    for m in messages[2:cut]:
        if m["role"] == "tool":
            c = m["content"]
            if names.get(m["tool_call_id"]) in BULKY:
                c = f"[pruned {names[m['tool_call_id']]} output, {len(c)} chars]"
            elif len(c) > 200:
                c = c[:200] + f"... [truncated, {len(c)} chars]"
            m = {**m, "content": c}
        elif m.get("tool_calls"):  # write_file content / big edits dominate otherwise
            m = {**m, "tool_calls": [
                tc if len(tc["function"]["arguments"]) <= 300 else
                {**tc, "function": {**tc["function"], "arguments": json.dumps(
                    {"_pruned": f"{len(tc['function']['arguments'])} chars"})}}
                for tc in m["tool_calls"]]}
        out.append(m)
    return out + messages[cut:]


def cli_emit(ev):
    t = ev["t"]
    if t == "text":
        sys.stdout.write(ev["d"])
        sys.stdout.flush()
    elif t == "tool":
        print(f"\n[{ev['name']}] {json.dumps(ev['args'])[:80]}", file=sys.stderr)
    elif t == "result":
        print(f"  -> {ev['d'][:80]!r}", file=sys.stderr)


def parse_sse(lines, emit=cli_emit):
    """Consume SSE lines; emit text/think deltas, buffer tool_call deltas. Returns (message, usage).
    Thinking is shown via emit only, never stored in history (it would eat the 16K window)."""
    text, calls, usage = [], {}, {}
    for raw in lines:
        line = raw.decode() if isinstance(raw, bytes) else raw
        if not line.startswith("data:") or line[5:].strip() == "[DONE]":
            continue
        chunk = json.loads(line[5:])
        usage = chunk.get("usage") or usage
        for ch in chunk.get("choices", []):
            d = ch.get("delta", {})
            # shortcut: only the separate reasoning_content field; inline <think> tags are not split out
            if d.get("reasoning_content") or d.get("reasoning"):
                emit({"t": "think", "d": d.get("reasoning_content") or d["reasoning"]})
            if d.get("content"):
                text.append(d["content"])
                emit({"t": "text", "d": d["content"]})
            for tc in d.get("tool_calls") or []:
                c = calls.setdefault(tc.get("index", 0), {"id": "", "type": "function",
                                                          "function": {"name": "", "arguments": ""}})
                c["id"] = tc.get("id") or c["id"]
                f = tc.get("function", {})
                c["function"]["name"] = f.get("name") or c["function"]["name"]
                c["function"]["arguments"] += f.get("arguments") or ""
    msg = {"role": "assistant", "content": "".join(text) or None}
    if calls:
        msg["tool_calls"] = [calls[i] for i in sorted(calls)]
        for i, c in enumerate(msg["tool_calls"]):
            c["id"] = c["id"] or f"call_{i}"
    return msg, usage


def chat(messages, emit=cli_emit, schemas=None, max_tokens=None):
    """One streamed model call. `schemas` = the tools this caller may use (None = all; empty = none, key omitted)."""
    schemas = tools.SCHEMAS if schemas is None else schemas
    body = {"model": settings.get("model"), "messages": messages,
            "stream": True, "stream_options": {"include_usage": True}}
    if schemas:
        body["tools"] = schemas
    for k in ("temperature", "max_tokens"):  # optional: only sent when set
        if settings.get(k) is not None:
            body[k] = settings.get(k)
    if max_tokens:  # a caller-specific cap (public visitors) wins over the saved value
        body["max_tokens"] = min(max_tokens, body.get("max_tokens", max_tokens))
    req = urllib.request.Request(
        os.environ.get("BASE_URL", "http://localhost:1235/v1").rstrip("/") + "/chat/completions",
        json.dumps(body).encode(),
        {"Content-Type": "application/json",
         "Authorization": "Bearer " + os.environ.get("API_KEY", "lm-studio")})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return parse_sse(r, emit)
    except (OSError, http.client.HTTPException, ValueError) as e:  # backend down/slow/erroring or a garbled stream
        raise errors.from_upstream(e) from e


def call_model(messages, emit, chat_fn, sleep=time.sleep, prep=None):
    """One model call with recovery. Transient failures are retried (settings `retries`, backoff in errors.BACKOFF);
    a context overflow is retried once with the history shrunk harder. Returns (message, usage, what_was_sent).
    Raises HarnessError. `retrying.reset` tells the page to discard a half-streamed reply before the retry.
    `prep` turns the compacted messages into what the backend gets (photos become data URLs); `sent` stays the small form."""
    sent, shrunk, attempt = compact(messages), False, 0
    prep = prep or (lambda m: m)
    while True:
        streamed = []

        def spy(ev):
            if ev["t"] in ("text", "think"):
                streamed.append(1)
            emit(ev)

        try:
            msg, usage = chat_fn(prep(sent), spy)
            return msg, usage, sent
        except Exception as e:
            err = errors.classify(e)  # chat() already turned backend failures into HarnessError
            if err.kind == "context_overflow" and not shrunk:
                shrunk, smaller = True, compact(messages, 1, max(1, settings.get("keep_turns") // 2))
                if est_tokens(smaller) < est_tokens(sent):
                    sent = smaller
                    emit({"t": "retrying", "attempt": attempt, "in": 0, "kind": err.kind, "msg": "Shrinking the history to fit.",
                          "reset": bool(streamed)})
                    continue
            elif err.auto and attempt < settings.get("retries"):
                wait = errors.BACKOFF[min(attempt, len(errors.BACKOFF) - 1)]
                attempt += 1
                emit({"t": "retrying", "attempt": attempt, "in": wait, "kind": err.kind, "msg": err.message,
                      "reset": bool(streamed)})
                sleep(wait)
                continue
            raise err from e


def repair_tail(conn, sid, messages):
    """A crash between an assistant message with tool calls and its tool results leaves calls without results, which
    the backend rejects on resume. Add a stub result for each missing one (in memory and in the DB)."""
    i = len(messages)
    while i and messages[i - 1]["role"] == "tool":
        i -= 1
    if not i or not messages[i - 1].get("tool_calls"):
        return
    done = {m["tool_call_id"] for m in messages[i:]}
    for tc in messages[i - 1]["tool_calls"]:
        if tc["id"] not in done:
            m = {"role": "tool", "tool_call_id": tc["id"], "content": tools.err(
                "interrupted", "the run stopped before this tool finished", "call it again if it is still needed")}
            messages.append(m)
            db.save_msg(conn, sid, m)


class DbStore:
    """Where a session run saves its messages, token usage and tool audit rows."""

    def __init__(self, conn, sid):
        self.conn, self.sid = conn, sid

    def msg(self, m):
        db.save_msg(self.conn, self.sid, m)

    def usage(self, turn, usage, est):
        db.log_usage(self.conn, self.sid, turn, usage.get("prompt_tokens"), usage.get("completion_tokens"), est)

    def tool(self, name, args, result):
        db.log_tool(self.conn, self.sid, name, args, result)


class HelperStore:
    """A helper's (delegate) conversation is thrown away; only its tool calls are audited, in the parent's session."""

    def __init__(self, parent):
        self.parent = parent

    def msg(self, m):
        pass

    def usage(self, turn, usage, est):
        pass

    def tool(self, name, args, result):
        self.parent.tool(name, args, result)


class Run:
    """Everything one agent loop needs. A helper gets a copy with fewer tools and its own chat function."""

    def __init__(self, store, ws, auto_approve, emit, allow, chat_fn, deadline, depth=0, chat_for=None):
        self.store, self.ws, self.auto_approve, self.emit, self.allow = store, ws, auto_approve, emit, allow
        self.chat_fn, self.deadline, self.depth, self.chat_for = chat_fn, deadline, depth, chat_for


def plan_steps(raw):
    """Clean the model's plan: up to 20 steps of {text, status}. Plain strings are accepted as todo steps."""
    out = []
    for x in raw if isinstance(raw, list) else []:
        text, status = (x.get("text"), x.get("status")) if isinstance(x, dict) else (x, None)
        if isinstance(text, str) and text.strip():
            out.append({"text": text.strip()[:200], "status": status if status in ("todo", "doing", "done") else "todo"})
    return out[:20]


def tool_update_plan(run, call_id, args):
    steps = plan_steps(args.get("steps"))
    if not steps:
        return tools.err("bad_args", "steps must be a non-empty list", 'send [{"text": "...", "status": "todo"}]')
    run.emit({"t": "plan", "steps": steps})
    return f"ok: plan has {len(steps)} steps, {sum(x['status'] == 'done' for x in steps)} done"


def tool_delegate(run, call_id, args):
    """Run a subtask in a fresh context. Only its final summary comes back, so the parent's window stays small."""
    task = args.get("task")
    if not isinstance(task, str) or not task.strip():
        return tools.err("bad_args", "task must be text", "describe the subtask in a sentence or two")
    names = list(tools.TOOLS) if run.allow is None else run.allow
    allow = [n for n in names if n not in tools.AGENT]  # helpers can't plan or delegate further
    sub = Run(HelperStore(run.store), run.ws, run.auto_approve, lambda ev: run.emit({**ev, "sub": call_id}), allow,
              run.chat_for(allow), run.deadline, run.depth + 1, run.chat_for)
    messages = [{"role": "system", "content": system_text(allow) + HELPER_PROMPT}, {"role": "user", "content": task.strip()}]
    try:
        out = agent_loop(sub, messages, settings.get("delegate_turns"))
    except errors.HarnessError as e:
        return tools.err("delegate_failed", e.message, "do the subtask yourself or try again")
    return out[:3000] or "(the helper returned nothing)"


AGENT_TOOLS = {"update_plan": tool_update_plan, "delegate": tool_delegate}  # tools that need the run, see tools.AGENT


def call_tool(run, tc):
    name = tc["function"]["name"]
    run.emit({"t": "status", "phase": "tool", "name": name})
    try:
        args = json.loads(tc["function"]["arguments"] or "{}")
        run.emit({"t": "tool", "id": tc["id"], "name": name, "args": args})
        if not isinstance(args, dict):
            result = tools.err("bad_args", "arguments must be a JSON object", "")
        elif bad := tools.forbidden(name, run.allow):
            result = bad
        elif name in AGENT_TOOLS:
            result = AGENT_TOOLS[name](run, tc["id"], args)
        else:
            result = tools.run(name, args, run.ws, run.auto_approve, run.allow)
    except json.JSONDecodeError as e:
        args = tc["function"]["arguments"]
        result = tools.err("bad_args", f"invalid JSON arguments: {e}", "resend the call with valid JSON")
        run.emit({"t": "tool", "id": tc["id"], "name": name, "args": args})
    run.emit({"t": "result", "id": tc["id"], "d": str(result)[:2000], "ok": not str(result).startswith("error")})
    run.store.tool(name, args, result)
    return {"role": "tool", "tool_call_id": tc["id"], "content": str(result)}


def agent_loop(run, messages, max_turns):
    """Act, look at the result, think again, until the model answers without tool calls. Returns the final text, or
    `[stopped: ...]` when a budget (turns, seconds, tokens) ran out; that also emits a `notice` event."""
    spent = 0

    def stop(reason, msg):
        run.emit({"t": "notice", "kind": "budget", "reason": reason, "msg": msg})
        return f"[stopped: {reason}]"

    for turn in range(max_turns):
        if time.time() > run.deadline:
            return stop(f"max_seconds={settings.get('max_seconds')} reached", "Stopped: the time limit for one run was reached. Say 'continue' to go on.")
        if spent > settings.get("max_run_tokens"):
            return stop(f"max_run_tokens={settings.get('max_run_tokens')} reached", "Stopped: the token limit for one run was reached. Say 'continue' to go on.")
        run.emit({"t": "status", "phase": "model", "turn": turn + 1, "max": max_turns})
        msg, usage, sent = call_model(messages, run.emit, run.chat_fn, prep=lambda m: attach.expand(m, run.ws))
        spent += (usage.get("prompt_tokens") or 0) + (usage.get("completion_tokens") or 0) or est_tokens(sent)
        run.store.usage(turn, usage, est_tokens(sent))
        messages.append(msg)
        run.store.msg(msg)
        if not msg.get("tool_calls"):
            return msg["content"] or ""
        for tc in msg["tool_calls"]:
            tm = call_tool(run, tc)
            messages.append(tm)
            run.store.msg(tm)
    return stop(f"max_turns={max_turns} reached", f"Stopped after {max_turns} steps. Say 'continue' to go on.")


def run_agent(conn, sid, messages, ws, auto_approve, max_turns=None, chat_fn=None, emit=cli_emit, allow=None):
    """One run of a session. Returns the final text.
    `allow`: tool names this caller may use (None = all). Enforced in the schemas sent AND when a call comes back.
    Any failure is saved into the session as a note (so the model's next turn knows) and raised as a HarnessError."""
    max_turns = max_turns or settings.get("max_turns")  # an explicit value (CLI flag) wins over the saved setting
    def chat_for(names):  # the model function for a caller allowed `names` (None = all tools); `chat` is looked up
        if chat_fn:  # when called so tests can patch it, and a custom chat_fn (tests) serves helpers too
            return chat_fn
        schemas = None if names is None else tools.schemas_for(names)
        return lambda m, e: chat(m, e, schemas)

    run = Run(DbStore(conn, sid), ws, auto_approve, emit, allow, chat_for(allow), time.time() + settings.get("max_seconds"), 0, chat_for)
    try:
        return agent_loop(run, messages, max_turns)
    except Exception as e:
        err = errors.classify(e)
        repair_tail(conn, sid, messages)  # keep the history valid before the note goes in
        note = {"role": "assistant", "content": err.note()}
        messages.append(note)
        run.store.msg(note)
        raise err from e


def run_public(history, emit, chat_fn=None):
    """Stateless chat for visitors: nothing is stored here, the page keeps the history. No tools. A failure is raised
    as a HarnessError whose `note()` the page keeps in its history, like the saved note of a signed-in session."""
    chat_fn = chat_fn or (lambda m, e: chat(m, e, [], settings.get("public_max_tokens")))
    msg, _, _ = call_model([{"role": "system", "content": settings.get("public_prompt")}, *history], emit, chat_fn)
    return msg["content"] or ""


def trim_history(history, max_chars):
    """Drop the oldest messages until the history fits. Returns (kept, dropped). The last message always stays."""
    size = lambda h: sum(len(m["content"]) for m in h)
    kept = list(history)
    while len(kept) > 1 and size(kept) > max_chars:
        kept.pop(0)
    while kept and kept[0]["role"] != "user":  # a window must start with the user
        kept.pop(0)
    return kept, len(history) - len(kept)


def system_text(allow=None):
    """The saved system prompt plus one hint per tool this caller may use (allow=None: just the saved prompt)."""
    return " ".join(x for x in (settings.get("system_prompt"), tools.prompts_for(allow) if allow is not None else "") if x)


def start(conn, goal, session, retry=False, allow=None, content=None, title=None):
    """Create or resume a session, add the goal as a user message. Returns (sid, messages).
    `retry` removes the failure note of the last run so the model simply continues where it stopped."""
    if session:
        if not db.session_exists(conn, session):
            raise errors.HarnessError("not_found", f"no such session: {session}")
        sid, messages = session, db.load(conn, session)
        if retry and messages and messages[-1]["role"] == "assistant" and \
                (messages[-1].get("content") or "").startswith(errors.NOTE_PREFIX):
            messages.pop()
            db.drop_last(conn, sid)
        repair_tail(conn, sid, messages)
        if messages and messages[0]["role"] == "system":  # a saved prompt edit applies to resumed sessions too
            messages[0] = {"role": "system", "content": system_text(allow)}
    else:
        sid = db.new_session(conn, title or goal)
        messages = [{"role": "system", "content": system_text(allow)}]
        db.save_msg(conn, sid, messages[0])
    if goal:
        messages.append({"role": "user", "content": content if content is not None else goal})
        db.save_msg(conn, sid, messages[-1])
    return sid, messages


def manifest(busy):
    """Self-description for the dashboard: what this harness is, its settings (from settings.FIELDS) and totals."""
    conn = db.connect()
    try:
        stats = db.stats(conn)
    finally:
        conn.close()
    return {"kind": "choco-harness", "name": "ChocoAI harness", "version": VERSION, "status": "busy" if busy else "idle",
            "backend": {"baseUrl": os.environ.get("BASE_URL", "http://localhost:1235/v1"), "model": settings.get("model")},
            "settings": settings.manifest(), "stats": stats}


WEB = Path(__file__).with_name("web")
TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png"}
# no inline scripts anywhere (theme.js is a file), so scripts may only come from us; inline style attributes are allowed
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
       "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


def static_file(path):
    """The file under web/ for a URL path, or None. Only known file types, no dotfiles, nothing outside web/, no web/test."""
    rel = "index.html" if path in ("/", "/index.html") else path.lstrip("/")
    root = WEB.resolve()
    p = (root / rel).resolve()
    if p.suffix not in TYPES or not p.is_file() or not p.is_relative_to(root):
        return None
    parts = p.relative_to(root).parts
    return None if parts[0] == "test" or any(x.startswith(".") for x in parts) else p


class ClientGone(Exception):
    """The browser left while its run was still waiting in line: drop it quietly."""


class Sse:
    """Server-sent events writer. Thread-safe (run thread + keepalive thread); remembers when the client has left."""

    def __init__(self, wfile):
        self.w, self.lock, self.alive = wfile, threading.Lock(), True

    def _write(self, data):
        with self.lock:
            if self.alive:
                try:
                    self.w.write(data)
                    self.w.flush()
                except OSError:  # client left; let a running run finish so history stays consistent
                    self.alive = False

    def event(self, ev):
        self._write(b"data: " + json.dumps(ev).encode() + b"\n\n")

    def ping(self):
        self._write(b": ka\n\n")  # SSE comment: ignored by the page, resets proxy idle timers


def keepalive(sse, stop):
    while not stop.wait(KEEPALIVE):  # module global read each loop so tests can shorten it
        sse.ping()


def make_server(host, port, ws, max_turns, scheduler=False):
    queue = runq.RunQueue(lambda: settings.get("max_queue"))  # one agent run at a time: the local model serves one stream
    public_hits, login_fails = auth.Throttle(), auth.Throttle()  # per server, so tests stay isolated
    active = set()  # (address, session id) of runs that are executing now, so a page that came back can tell

    def run_automation(owner, name, prompt):
        """One scheduled run as `owner`: a new saved chat titled with the job's name. Unattended jobs read web pages, so they
        never get the shell, even when the owner has it. Returns (status text, session id)."""
        mode = auth.mode_for(owner)
        allow = [t for t in auth.MODES[mode]["tools"] if t != "run_bash"]
        conn, sid = db.connect(auth.db_path(owner)), None
        try:
            with queue.slot(prio=auth.MODES[mode]["prio"] + 0.5):  # after live chats, before visitors
                sid, messages = start(conn, prompt, None, False, allow, title="\u23f0 " + name)
                active.add((owner, sid))
                try:
                    run_agent(conn, sid, messages, auth.session_ws(ws, owner, sid), True, max_turns, emit=lambda ev: None, allow=allow)
                finally:
                    active.discard((owner, sid))
            return "ok", sid
        except errors.HarnessError as e:
            return f"{e.kind}: {e.message}", sid
        finally:
            conn.close()

    sched = automations.Scheduler(run_automation)

    class H(BaseHTTPRequestHandler):
        sse = None  # set once this request turned into an event stream
        sid = None

        def _send(self, code, body, ctype="application/json", headers=()):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            for k, v in (("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "same-origin"),
                         ("X-Frame-Options", "DENY"), *headers):
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _guard(self, fn):
            """Run a handler. Whatever fails becomes a typed error reply (JSON, or an SSE error event once streaming):
            the socket is never closed silently."""
            rid = uuid.uuid4().hex[:8]
            try:
                fn(rid)
            except ClientGone:
                pass
            except Exception as e:
                err = errors.classify(e)
                if err.kind == "internal":
                    traceback.print_exc()
                if err.kind not in ("auth", "not_found", "bad_request", "busy", "forbidden", "rate_limited"):  # client mistakes only fill the log
                    self._log(rid, err)
                try:
                    self.sse.event(err.event(rid)) if self.sse else self._send(err.status, err.body(rid))
                except OSError:
                    pass  # client already gone

        def _log(self, rid, err):
            print(json.dumps({"ts": round(time.time(), 3), "rid": rid, "session": self.sid, "kind": err.kind,
                              "code": err.code, "msg": err.message, "detail": err.detail[:300]}), file=sys.stderr)
            try:
                conn = db.connect()
                try:
                    db.log_error(conn, rid, self.sid, err)
                finally:
                    conn.close()
            except Exception:  # logging must never hide the real reply
                pass

        # ---- who is calling -------------------------------------------------------------------------------------
        def _who(self):
            """(mode, address). Bearer HARNESS_TOKEN = admin; a valid sign-in cookie = user; anything else = public."""
            tok = os.environ.get("HARNESS_TOKEN")
            if tok and hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {tok}"):
                return "admin", None
            addr = auth.read_cookie(auth.cookie_from(self.headers.get("Cookie")) or "")
            return (auth.mode_for(addr), addr) if addr else ("public", None)

        def _need_user(self):
            addr = self._who()[1]
            if not addr:
                raise errors.HarnessError("auth", "Sign in to use saved chats.")
            return addr

        def _ip(self):
            if os.environ.get("HARNESS_TRUST_PROXY") == "1":  # only when every request really comes through our own proxy/tunnel
                fwd = self.headers.get("CF-Connecting-IP") or self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
                if fwd:
                    return fwd
            return self.client_address[0]

        def _same_origin(self):
            """Cookie requests must come from our own page (on top of SameSite=Lax)."""
            origin = self.headers.get("Origin")
            if origin and urllib.parse.urlparse(origin).netloc != self.headers.get("Host"):
                raise errors.HarnessError("forbidden")

        def _json_body(self, limit=MAX_BODY):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = -1
            if not 0 < n <= limit:
                left = min(max(n, 0), DRAIN)  # read the body we refuse (bounded), or the client sees a reset, not our answer
                while left > 0 and (chunk := self.rfile.read(min(65536, left))):
                    left -= len(chunk)
                raise errors.HarnessError("bad_request", "Request body is missing or too large.")
            try:
                req = json.loads(self.rfile.read(n))
            except ValueError:
                raise errors.HarnessError("bad_request", "Request body must be JSON.") from None
            if not isinstance(req, dict):
                raise errors.HarnessError("bad_request", "Request body must be a JSON object.")
            return req

        # ---- admin API for the dashboard ------------------------------------------------------------------------
        def _manage(self, method):
            """Admin API for the dashboard (via the node agent). Its own token, independent of /task. No token set = no API."""
            tok = os.environ.get("HARNESS_ADMIN_TOKEN")
            if not tok:
                return self._send(404, {"error": "not found"})
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), f"Bearer {tok}".encode()):
                return self._send(401, {"error": "unauthorized"})
            url = urllib.parse.urlparse(self.path)
            if method == "GET" and url.path == "/manage/manifest":
                return self._send(200, manifest(queue.busy()))
            if method == "GET" and url.path in ("/manage/sessions", "/manage/errors"):
                try:
                    limit = max(1, min(200, int(urllib.parse.parse_qs(url.query).get("limit", ["50"])[0])))
                except ValueError:
                    return self._send(400, {"error": "limit must be a number"})
                conn = db.connect()
                try:
                    if url.path == "/manage/errors":
                        return self._send(200, {"errors": db.list_errors(conn, limit)})
                    return self._send(200, {"sessions": db.list_sessions(conn, limit)})
                finally:
                    conn.close()
            if method == "PUT" and url.path == "/manage/settings":
                try:
                    req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                except ValueError:
                    return self._send(400, {"error": "body must be JSON"})
                _, err = settings.save(req.get("settings") if isinstance(req, dict) else None)
                if err:
                    return self._send(400, {"error": err})
                return self._send(200, manifest(queue.busy()))
            self._send(404, {"error": "not found"})

        # ---- routing --------------------------------------------------------------------------------------------
        def do_PUT(self):
            self._guard(lambda rid: self._manage("PUT") if self.path.startswith("/manage/")
                        else self._send(404, {"error": "not found"}))

        def do_GET(self):
            self._guard(self._get)

        def do_POST(self):
            self._guard(self._post)

        def do_DELETE(self):
            self._guard(self._delete)

        def _get(self, rid):
            path = urllib.parse.urlparse(self.path).path
            if path.startswith("/manage/"):
                return self._manage("GET")
            if path == "/health":
                return self._send(200, {"ok": True})
            if (f := static_file(path)):  # the public app; the API decides what a caller may do
                return self._send(200, f.read_bytes(), TYPES[f.suffix], headers=[("Cache-Control", "no-cache"), *([("Content-Security-Policy", CSP)] if f.suffix == ".html" else [])])
            if path == "/api/me":
                return self._me()
            if path == "/api/sessions":
                return self._send(200, {"sessions": self._with_user_db(lambda conn: db.list_sessions(conn, 100))})
            m = re.fullmatch(r"/api/sessions/(\d+)", path)
            if m:
                return self._session_get(int(m.group(1)))
            m = re.fullmatch(r"/api/sessions/(\d+)/uploads/(\w[\w.\-]{0,99})", path)
            if m:
                return self._upload_get(int(m.group(1)), m.group(2))
            if path == "/api/automations":
                return self._automations("GET", path)
            raise errors.HarnessError("not_found")

        def _post(self, rid):
            path = urllib.parse.urlparse(self.path).path
            if path == "/task":
                return self._task()
            if path in ("/api/login", "/api/logout", "/api/chat"):
                self._same_origin()
                return {"/api/login": self._login, "/api/logout": self._logout, "/api/chat": self._chat}[path]()
            if re.fullmatch(AUTO_PATH, path):
                return self._automations("POST", path)
            raise errors.HarnessError("not_found")

        def do_PATCH(self):
            self._guard(lambda rid: self._automations("PATCH", urllib.parse.urlparse(self.path).path))

        def _delete(self, rid):
            path = urllib.parse.urlparse(self.path).path
            if re.fullmatch(AUTO_PATH, path):
                return self._automations("DELETE", path)
            self._same_origin()
            m = re.fullmatch(r"/api/sessions/(\d+)", path)
            if not m:
                raise errors.HarnessError("not_found")
            addr, sid = self._need_user(), int(m.group(1))

            def drop(conn):
                if not db.session_exists(conn, sid):
                    raise errors.HarnessError("not_found")
                db.delete_session(conn, sid)

            self._with_user_db(drop)
            shutil.rmtree(auth.session_ws(ws, addr, sid, create=False), ignore_errors=True)
            self._send(200, {"ok": True})

        def _automations(self, method, path):
            """Scheduled prompts of the signed-in caller (their own DB only)."""
            if method != "GET":
                self._same_origin()
            addr = self._need_user()
            m = re.fullmatch(AUTO_PATH, path)
            if not m:
                raise errors.HarnessError("not_found")
            aid, run = (int(m.group(1)) if m.group(1) else None), bool(m.group(2))

            def work(conn):
                if aid is None:
                    if method == "GET":
                        return {"automations": automations.listing(conn)}
                    if method == "POST":
                        return automations.create(conn, addr, self._json_body(), time.time())
                    raise errors.HarnessError("not_found")
                if method == "PATCH" and not run:
                    return automations.update(conn, aid, self._json_body(), time.time())
                if method == "DELETE" and not run:
                    automations.delete(conn, aid)
                    return {"ok": True}
                if method == "POST" and run:
                    automations.get(conn, aid)
                    if not sched.run_now(addr, aid):
                        raise errors.HarnessError("bad_request", "That automation is already running.")
                    return {"ok": True}
                raise errors.HarnessError("not_found")

            self._send(200, self._with_user_db(work))

        # ---- identity endpoints ---------------------------------------------------------------------------------
        def _me(self):
            mode, addr = self._who()
            rule = auth.MODES[mode]
            self._send(200, {"mode": mode, "address": addr, "capabilities": {
                "login": auth.enabled(), "tools": rule["tools"], "shell": "run_bash" in rule["tools"],
                "history": rule["store"], "automations": rule["store"] == "user" and settings.get("max_automations") > 0,
                "timezone": os.environ.get("HARNESS_TZ") or "UTC",
                "attachments": {"image": rule["store"] == "user" and settings.get("vision"),
                                "documents": sorted(attach.READERS) if rule["store"] == "user" else []}}})

        def _login(self):
            if not auth.enabled():
                raise errors.HarnessError("not_found")
            req = self._json_body()
            ip, addr, pw = self._ip(), auth.normalize(req.get("email")), auth.check_password(req.get("password"))
            if login_fails.blocked(ip, 20, 600) or login_fails.blocked(addr, 5, 600):
                raise errors.HarnessError("rate_limited", "Too many sign-in attempts. Try again in a few minutes.")
            if not auth.verify_password(addr, pw):  # same answer for a wrong password and an unknown mailbox
                login_fails.hit(ip, 600)
                login_fails.hit(addr, 600)
                raise errors.HarnessError("auth", "Incorrect email or password.")
            secure = "" if os.environ.get("HARNESS_INSECURE_COOKIES") == "1" else "; Secure"
            cookie = f"{auth.COOKIE}={auth.make_cookie(addr)}; Path=/; Max-Age={auth.MAX_AGE}; HttpOnly; SameSite=Lax{secure}"
            self._send(200, {"ok": True, "address": addr, "mode": auth.mode_for(addr)}, headers=[("Set-Cookie", cookie)])

        def _logout(self):
            self._send(200, {"ok": True}, headers=[("Set-Cookie", f"{auth.COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")])

        # ---- saved chats (per-user DB) --------------------------------------------------------------------------
        def _with_user_db(self, fn):
            conn = db.connect(auth.db_path(self._need_user()))
            try:
                return fn(conn)
            finally:
                conn.close()

        def _session_get(self, sid):
            def load(conn):
                if not db.session_exists(conn, sid):
                    raise errors.HarnessError("not_found")
                return [{**m, "note": True} if isinstance(m.get("content"), str) and m["content"].startswith(errors.NOTE_PREFIX) else m
                        for m in db.load(conn, sid) if m["role"] != "system"]

            addr = self._need_user()
            self._send(200, {"id": sid, "running": (addr, sid) in active, "messages": self._with_user_db(load)})

        def _upload_get(self, sid, name):
            """A file the owner attached to one of their own chats (photo thumbnails in the page, document downloads)."""
            addr = self._need_user()

            def check(conn):
                if not db.session_exists(conn, sid):
                    raise errors.HarnessError("not_found")

            self._with_user_db(check)
            f = auth.session_ws(ws, addr, sid, create=False) / "uploads" / name
            if not f.is_file():
                raise errors.HarnessError("not_found")
            kind = attach.IMAGE_MIME.get(f.suffix.lstrip(".").lower())
            self._send(200, f.read_bytes(), kind or "application/octet-stream", headers=[
                ("Content-Security-Policy", "default-src 'none'; sandbox"), ("Cache-Control", "private, max-age=3600"),
                *([] if kind else [("Content-Disposition", f'attachment; filename="{name}"')])])

        # ---- running the model ----------------------------------------------------------------------------------
        def _begin(self, stream):
            """Open the event stream (and its keepalive) when `stream`. Returns (emit, stop)."""
            if not stream:
                return (lambda ev: None), None
            self.send_response(200)  # no Content-Length: HTTP/1.0 close-delimited body
            for k, v in (("Content-Type", "text/event-stream"), ("Cache-Control", "no-cache"),
                         ("X-Accel-Buffering", "no")):
                self.send_header(k, v)
            self.end_headers()
            self.sse = Sse(self.wfile)
            stop = threading.Event()
            threading.Thread(target=keepalive, args=(self.sse, stop), daemon=True).start()
            return self.sse.event, stop

        def _on_wait(self, emit):
            def on_wait(ahead):
                if self.sse and not self.sse.alive:
                    raise ClientGone
                emit({"t": "queued", "pos": ahead})
            return on_wait

        def _task(self):
            tok = os.environ.get("HARNESS_TOKEN")
            if not tok:  # /task runs shell commands: no token set = no endpoint
                raise errors.HarnessError("not_found")
            if not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {tok}"):
                raise errors.HarnessError("auth")
            req = self._json_body()
            self._run(req, "admin", None, bool(req.get("stream")))

        def _chat(self):
            mode, addr = self._who()
            req = self._json_body(ATTACH_BODY if addr else MAX_BODY)
            if mode == "public":
                return self._chat_public(req)
            self._run(req, mode, addr, req.get("stream", True) is not False)

        def _run(self, req, mode, addr, stream):
            """A session run for a caller with storage: admin (the original DB) or a signed-in user (their own DB)."""
            rule = auth.MODES[mode]
            goal, session, retry = req.get("goal"), req.get("session"), bool(req.get("retry"))
            atts = req.get("attachments")
            if atts and not addr:
                raise errors.HarnessError("bad_request", "Attachments need a signed-in account.")
            if atts and not goal:
                goal = "Please look at the attached file."
            if not goal and not session:
                raise errors.HarnessError("bad_request", "goal or session required")
            if session is not None and (isinstance(session, bool) or not isinstance(session, int)):
                raise errors.HarnessError("bad_request", "session must be a number")
            if goal is not None and (not isinstance(goal, str) or len(goal) > MAX_BODY):
                raise errors.HarnessError("bad_request", "goal must be text")
            doc_text, images, saves = attach.process(atts, settings.get("vision"))  # validated before anything is created
            path = auth.db_path(addr) if addr else None  # None = the original (admin) DB
            if session:  # answer 404 as plain HTTP, before an event stream is opened
                conn = db.connect(path)
                try:
                    if not db.session_exists(conn, session):
                        raise errors.HarnessError("not_found", f"no such session: {session}")
                finally:
                    conn.close()
            emit, stop = self._begin(stream)
            try:
                with queue.slot(prio=rule["prio"], on_wait=self._on_wait(emit), tick=KEEPALIVE):
                    conn = db.connect(path)
                    try:
                        sid, messages = start(conn, goal, session, retry, rule["tools"], attach.content(goal or "", doc_text, images))
                        self.sid = sid
                        emit({"t": "session", "id": sid})
                        run_ws = auth.session_ws(ws, addr, sid) if addr else ws
                        attach.save(run_ws, images + saves)
                        active.add((addr, sid))
                        try:
                            reply = run_agent(conn, sid, messages, run_ws, True, max_turns, emit=emit, allow=rule["tools"])
                        finally:
                            active.discard((addr, sid))
                        if self.sse:
                            emit({"t": "done"})
                        else:
                            self._send(200, {"session": sid, "reply": reply})
                    finally:
                        conn.close()
            finally:
                if stop:
                    stop.set()

        def _chat_public(self, req):
            """Visitors: chat only, history kept by the page, rate limited, short line, capped reply."""
            msgs, cap = req.get("messages"), settings.get("public_max_chars")
            if not isinstance(msgs, list) or not 1 <= len(msgs) <= 200:
                raise errors.HarnessError("bad_request", "messages must be a list of 1 to 200 items.")
            clean = []
            for m in msgs:
                if not isinstance(m, dict) or m.get("role") not in ("user", "assistant") or \
                        not isinstance(m.get("content"), str) or not m["content"].strip():
                    raise errors.HarnessError("bad_request", "Each message needs a role (user or assistant) and text.")
                clean.append({"role": m["role"], "content": m["content"]})
            if clean[-1]["role"] != "user":
                raise errors.HarnessError("bad_request", "The last message must come from the user.")
            if len(clean[-1]["content"]) > cap:
                raise errors.HarnessError("bad_request", "That message is too long.")
            if not public_hits.allow(self._ip(), settings.get("public_rpm"), 60):
                raise errors.HarnessError("rate_limited")
            kept, dropped = trim_history(clean, cap)
            emit, stop = self._begin(True)
            try:
                if dropped:
                    emit({"t": "trimmed", "dropped": dropped})
                with queue.slot(prio=auth.MODES["public"]["prio"], on_wait=self._on_wait(emit), tick=KEEPALIVE,
                                limit=settings.get("max_queue_public")):
                    run_public(kept, emit)
                    emit({"t": "done"})
            finally:
                stop.set()

    srv = ThreadingHTTPServer((host, port), H)
    srv.scheduler = sched  # tests drive it with sched.tick(now); main() starts its thread
    if scheduler:
        sched.start()
    return srv


def main():
    load_env()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("goal", nargs="?", help="task for the agent (with --session: follow-up message)")
    ap.add_argument("--session", type=int, help="resume session id")
    ap.add_argument("--workspace", default="workspace", help="sandbox dir (default ./workspace)")
    ap.add_argument("--auto-approve", action="store_true", help="run bash without y/N prompt")
    ap.add_argument("--max-turns", type=int, default=None, help="override the saved max_turns setting (default 15)")
    ap.add_argument("--serve", type=int, metavar="PORT", help="run HTTP server: GET /health, POST /task")
    ap.add_argument("--host", default="127.0.0.1", help="bind address for --serve")
    a = ap.parse_args()
    ws = Path(a.workspace).resolve()
    ws.mkdir(parents=True, exist_ok=True)
    if a.serve:
        if not a.auto_approve:
            sys.exit("--serve needs --auto-approve (no TTY for y/N prompts)")
        if not auth.enabled():
            print("sign-in is OFF (set HARNESS_SESSION_KEY, 16+ characters): everybody is a public visitor", file=sys.stderr)
        if not os.environ.get("HARNESS_TOKEN"):
            print("/task is OFF (set HARNESS_TOKEN to enable it)", file=sys.stderr)
        print(f"serving on {a.host}:{a.serve}", file=sys.stderr)
        return make_server(a.host, a.serve, ws, a.max_turns, scheduler=True).serve_forever()
    conn = db.connect()
    if not a.goal and not a.session:
        ap.error("give a goal or --session")
    try:
        sid, messages = start(conn, a.goal, a.session, allow=auth.MODES["admin"]["tools"])
    except errors.HarnessError as e:
        sys.exit(e.message)
    print(f"[session {sid}]", file=sys.stderr)
    try:
        reply = run_agent(conn, sid, messages, ws, a.auto_approve, a.max_turns)
    except errors.HarnessError as e:
        sys.exit(f"{e.message} [{e.kind}/{e.code}] (session {sid} saved; resume with --session {sid})")
    print("\n" + reply if reply.startswith("[stopped") else "")


if __name__ == "__main__":
    main()
