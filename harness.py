#!/usr/bin/env python3
"""Tiny coding-agent harness for small-context local models. Stdlib only."""
import argparse
import hmac
import http.client
import json
import os
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import db
import errors
import runq
import settings
import tools

VERSION = "0.3.0"
KEEPALIVE = 10  # seconds between SSE comment pings; keeps proxies (Cloudflare) from cutting a silent stream
MAX_BODY = 1_000_000  # bytes accepted on /task

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
            if names.get(m["tool_call_id"]) == "read_file":
                c = f"[pruned read_file output, {len(c)} chars]"
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


def chat(messages, emit=cli_emit):
    body = {"model": settings.get("model"), "messages": messages,
            "tools": tools.SCHEMAS, "stream": True, "stream_options": {"include_usage": True}}
    for k in ("temperature", "max_tokens"):  # optional: only sent when set
        if settings.get(k) is not None:
            body[k] = settings.get(k)
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


def call_model(messages, emit, chat_fn, sleep=time.sleep):
    """One model call with recovery. Transient failures are retried (settings `retries`, backoff in errors.BACKOFF);
    a context overflow is retried once with the history shrunk harder. Returns (message, usage, what_was_sent).
    Raises HarnessError. `retrying.reset` tells the page to discard a half-streamed reply before the retry."""
    sent, shrunk, attempt = compact(messages), False, 0
    while True:
        streamed = []

        def spy(ev):
            if ev["t"] in ("text", "think"):
                streamed.append(1)
            emit(ev)

        try:
            msg, usage = chat_fn(sent, spy)
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


def run_agent(conn, sid, messages, ws, auto_approve, max_turns=None, chat_fn=None, emit=cli_emit):
    """Loop until the model answers without tool calls. Returns the final text.
    Any failure is saved into the session as a note (so the model's next turn knows) and raised as a HarnessError."""
    chat_fn = chat_fn or chat  # resolved at call time so tests can patch it
    max_turns = max_turns or settings.get("max_turns")  # an explicit value (CLI flag) wins over the saved setting
    try:
        for turn in range(max_turns):
            emit({"t": "status", "phase": "model", "turn": turn + 1, "max": max_turns})
            msg, usage, sent = call_model(messages, emit, chat_fn)
            db.log_usage(conn, sid, turn, usage.get("prompt_tokens"), usage.get("completion_tokens"), est_tokens(sent))
            messages.append(msg)
            db.save_msg(conn, sid, msg)
            if not msg.get("tool_calls"):
                return msg["content"] or ""
            for tc in msg["tool_calls"]:
                name = tc["function"]["name"]
                emit({"t": "status", "phase": "tool", "name": name})
                try:
                    args = json.loads(tc["function"]["arguments"] or "{}")
                    emit({"t": "tool", "id": tc["id"], "name": name, "args": args})
                    result = tools.run(name, args, ws, auto_approve)
                except json.JSONDecodeError as e:
                    args = tc["function"]["arguments"]
                    result = tools.err("bad_args", f"invalid JSON arguments: {e}", "resend the call with valid JSON")
                    emit({"t": "tool", "id": tc["id"], "name": name, "args": args})
                emit({"t": "result", "id": tc["id"], "d": str(result)[:2000], "ok": not str(result).startswith("error")})
                db.log_tool(conn, sid, name, args, result)
                tm = {"role": "tool", "tool_call_id": tc["id"], "content": str(result)}
                messages.append(tm)
                db.save_msg(conn, sid, tm)
        return f"[stopped: max_turns={max_turns} reached]"
    except Exception as e:
        err = errors.classify(e)
        repair_tail(conn, sid, messages)  # keep the history valid before the note goes in
        note = {"role": "assistant", "content": err.note()}
        messages.append(note)
        db.save_msg(conn, sid, note)
        raise err from e


def start(conn, goal, session, retry=False):
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
            messages[0] = {"role": "system", "content": settings.get("system_prompt")}
    else:
        sid = db.new_session(conn, goal)
        messages = [{"role": "system", "content": settings.get("system_prompt")}]
        db.save_msg(conn, sid, messages[0])
    if goal:
        messages.append({"role": "user", "content": goal})
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


