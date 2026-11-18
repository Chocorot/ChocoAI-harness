import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import db
import harness
import tools


class ToolTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.ws = Path(self.t.name)

    def tearDown(self):
        self.t.cleanup()

    def test_write_edit_read(self):
        self.assertIn("ok", tools.run("write_file", {"path": "a/b.txt", "content": "x\ny\nx\n"}, self.ws))
        self.assertIn("2 times", tools.run("edit_file", {"path": "a/b.txt", "old_text": "x", "new_text": "z"}, self.ws))
        self.assertIn("0 times", tools.run("edit_file", {"path": "a/b.txt", "old_text": "q", "new_text": "z"}, self.ws))
        self.assertEqual("ok", tools.run("edit_file", {"path": "a/b.txt", "old_text": "y", "new_text": "z"}, self.ws))
        out = tools.run("read_file", {"path": "a/b.txt", "start_line": 2, "end_line": 3}, self.ws)
        self.assertEqual(out, "[lines 2-3 of 3]\n2: z\n3: x")

    def test_read_is_capped(self):
        (self.ws / "big").write_text("\n".join(str(i) for i in range(1000)))
        out = tools.run("read_file", {"path": "big", "end_line": 999}, self.ws)
        self.assertTrue(out.startswith("[lines 1-400 of 1000]"))

    def test_escape_rejected(self):
        self.assertIn("outside workspace", tools.run("read_file", {"path": "../x"}, self.ws))
        self.assertIn("outside workspace", tools.run("write_file", {"path": "/etc/x", "content": ""}, self.ws))

    def test_bash(self):
        out = tools.run("run_bash", {"command": "echo hi; echo err >&2; exit 3"}, self.ws, True)
        self.assertIn("exit=3", out)
        self.assertIn("hi", out)
        self.assertIn("err", out)
        out = tools.run("run_bash", {"command": "yes | head -c 20000"}, self.ws, True)
        self.assertLess(len(out), 4100)
        self.assertIn("timeout", tools.run("run_bash", {"command": "sleep 2", "timeout": 1}, self.ws, True))

    def test_bad_args(self):
        self.assertIn("error", tools.run("read_file", {"nope": 1}, self.ws))
        self.assertIn("unknown tool", tools.run("rm", {}, self.ws))


def convo(n, size=6000):
    m = [{"role": "system", "content": "sys"}, {"role": "user", "content": "goal"}]
    for i in range(n):
        name = "read_file" if i % 2 else "run_bash"
        m.append({"role": "assistant", "content": None, "tool_calls": [
            {"id": f"c{i}", "type": "function", "function": {"name": name, "arguments": "{}"}}]})
        m.append({"role": "tool", "tool_call_id": f"c{i}", "content": "x" * size})
    return m


class CompactTests(unittest.TestCase):
    def test_small_untouched(self):
        m = convo(2, 10)
        self.assertIs(harness.compact(m), m)

    def test_compacts_keeps_head_and_tail(self):
        m = convo(10)
        self.assertGreater(harness.est_tokens(m), harness.COMPACT_AT)
        c = harness.compact(m)
        self.assertEqual(c[:2], m[:2])
        self.assertEqual(c[-8:], m[-8:])  # last 4 turns verbatim
        self.assertLess(harness.est_tokens(c), harness.COMPACT_AT)
        self.assertIn("pruned read_file", c[5]["content"])  # c0 is run_bash -> c[3]; c1 read_file -> c[5]
        self.assertTrue(c[3]["content"].endswith("chars]"))
        ids = {tc["id"] for x in c for tc in x.get("tool_calls", [])}
        self.assertTrue(all(x["tool_call_id"] in ids for x in c if x["role"] == "tool"))  # no orphans

    def test_big_tool_args_pruned(self):
        m = convo(10)
        m[2]["tool_calls"][0]["function"]["arguments"] = json.dumps({"content": "y" * 5000})
        self.assertIn("_pruned", harness.compact(m)[2]["tool_calls"][0]["function"]["arguments"])


