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
CREATE INDEX IF NOT EXISTS msg_session ON messages(session);
"""


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


def log_usage(db, sid, turn, prompt, completion, est):
    db.execute("INSERT INTO usage(session, turn, prompt_tokens, completion_tokens, est_tokens)"
               " VALUES(?,?,?,?,?)", (sid, turn, prompt, completion, est))
    db.commit()


def log_tool(db, sid, tool, args, result):
    db.execute("INSERT INTO audit(ts, session, tool, args, result) VALUES(?,?,?,?,?)",
               (time.time(), sid, tool, json.dumps(args)[:2000], str(result)[:500]))
    db.commit()