def make_server(host, port, ws, max_turns):
    queue = runq.RunQueue(lambda: settings.get("max_queue"))  # one agent run at a time: the local model serves one stream
    page = Path(__file__).with_name("index.html")

    class H(BaseHTTPRequestHandler):
        sse = None  # set once this request turned into an event stream
        sid = None

        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
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
                if err.kind not in ("auth", "not_found", "bad_request", "busy"):  # client mistakes would only fill the log
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

        def do_PUT(self):
            self._guard(lambda rid: self._manage("PUT") if self.path.startswith("/manage/")
                        else self._send(404, {"error": "not found"}))

        def do_GET(self):
            self._guard(self._get)

        def _get(self, rid):
            if self.path.startswith("/manage/"):
                return self._manage("GET")
            if self.path == "/health":
                self._send(200, {"ok": True})
            elif self.path in ("/", "/index.html") and page.exists():  # public page; /task is what the token guards
                self._send(200, page.read_bytes(), "text/html; charset=utf-8")
            else:
                self._send(404, {"error": "not found"})

        def _json_body(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = -1
            if not 0 < n <= MAX_BODY:
                raise errors.HarnessError("bad_request", "Request body is missing or too large.")
            try:
                req = json.loads(self.rfile.read(n))
            except ValueError:
                raise errors.HarnessError("bad_request", "Request body must be JSON.") from None
            if not isinstance(req, dict):
                raise errors.HarnessError("bad_request", "Request body must be a JSON object.")
            return req

        def do_POST(self):
            self._guard(self._post)

        def _post(self, rid):
            if self.path != "/task":
                raise errors.HarnessError("not_found")
            tok = os.environ.get("HARNESS_TOKEN")
            if tok and not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {tok}"):
                raise errors.HarnessError("auth")
            req = self._json_body()
            goal, session, retry = req.get("goal"), req.get("session"), bool(req.get("retry"))
            if not goal and not session:
                raise errors.HarnessError("bad_request", "goal or session required")
            if session is not None and (isinstance(session, bool) or not isinstance(session, int)):
                raise errors.HarnessError("bad_request", "session must be a number")
            if goal is not None and not isinstance(goal, str):
                raise errors.HarnessError("bad_request", "goal must be text")
            if session:  # answer 404 as plain HTTP, before an event stream is opened
                conn = db.connect()
                try:
                    if not db.session_exists(conn, session):
                        raise errors.HarnessError("not_found", f"no such session: {session}")
                finally:
                    conn.close()
            emit, stop = (lambda ev: None), None
            if req.get("stream"):
                self.send_response(200)  # no Content-Length: HTTP/1.0 close-delimited body
                for k, v in (("Content-Type", "text/event-stream"), ("Cache-Control", "no-cache"),
                             ("X-Accel-Buffering", "no")):
                    self.send_header(k, v)
                self.end_headers()
                self.sse = Sse(self.wfile)
                emit, stop = self.sse.event, threading.Event()
                threading.Thread(target=keepalive, args=(self.sse, stop), daemon=True).start()

            def on_wait(ahead):
                if self.sse and not self.sse.alive:
                    raise ClientGone
                emit({"t": "queued", "pos": ahead})

            try:
                with queue.slot(on_wait=on_wait, tick=KEEPALIVE):
                    conn = db.connect()
                    try:
                        sid, messages = start(conn, goal, session, retry)
                        self.sid = sid
                        emit({"t": "session", "id": sid})
                        reply = run_agent(conn, sid, messages, ws, True, max_turns, emit=emit)
                        if self.sse:
                            if reply.startswith("[stopped"):
                                emit({"t": "text", "d": "\n\n" + reply})
                            emit({"t": "done"})
                        else:
                            self._send(200, {"session": sid, "reply": reply})
                    finally:
                        conn.close()
            finally:
                if stop:
                    stop.set()

    return ThreadingHTTPServer((host, port), H)


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
        if a.host != "127.0.0.1" and not os.environ.get("HARNESS_TOKEN") and os.environ.get("HARNESS_OPEN") != "1":
            sys.exit("--host other than 127.0.0.1 requires HARNESS_TOKEN (endpoint runs shell commands); "
                     "set HARNESS_OPEN=1 to run it open on purpose")
        print(f"serving on {a.host}:{a.serve}", file=sys.stderr)
        return make_server(a.host, a.serve, ws, a.max_turns).serve_forever()
    conn = db.connect()
    if not a.goal and not a.session:
        ap.error("give a goal or --session")
    try:
        sid, messages = start(conn, a.goal, a.session)
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