class SSETests(unittest.TestCase):
    def test_text_and_split_tool_calls(self):
        ev = [
            {"choices": [{"delta": {"reasoning_content": "hm"}}]},
            {"choices": [{"delta": {"content": "Hel"}}]},
            {"choices": [{"delta": {"content": "lo"}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "a", "function": {"name": "read_file", "arguments": '{"pa'}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "b", "function": {"name": "run_bash", "arguments": "{}"}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'th":"f"}'}}]}}]},
            {"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 2}},
        ]
        lines = [b"data: " + json.dumps(e).encode() for e in ev] + [b"", b"data: [DONE]"]
        evs = []
        msg, usage = harness.parse_sse(lines, evs.append)
        self.assertEqual("".join(e["d"] for e in evs if e["t"] == "text"), "Hello")
        self.assertEqual("".join(e["d"] for e in evs if e["t"] == "think"), "hm")
        self.assertEqual(msg["content"], "Hello")
        self.assertEqual([c["function"]["arguments"] for c in msg["tool_calls"]], ['{"path":"f"}', "{}"])
        self.assertEqual(usage["prompt_tokens"], 5)


class AgentTests(unittest.TestCase):
    def test_loop_persist_resume_and_max_turns(self):
        with tempfile.TemporaryDirectory() as d:
            conn = db.connect(f"{d}/h.db")
            ws = Path(d) / "ws"
            ws.mkdir()
            sid, messages = harness.start(conn, "make f", None)
            replies = iter([
                {"role": "assistant", "content": None, "tool_calls": [{"id": "1", "type": "function", "function": {
                    "name": "write_file", "arguments": json.dumps({"path": "f.txt", "content": "hi"})}}]},
                {"role": "assistant", "content": "done"},
            ])
            out = harness.run_agent(conn, sid, messages, ws, True, chat_fn=lambda m, e: (next(replies), {}))
            self.assertEqual(out, "done")
            self.assertEqual((ws / "f.txt").read_text(), "hi")
            self.assertEqual(len(db.load(conn, sid)), 5)  # system, user, assistant, tool, assistant
            self.assertEqual(conn.execute("SELECT tool FROM audit").fetchone()[0], "write_file")
            sid2, resumed = harness.start(conn, "again", sid)  # resume appends to the same history
            self.assertEqual((sid2, len(resumed)), (sid, 6))
            loop = {"role": "assistant", "content": None, "tool_calls": [{"id": "x", "type": "function", "function": {
                "name": "run_bash", "arguments": "{bad"}}]}
            out = harness.run_agent(conn, sid, resumed, ws, True, max_turns=2, chat_fn=lambda m, e: (dict(loop), {}))
            self.assertIn("max_turns", out)
            self.assertIn("invalid JSON", resumed[-1]["content"])


class ServerTests(unittest.TestCase):
    def test_page_auth_and_stream(self):
        def fake_chat(messages, emit):
            emit({"t": "think", "d": "hmm"})
            emit({"t": "text", "d": "hi"})
            return {"role": "assistant", "content": "hi"}, {}

        with tempfile.TemporaryDirectory() as d:
            os.environ.update(HARNESS_DB=f"{d}/h.db", HARNESS_TOKEN="tok")
            real, harness.chat = harness.chat, fake_chat
            srv = harness.make_server("127.0.0.1", 0, Path(d), 3)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{srv.server_address[1]}"
            try:
                self.assertIn(b"<title>ChocoAI", urllib.request.urlopen(base + "/").read())
                post = lambda tok: urllib.request.Request(
                    base + "/task", json.dumps({"goal": "x", "stream": True}).encode(),
                    {"Authorization": f"Bearer {tok}"})
                with self.assertRaises(urllib.error.HTTPError) as cm:
                    urllib.request.urlopen(post("bad"))
                self.assertEqual(cm.exception.code, 401)
                body = urllib.request.urlopen(post("tok")).read().decode()
                evs = [json.loads(x[5:]) for x in body.split("\n\n") if x.startswith("data:")]
                self.assertEqual([e["t"] for e in evs], ["session", "think", "text", "done"])
            finally:
                harness.chat = real
                srv.shutdown()
                del os.environ["HARNESS_TOKEN"]


if __name__ == "__main__":
    unittest.main()
