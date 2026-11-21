"""Scheduled prompts. A job = name + prompt + schedule (plain data), stored in its owner's own DB. One scheduler thread wakes
every 30 s and runs what is due through the normal run queue, so a job never jumps ahead of a live chat for the model.
The outcome is a saved chat in the owner's list plus `last_status`. A job runs at most once per due time: next_run is moved
forward BEFORE it runs, so a crash can't make it loop."""
import datetime
import json
import os
import re
import threading
import time
import zoneinfo
from pathlib import Path

import auth
import db
import settings
from errors import HarnessError

KINDS = ("interval", "daily")  # the schedule kinds; a new kind = a branch in next_run() and clean_schedule()
AT = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
NAME_MAX, PROMPT_MAX, EVERY_MAX = 60, 2000, 10080  # chars, chars, minutes (one week)
TICK = 30


def bad(msg):
    return HarnessError("bad_request", msg)


def tz():
    try:
        return zoneinfo.ZoneInfo(os.environ.get("HARNESS_TZ") or "UTC")
    except (zoneinfo.ZoneInfoNotFoundError, ValueError, OSError):  # no tz database in the image: fall back, don't crash
        return datetime.timezone.utc


def clean_schedule(s):
    if not isinstance(s, dict) or s.get("kind") not in KINDS:
        raise bad("schedule.kind must be 'interval' or 'daily'.")
    if s["kind"] == "interval":
        n, low = s.get("every_min"), settings.get("min_interval_min")
        if isinstance(n, bool) or not isinstance(n, int) or not low <= n <= EVERY_MAX:
            raise bad(f"Repeat every {low} to {EVERY_MAX} minutes.")
        return {"kind": "interval", "every_min": n}
    if not isinstance(s.get("at"), str) or not AT.match(s["at"]):
        raise bad("Daily time must look like 08:30.")
    return {"kind": "daily", "at": s["at"]}


def next_run(s, now):
    """Epoch seconds of the next run after `now`. Daily times are wall-clock in HARNESS_TZ (daylight saving follows the zone)."""
    if s["kind"] == "interval":
        return now + s["every_min"] * 60
    zone, (h, m) = tz(), map(int, s["at"].split(":"))
    local = datetime.datetime.fromtimestamp(now, zone)
    at = datetime.datetime.combine(local.date(), datetime.time(h, m), zone)
    if at.timestamp() <= now:
        at = datetime.datetime.combine(local.date() + datetime.timedelta(days=1), datetime.time(h, m), zone)
    return at.timestamp()


def row(r):
    return {"id": r[0], "name": r[1], "prompt": r[2], "schedule": json.loads(r[3]), "enabled": bool(r[4]), "nextRun": r[5],
            "lastRun": r[6], "lastStatus": r[7], "lastSession": r[8]}


COLS = "id, name, prompt, schedule, enabled, next_run, last_run, last_status, last_session"


def listing(conn):
    return [row(r) for r in conn.execute(f"SELECT {COLS} FROM automations ORDER BY id")]


def get(conn, aid):
    r = conn.execute(f"SELECT {COLS} FROM automations WHERE id=?", (aid,)).fetchone()
    if not r:
        raise HarnessError("not_found")
    return row(r)


def _text(body, key, limit):
    v = body.get(key)
    if not isinstance(v, str) or not v.strip() or len(v.strip()) > limit:
        raise bad(f"{key.capitalize()} must be 1 to {limit} characters.")
    return v.strip()


def create(conn, owner, body, now):
    name, prompt, sched = _text(body, "name", NAME_MAX), _text(body, "prompt", PROMPT_MAX), clean_schedule(body.get("schedule"))
    cap = settings.get("max_automations")
    if conn.execute("SELECT COUNT(*) FROM automations").fetchone()[0] >= cap:
        raise bad(f"You can have at most {cap} automations. Delete one first.")
    cur = conn.execute("INSERT INTO automations(owner, name, prompt, schedule, enabled, next_run, created) VALUES(?,?,?,?,1,?,?)",
                       (owner, name, prompt, json.dumps(sched), next_run(sched, now), now))
    conn.commit()
    return get(conn, cur.lastrowid)


