import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

import db
import harness
import settings
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


class SettingsBase(unittest.TestCase):
    """Each test gets its own settings file and a clean environment."""

    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {"HARNESS_SETTINGS": f"{self.t.name}/settings.json",
                                                "HARNESS_DB": f"{self.t.name}/h.db"})
        self.env.start()
        os.environ.pop("MODEL", None)

    def tearDown(self):
        self.env.stop()
        self.t.cleanup()


class SettingsTests(SettingsBase):
    def test_defaults_and_env_default(self):
        self.assertEqual((settings.get("max_turns"), settings.get("keep_turns"), settings.get("temperature")), (15, 4, None))
        os.environ["MODEL"] = "other/model"
        self.assertEqual(settings.get("model"), "other/model")  # env supplies the default, a saved value still wins
        settings.save({"model": "saved/model"})
        self.assertEqual(settings.get("model"), "saved/model")

    def test_validation_is_all_or_nothing(self):
        bad = [{}, [], {"nope": 1}, {"max_turns": 0}, {"max_turns": "5"}, {"max_turns": True}, {"max_turns": 1.5},
               {"max_turns": 101}, {"temperature": 3}, {"temperature": float("nan")}, {"system_prompt": "  "},
               {"system_prompt": "x" * 8001}, {"model": 5}]
        for upd in bad:
            _, err = settings.save(upd)
            self.assertTrue(err, upd)
        _, err = settings.save({"max_turns": 9, "temperature": 99})  # one good, one bad: nothing may be written
        self.assertTrue(err)
        self.assertEqual(settings.get("max_turns"), 15)
        self.assertFalse(os.path.exists(settings.path()))

    def test_save_backup_reset_and_optional(self):
        cur, err = settings.save({"max_turns": 9, "temperature": 0.2})
        self.assertEqual((err, cur["max_turns"], cur["temperature"]), (None, 9, 0.2))
        settings.save({"keep_turns": 2})
        self.assertTrue(os.path.exists(settings.path() + ".bak"))  # previous version kept
        cur, _ = settings.save({"max_turns": None, "temperature": None})  # null = back to default / unset
        self.assertEqual((cur["max_turns"], cur["temperature"], cur["keep_turns"]), (15, None, 2))

    def test_a_bad_file_never_breaks_a_run(self):
        Path(settings.path()).write_text("{not json")
        self.assertEqual(settings.get("max_turns"), 15)
        Path(settings.path()).write_text(json.dumps({"max_turns": -4, "keep_turns": 3, "junk": 1}))
        self.assertEqual((settings.get("max_turns"), settings.get("keep_turns")), (15, 3))  # invalid value ignored, valid kept

    def test_manifest_lists_every_field_plus_read_only_backend(self):
        os.environ["BASE_URL"] = "http://x/v1"
        m = {f["key"]: f for f in settings.manifest()}
        self.assertEqual(set(m), {f["key"] for f in settings.FIELDS} | {"base_url"})
        self.assertEqual((m["base_url"]["type"], m["base_url"]["value"]), ("readonly", "http://x/v1"))
        self.assertEqual((m["max_turns"]["value"], m["max_turns"]["default"], m["max_turns"]["min"]), (15, 15, 1))
        self.assertTrue(m["temperature"]["optional"])

    def test_a_new_row_is_all_it_takes(self):
        row = {"key": "top_p", "label": "Top P", "type": "float", "default": None, "optional": True, "min": 0, "max": 1, "help": "h"}
        with mock.patch.object(settings, "FIELDS", settings.FIELDS + [row]), \
                mock.patch.object(settings, "BY_KEY", {**settings.BY_KEY, "top_p": row}):
            self.assertIn("top_p", {f["key"] for f in settings.manifest()})
            self.assertEqual(settings.save({"top_p": 0.9})[0]["top_p"], 0.9)
            self.assertTrue(settings.save({"top_p": 2})[1])


