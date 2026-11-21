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
ERROR_KEEP = 200  # the errors table is a ring: only the newest rows are kept


def connect(path=None):
    db = sqlite3.connect(path or os.environ.get("HARNESS_DB", "harness.db"))
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    return db


def new_session(db, goal):
    cur = db.execute("INSERT INTO sessions(goal, created) VALUES(?,?)", (goal, time.time()))
    db.commit()
    return cur.lastrowid


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
        "SELECT s.id, s.goal, s.created,"
        " (SELECT COUNT(*) FROM usage u WHERE u.session=s.id),"
        " (SELECT COALESCE(SUM(COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)),0) FROM usage u WHERE u.session=s.id),"
        " (SELECT COUNT(*) FROM audit a WHERE a.session=s.id)"
        " FROM sessions s ORDER BY s.id DESC LIMIT ?", (limit,))
    return [{"id": r[0], "goal": (r[1] or "")[:200], "created": r[2], "turns": r[3], "tokens": r[4], "toolCalls": r[5]}
            for r in rows]