def update(conn, aid, body, now):
    cur = get(conn, aid)
    if not isinstance(body, dict) or not body:
        raise bad("Nothing to change.")
    name = _text(body, "name", NAME_MAX) if "name" in body else cur["name"]
    prompt = _text(body, "prompt", PROMPT_MAX) if "prompt" in body else cur["prompt"]
    sched = clean_schedule(body["schedule"]) if "schedule" in body else cur["schedule"]
    if "enabled" in body and not isinstance(body["enabled"], bool):
        raise bad("enabled must be true or false.")
    enabled = body.get("enabled", cur["enabled"])
    nxt = next_run(sched, now) if (sched != cur["schedule"] or (enabled and not cur["enabled"])) else cur["nextRun"]
    conn.execute("UPDATE automations SET name=?, prompt=?, schedule=?, enabled=?, next_run=? WHERE id=?",
                 (name, prompt, json.dumps(sched), int(enabled), nxt, aid))
    conn.commit()
    return get(conn, aid)


def delete(conn, aid):
    get(conn, aid)
    conn.execute("DELETE FROM automations WHERE id=?", (aid,))
    conn.commit()


def user_dbs():
    base = os.path.dirname(os.environ.get("HARNESS_DB", "harness.db")) or "."
    return sorted(Path(base).glob("users/*/harness.db"))


class Scheduler:
    """`run_job(owner, name, prompt) -> (status, session id)` does the actual run (harness.py supplies it)."""

    def __init__(self, run_job):
        self.run_job, self.running, self.stop, self.lock = run_job, set(), threading.Event(), threading.Lock()

    def start(self):
        threading.Thread(target=self._loop, daemon=True, name="automations").start()

    def _loop(self):
        while not self.stop.wait(TICK):
            try:
                self.tick()
            except Exception as e:  # the scheduler must outlive any single failure
                print(json.dumps({"scheduler_error": f"{type(e).__name__}: {e}"}), flush=True)

    def tick(self, now=None):
        """Run every job that is due, one after another. Returns how many ran."""
        now, ran = now if now is not None else time.time(), 0
        for path in user_dbs():
            conn = db.connect(str(path))
            try:
                due = [(r[0], r[1]) for r in conn.execute("SELECT id, schedule FROM automations WHERE enabled=1 AND next_run IS NOT NULL AND next_run<=?", (now,))]
                for aid, sched in due:
                    if not self._claim(conn, path, aid):
                        continue
                    conn.execute("UPDATE automations SET next_run=? WHERE id=?", (next_run(json.loads(sched), now), aid))  # before it runs
                    conn.commit()
                    self._fire(conn, path, aid)
                    ran += 1
            finally:
                conn.close()
        return ran

    def _claim(self, conn, path, aid):
        with self.lock:
            if (str(path), aid) in self.running:
                return False
            self.running.add((str(path), aid))
            return True

    def _fire(self, conn, path, aid):
        try:
            job = get(conn, aid)
            owner = conn.execute("SELECT owner FROM automations WHERE id=?", (aid,)).fetchone()[0]
            try:
                status, sid = self.run_job(owner, job["name"], job["prompt"])
            except HarnessError as e:
                status, sid = f"{e.kind}: {e.message}", None
            except Exception as e:
                status, sid = f"internal: {type(e).__name__}", None
            conn.execute("UPDATE automations SET last_run=?, last_status=?, last_session=? WHERE id=?", (time.time(), status[:300], sid, aid))
            conn.commit()
        finally:
            with self.lock:
                self.running.discard((str(path), aid))

    def run_now(self, owner, aid):
        """Start a job now in the background without moving its schedule. False when it is already running."""
        path = Path(auth.db_path(owner))
        conn = db.connect(str(path))
        try:
            get(conn, aid)  # not_found for somebody else's or a missing id
        finally:
            conn.close()
        if not self._claim(None, path, aid):
            return False

        def job():
            c = db.connect(str(path))  # SQLite connections stay in the thread that made them
            try:
                self._fire(c, path, aid)
            finally:
                c.close()
        threading.Thread(target=job, daemon=True).start()
        return True
