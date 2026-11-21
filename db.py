"""SQLite persistence: sessions, messages, token usage, tool audit log. One file, no services."""
import json
import os
import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, goal TEXT, created REAL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, session INTEGER, json TEXT);
CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY, session INTEGER, turn INTEGER,
  prompt_tokens INTEGER, completion_tokens INTEGER, est_tokens INTEGER);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts REAL, session INTEGER,
  tool TEXT, args TEXT, result TEXT);
CREATE TABLE IF NOT EXISTS errors(id INTEGER PRIMARY KEY, ts REAL, rid TEXT, session INTEGER,
  kind TEXT, code TEXT, message TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS automations(id INTEGER PRIMARY KEY, owner TEXT, name TEXT, prompt TEXT, schedule TEXT,
  enabled INTEGER DEFAULT 1, next_run REAL, last_run REAL, last_status TEXT, last_session INTEGER, created REAL);
CREATE INDEX IF NOT EXISTS msg_session ON messages(session);
"""
# title: shown in the chat list (NULL = use `goal`). title_state: 0 = made from the first message, 1 = written by the model,
# 2 = named by the user or a job (never overwritten). effort: the chat's thinking level.
SESSION_COLUMNS = (("title", "TEXT"), ("title_state", "INTEGER DEFAULT 0"), ("effort", "TEXT"))
ERROR_KEEP = 200  # the errors table is a ring: only the newest rows are kept


def connect(path=None):
    db = sqlite3.connect(path or os.environ.get("HARNESS_DB", "harness.db"))
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    have = {r[1] for r in db.execute("PRAGMA table_info(sessions)")}
    for col, ddl in SESSION_COLUMNS:  # databases created before a column existed get it added once
        if col not in have:
            db.execute(f"ALTER TABLE sessions ADD COLUMN {col} {ddl}")
    return db


def new_session(db, goal, title=None, state=0, effort=None):
    cur = db.execute("INSERT INTO sessions(goal, created, title, title_state, effort) VALUES(?,?,?,?,?)",
                     (goal, time.time(), title, state, effort))
    db.commit()
    return cur.lastrowid


def get_session(db, sid):
    """{title, titleState, effort} of one session, or None."""
    r = db.execute("SELECT COALESCE(title, goal), COALESCE(title_state, 0), effort FROM sessions WHERE id=?", (sid,)).fetchone()
    return {"title": r[0] or "", "titleState": r[1], "effort": r[2]} if r else None


def set_effort(db, sid, effort):
    db.execute("UPDATE sessions SET effort=? WHERE id=?", (effort, sid))
    db.commit()


def rename(db, sid, title, state):
    """Set a title. A model-written title (state 1) only lands while the title is still the automatic one (state 0)."""
    cur = db.execute("UPDATE sessions SET title=?, title_state=? WHERE id=?" + (" AND COALESCE(title_state,0)=0" if state == 1 else ""),
                     (title, state, sid))
    db.commit()
    return cur.rowcount > 0


def session_exists(db, sid):
    return db.execute("SELECT 1 FROM sessions WHERE id=?", (sid,)).fetchone() is not None


def load(db, sid):
    rows = db.execute("SELECT json FROM messages WHERE session=? ORDER BY id", (sid,))
    return [json.loads(r[0]) for r in rows]


def save_msg(db, sid, msg):
    db.execute("INSERT INTO messages(session, json) VALUES(?,?)", (sid, json.dumps(msg)))
    db.commit()


def drop_last(db, sid):
    """Delete the newest message of a session (used to remove a failure note before a retry)."""
    db.execute("DELETE FROM messages WHERE id=(SELECT MAX(id) FROM messages WHERE session=?)", (sid,))
    db.commit()


def log_error(db, rid, sid, err):
    db.execute("INSERT INTO errors(ts, rid, session, kind, code, message, detail) VALUES(?,?,?,?,?,?,?)",
               (time.time(), rid, sid, err.kind, err.code, err.message, err.detail[:500]))
    db.execute("DELETE FROM errors WHERE id <= (SELECT MAX(id) FROM errors) - ?", (ERROR_KEEP,))
    db.commit()


def list_errors(db, limit=50):
    rows = db.execute("SELECT ts, rid, session, kind, code, message, detail FROM errors ORDER BY id DESC LIMIT ?", (limit,))
    return [dict(zip(("ts", "rid", "session", "kind", "code", "message", "detail"), r)) for r in rows]


def delete_session(db, sid):
    for table in ("messages", "usage", "audit"):
        db.execute(f"DELETE FROM {table} WHERE session=?", (sid,))
    db.execute("DELETE FROM sessions WHERE id=?", (sid,))
    db.commit()


def log_usage(db, sid, turn, prompt, completion, est):
    db.execute("INSERT INTO usage(session, turn, prompt_tokens, completion_tokens, est_tokens)"
               " VALUES(?,?,?,?,?)", (sid, turn, prompt, completion, est))
    db.commit()


def log_tool(db, sid, tool, args, result):
    db.execute("INSERT INTO audit(ts, session, tool, args, result) VALUES(?,?,?,?,?)",
               (time.time(), sid, tool, json.dumps(args)[:2000], str(result)[:500]))
    db.commit()


def stats(db):
    """Totals for the manifest. Token counts are what the backend reported (NULL when it reported none)."""
    q = lambda sql: db.execute(sql).fetchone()[0]
    return {"sessions": q("SELECT COUNT(*) FROM sessions"),
            "turns": q("SELECT COUNT(*) FROM usage"),
            "promptTokens": q("SELECT COALESCE(SUM(prompt_tokens),0) FROM usage"),
            "completionTokens": q("SELECT COALESCE(SUM(completion_tokens),0) FROM usage"),
            "toolCalls": q("SELECT COUNT(*) FROM audit"),
            "errors": q("SELECT COUNT(*) FROM errors")}


def list_sessions(db, limit=50):
    rows = db.execute(
        "SELECT s.id, s.goal, s.created, COALESCE(s.title, s.goal), COALESCE(s.title_state, 0), s.effort,"
        " (SELECT COUNT(*) FROM usage u WHERE u.session=s.id),"
        " (SELECT COALESCE(SUM(COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)),0) FROM usage u WHERE u.session=s.id),"
        " (SELECT COUNT(*) FROM audit a WHERE a.session=s.id)"
        " FROM sessions s ORDER BY s.id DESC LIMIT ?", (limit,))
    return [{"id": r[0], "goal": (r[1] or "")[:200], "created": r[2], "title": (r[3] or "")[:200], "titleState": r[4], "effort": r[5],
             "turns": r[6], "tokens": r[7], "toolCalls": r[8]} for r in rows]
