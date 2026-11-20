#!/usr/bin/env python3
"""Tiny coding-agent harness for small-context local models. Stdlib only."""
import argparse
import hmac
import json
import os
import sys
import threading
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import db
import settings
import tools

VERSION = "0.2.0"

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


def compact(messages):
    """Shrink old tool traffic; keep system, original goal and the last `keep_turns` turns intact."""
    if est_tokens(messages) <= settings.get("compact_at"):
        return messages
    keep = settings.get("keep_turns")
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
    with urllib.request.urlopen(req, timeout=600) as r:
        return parse_sse(r, emit)


def run_agent(conn, sid, messages, ws, auto_approve, max_turns=None, chat_fn=None, emit=cli_emit):
    """Loop until the model answers without tool calls. Returns the final text."""
    chat_fn = chat_fn or chat  # resolved at call time so tests can patch it
    max_turns = max_turns or settings.get("max_turns")  # an explicit value (CLI flag) wins over the saved setting
    for turn in range(max_turns):
        sent = compact(messages)
        msg, usage = chat_fn(sent, emit)
        db.log_usage(conn, sid, turn, usage.get("prompt_tokens"), usage.get("completion_tokens"), est_tokens(sent))
        messages.append(msg)
        db.save_msg(conn, sid, msg)
        if not msg.get("tool_calls"):
            return msg["content"] or ""
        for tc in msg["tool_calls"]:
            name = tc["function"]["name"]
            try:
                args = json.loads(tc["function"]["arguments"] or "{}")
                emit({"t": "tool", "id": tc["id"], "name": name, "args": args})
                result = tools.run(name, args, ws, auto_approve)
            except json.JSONDecodeError as e:
                args, result = tc["function"]["arguments"], f"error: invalid JSON arguments: {e}"
                emit({"t": "tool", "id": tc["id"], "name": name, "args": args})
            emit({"t": "result", "id": tc["id"], "d": str(result)[:2000]})
            db.log_tool(conn, sid, name, args, result)
            tm = {"role": "tool", "tool_call_id": tc["id"], "content": str(result)}
            messages.append(tm)
            db.save_msg(conn, sid, tm)
    return f"[stopped: max_turns={max_turns} reached]"


def start(conn, goal, session):
    """Create or resume a session, add the goal as a user message. Returns (sid, messages)."""
    if session:
        if not db.session_exists(conn, session):
            sys.exit(f"no such session: {session}")
        sid, messages = session, db.load(conn, session)
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


def make_server(host, port, ws, max_turns):
    lock = threading.Lock()  # one agent run at a time: the local model serves one stream anyway
    page = Path(__file__).with_name("index.html")

    class H(BaseHTTPRequestHandler):
        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _manage(self, method):
            """Admin API for the dashboard (via the node agent). Its own token, independent of /task. No token set = no API."""
            tok = os.environ.get("HARNESS_ADMIN_TOKEN")
            if not tok:
                return self._send(404, {"error": "not found"})
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), f"Bearer {tok}".encode()):
                return self._send(401, {"error": "unauthorized"})
            url = urllib.parse.urlparse(self.path)
            if method == "GET" and url.path == "/manage/manifest":
                return self._send(200, manifest(lock.locked()))
            if method == "GET" and url.path == "/manage/sessions":
                try:
                    limit = max(1, min(200, int(urllib.parse.parse_qs(url.query).get("limit", ["50"])[0])))
                except ValueError:
                    return self._send(400, {"error": "limit must be a number"})
                conn = db.connect()
                try:
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
                return self._send(200, manifest(lock.locked()))
            self._send(404, {"error": "not found"})

        def do_PUT(self):
            self._manage("PUT") if self.path.startswith("/manage/") else self._send(404, {"error": "not found"})

        def do_GET(self):
            if self.path.startswith("/manage/"):
                return self._manage("GET")
            if self.path == "/health":
                self._send(200, {"ok": True})
            elif self.path in ("/", "/index.html") and page.exists():  # public page; /task is what the token guards
                self._send(200, page.read_bytes(), "text/html; charset=utf-8")
            else:
                self._send(404, {"error": "not found"})

        def _stream(self, conn, sid, messages):
            self.send_response(200)  # no Content-Length: HTTP/1.0 close-delimited body
            for k, v in (("Content-Type", "text/event-stream"), ("Cache-Control", "no-cache"),
                         ("X-Accel-Buffering", "no")):
                self.send_header(k, v)
            self.end_headers()
            alive = True

            def emit(ev):
                nonlocal alive
                if alive:
                    try:
                        self.wfile.write(b"data: " + json.dumps(ev).encode() + b"\n\n")
                        self.wfile.flush()
                    except OSError:  # client left; let the run finish so history stays consistent
                        alive = False

            emit({"t": "session", "id": sid})
            try:
                reply = run_agent(conn, sid, messages, ws, True, max_turns, emit=emit)
                if reply.startswith("[stopped"):
                    emit({"t": "text", "d": "\n\n" + reply})
                emit({"t": "done"})
            except (OSError, ValueError) as e:  # backend down, bad stream
                emit({"t": "error", "d": f"{type(e).__name__}: {e}"})

        def do_POST(self):
            if self.path != "/task":
                return self._send(404, {"error": "not found"})
            tok = os.environ.get("HARNESS_TOKEN")
            if tok and not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {tok}"):
                return self._send(401, {"error": "unauthorized"})
            conn = None
            try:
                req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                if not req.get("goal") and not req.get("session"):
                    return self._send(400, {"error": "goal or session required"})
                with lock:
                    conn = db.connect()
                    sid, messages = start(conn, req.get("goal"), req.get("session"))
                    if req.get("stream"):
                        self._stream(conn, sid, messages)
                    else:
                        reply = run_agent(conn, sid, messages, ws, True, max_turns, emit=lambda e: None)
                        self._send(200, {"session": sid, "reply": reply})
            except (ValueError, OSError, SystemExit) as e:  # bad JSON, backend down, unknown session
                self._send(500, {"error": f"{type(e).__name__}: {e}"})
            finally:
                if conn:
                    conn.close()

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
    sid, messages = start(conn, a.goal, a.session)
    print(f"[session {sid}]", file=sys.stderr)
    try:
        reply = run_agent(conn, sid, messages, ws, a.auto_approve, a.max_turns)
    except OSError as e:  # URLError, connection refused, timeout
        sys.exit(f"backend error: {e} (session {sid} saved; resume with --session {sid})")
    print("\n" + reply if reply.startswith("[stopped") else "")


if __name__ == "__main__":
    main()
