#!/usr/bin/env python3
"""Tiny coding-agent harness for small-context local models. Stdlib only."""
import argparse
import json
import os
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import db
import tools

SYSTEM = (
    "You are a coding agent working in a workspace directory. Complete the user's goal with the tools: "
    "read_file, edit_file, write_file, run_bash. Rules: "
    "read only the line ranges you need; "
    "prefer edit_file (exact unique old_text) over rewriting files; "
    "check your work by running it; "
    "keep replies short; "
    "when done, reply with a brief summary and call no tools."
)
COMPACT_AT = 11_000  # est. tokens; context window is 16K, leave room for the reply
KEEP_TURNS = 4


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
    """Shrink old tool traffic; keep system, original goal and the last KEEP_TURNS turns intact."""
    if est_tokens(messages) <= COMPACT_AT:
        return messages
    turns = [i for i, m in enumerate(messages) if m["role"] == "assistant"]
    if len(turns) <= KEEP_TURNS:
        return messages
    cut = turns[-KEEP_TURNS]  # a turn = assistant msg + its tool results, so cutting here never orphans a tool msg
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


def parse_sse(lines, out=sys.stdout):
    """Consume SSE lines; stream text to `out`, buffer tool_call deltas. Returns (message, usage)."""
    text, calls, usage = [], {}, {}
    for raw in lines:
        line = raw.decode() if isinstance(raw, bytes) else raw
        if not line.startswith("data:") or line[5:].strip() == "[DONE]":
            continue
        chunk = json.loads(line[5:])
        usage = chunk.get("usage") or usage
        for ch in chunk.get("choices", []):
            d = ch.get("delta", {})
            if d.get("content"):
                text.append(d["content"])
                out.write(d["content"])
                out.flush()
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


def chat(messages):
    body = {"model": os.environ.get("MODEL", "qwen/qwen3.6-35b-a3b"), "messages": messages,
            "tools": tools.SCHEMAS, "stream": True, "stream_options": {"include_usage": True}}
    req = urllib.request.Request(
        os.environ.get("BASE_URL", "http://localhost:1235/v1").rstrip("/") + "/chat/completions",
        json.dumps(body).encode(),
        {"Content-Type": "application/json",
         "Authorization": "Bearer " + os.environ.get("API_KEY", "lm-studio")})
    with urllib.request.urlopen(req, timeout=600) as r:
        return parse_sse(r)


def run_agent(conn, sid, messages, ws, auto_approve, max_turns=15, chat_fn=chat):
    """Loop until the model answers without tool calls. Returns the final text."""
    for turn in range(max_turns):
        sent = compact(messages)
        msg, usage = chat_fn(sent)
        db.log_usage(conn, sid, turn, usage.get("prompt_tokens"), usage.get("completion_tokens"), est_tokens(sent))
        messages.append(msg)
        db.save_msg(conn, sid, msg)
        if not msg.get("tool_calls"):
            return msg["content"] or ""
        for tc in msg["tool_calls"]:
            name = tc["function"]["name"]
            try:
                args = json.loads(tc["function"]["arguments"] or "{}")
                result = tools.run(name, args, ws, auto_approve)
            except json.JSONDecodeError as e:
                args, result = tc["function"]["arguments"], f"error: invalid JSON arguments: {e}"
            print(f"\n[{name}] {str(result)[:80]!r}", file=sys.stderr)
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
    else:
        sid = db.new_session(conn, goal)
        messages = [{"role": "system", "content": SYSTEM}]
        db.save_msg(conn, sid, messages[0])
    if goal:
        messages.append({"role": "user", "content": goal})
        db.save_msg(conn, sid, messages[-1])
    return sid, messages


def serve(conn, host, port, ws, max_turns):
    class H(BaseHTTPRequestHandler):
        def _send(self, code, obj):
            data = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self._send(200, {"ok": True}) if self.path == "/health" else self._send(404, {"error": "not found"})

        def do_POST(self):  # shortcut: one task at a time, no auth; put a reverse proxy in front if exposed
            if self.path != "/task":
                return self._send(404, {"error": "not found"})
            try:
                req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                if not req.get("goal") and not req.get("session"):
                    return self._send(400, {"error": "goal or session required"})
                sid, messages = start(conn, req.get("goal"), req.get("session"))
                reply = run_agent(conn, sid, messages, ws, True, max_turns)
                self._send(200, {"session": sid, "reply": reply})
            except (ValueError, OSError, SystemExit) as e:  # bad JSON, backend down, unknown session
                self._send(500, {"error": f"{type(e).__name__}: {e}"})

    print(f"serving on {host}:{port}", file=sys.stderr)
    HTTPServer((host, port), H).serve_forever()


def main():
    load_env()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("goal", nargs="?", help="task for the agent (with --session: follow-up message)")
    ap.add_argument("--session", type=int, help="resume session id")
    ap.add_argument("--workspace", default="workspace", help="sandbox dir (default ./workspace)")
    ap.add_argument("--auto-approve", action="store_true", help="run bash without y/N prompt")
    ap.add_argument("--max-turns", type=int, default=15)
    ap.add_argument("--serve", type=int, metavar="PORT", help="run HTTP server: GET /health, POST /task")
    ap.add_argument("--host", default="127.0.0.1", help="bind address for --serve")
    a = ap.parse_args()
    ws = Path(a.workspace).resolve()
    ws.mkdir(parents=True, exist_ok=True)
    conn = db.connect()
    if a.serve:
        if not a.auto_approve:
            sys.exit("--serve needs --auto-approve (no TTY for y/N prompts)")
        return serve(conn, a.host, a.serve, ws, a.max_turns)
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