class SettingsAppliedTests(SettingsBase):
    def test_compaction_follows_settings(self):
        m = convo(10)
        self.assertIsNot(harness.compact(m), m)
        settings.save({"compact_at": 200000})
        self.assertIs(harness.compact(m), m)  # threshold raised: nothing to shrink
        settings.save({"compact_at": 1000, "keep_turns": 2})
        self.assertEqual(harness.compact(m)[-4:], m[-4:])  # last 2 turns verbatim

    def test_system_prompt_applies_to_new_and_resumed_sessions(self):
        conn = db.connect()
        sid, msgs = harness.start(conn, "goal", None)
        self.assertEqual(msgs[0]["content"], settings.SYSTEM_PROMPT)
        settings.save({"system_prompt": "Be terse."})
        _, resumed = harness.start(conn, "more", sid)
        self.assertEqual(resumed[0]["content"], "Be terse.")
        _, fresh = harness.start(conn, "new", None)
        self.assertEqual(fresh[0]["content"], "Be terse.")

    def test_max_turns_setting_and_explicit_override(self):
        conn = db.connect()
        loop = {"role": "assistant", "content": None, "tool_calls": [{"id": "x", "type": "function", "function": {
            "name": "run_bash", "arguments": "{bad"}}]}
        settings.save({"max_turns": 2})
        sid, msgs = harness.start(conn, "g", None)
        out = harness.run_agent(conn, sid, msgs, Path(self.t.name), True, chat_fn=lambda m, e: (dict(loop), {}))
        self.assertIn("max_turns=2", out)
        out = harness.run_agent(conn, sid, msgs, Path(self.t.name), True, max_turns=1, chat_fn=lambda m, e: (dict(loop), {}))
        self.assertIn("max_turns=1", out)  # a CLI flag beats the saved value

    def test_chat_sends_model_and_optional_params_only_when_set(self):
        sent = []

        def fake_urlopen(req, timeout=None):
            sent.append(json.loads(req.data))
            return mock.MagicMock(__enter__=lambda s: [], __exit__=lambda *a: False)

        with mock.patch.object(harness.urllib.request, "urlopen", fake_urlopen):
            harness.chat([{"role": "user", "content": "x"}])
            settings.save({"model": "m2", "temperature": 0.3, "max_tokens": 256})
            harness.chat([{"role": "user", "content": "x"}])
        self.assertNotIn("temperature", sent[0])
        self.assertEqual((sent[1]["model"], sent[1]["temperature"], sent[1]["max_tokens"]), ("m2", 0.3, 256))


class ManageApiTests(SettingsBase):
    def serve(self, **env):
        os.environ.update(env)
        srv = harness.make_server("127.0.0.1", 0, Path(self.t.name), None)
        threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
        self.addCleanup(lambda: (srv.shutdown(), srv.server_close()))
        return f"http://127.0.0.1:{srv.server_address[1]}"

    def call(self, base, path, method="GET", body=None, token="adm"):
        req = urllib.request.Request(base + path, None if body is None else json.dumps(body).encode(), method=method,
                                     headers={"Authorization": f"Bearer {token}"} if token else {})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read())

    def test_disabled_without_admin_token_and_auth(self):
        base = self.serve(HARNESS_TOKEN="tok")
        os.environ.pop("HARNESS_ADMIN_TOKEN", None)
        self.assertEqual(self.call(base, "/manage/manifest")[0], 404)  # no admin token configured: the API does not exist
        base = self.serve(HARNESS_ADMIN_TOKEN="adm")
        self.assertEqual(self.call(base, "/manage/manifest", token=None)[0], 401)
        self.assertEqual(self.call(base, "/manage/manifest", token="tok")[0], 401)  # the /task token does not open /manage
        self.assertEqual(self.call(base, "/manage/nope")[0], 404)

    def test_task_token_is_independent(self):
        base = self.serve(HARNESS_TOKEN="tok", HARNESS_ADMIN_TOKEN="adm")
        req = urllib.request.Request(base + "/task", json.dumps({"goal": "x"}).encode(), {"Authorization": "Bearer adm"})
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req)
        self.assertEqual(cm.exception.code, 401)  # the admin token does not run tasks

    def test_manifest_save_and_validation(self):
        base = self.serve(HARNESS_ADMIN_TOKEN="adm")
        status, m = self.call(base, "/manage/manifest")
        self.assertEqual((status, m["kind"], m["status"], m["stats"]["sessions"]), (200, "choco-harness", "idle", 0))
        self.assertEqual(m["backend"]["model"], settings.get("model"))
        status, m = self.call(base, "/manage/settings", "PUT", {"settings": {"max_turns": 7, "system_prompt": "Hi."}})
        self.assertEqual(status, 200)
        vals = {f["key"]: f["value"] for f in m["settings"]}
        self.assertEqual((vals["max_turns"], vals["system_prompt"]), (7, "Hi."))
        status, err = self.call(base, "/manage/settings", "PUT", {"settings": {"max_turns": 0}})
        self.assertEqual((status, err["error"]), (400, "max_turns must be between 1 and 100"))
        self.assertEqual(self.call(base, "/manage/settings", "PUT", {"settings": {"zzz": 1}})[0], 400)
        self.assertEqual(self.call(base, "/manage/settings", "PUT", {})[0], 400)
        self.assertEqual(settings.get("max_turns"), 7)  # the failed saves changed nothing

    def test_sessions_list(self):
        conn = db.connect()
        sid = db.new_session(conn, "g" * 500)
        db.log_usage(conn, sid, 0, 100, 20, 90)
        db.log_usage(conn, sid, 1, None, None, 95)  # a backend that reported no tokens
        db.log_tool(conn, sid, "run_bash", {"command": "ls"}, "ok")
        conn.close()
        base = self.serve(HARNESS_ADMIN_TOKEN="adm")
        status, d = self.call(base, "/manage/sessions?limit=5")
        (s,) = d["sessions"]
        self.assertEqual((s["id"], len(s["goal"]), s["turns"], s["tokens"], s["toolCalls"]), (sid, 200, 2, 120, 1))
        self.assertEqual(self.call(base, "/manage/sessions?limit=abc")[0], 400)
        self.assertEqual(self.call(base, "/manage/manifest")[1]["stats"]["promptTokens"], 100)


if __name__ == "__main__":
    unittest.main()
