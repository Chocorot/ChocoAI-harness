"""Who is calling. Sign-in checks the DMS mailbox over IMAP, then a signed cookie carries the address (never the
password). MODES is the one table that says what each kind of caller may do. Also: per-user storage paths and throttles."""
import base64
import collections
import hashlib
import hmac
import imaplib
import json
import os
import re
import threading
import time
from pathlib import Path

from errors import HarnessError

COOKIE = "choco_harness"
MAX_AGE = 30 * 86400
FILES, SHELL = ["read_file", "edit_file", "write_file"], ["run_bash"]
WEB, AGENT = ["web_fetch", "web_search"], ["update_plan", "delegate"]
ALL_TOOLS = FILES + SHELL + WEB + AGENT
# tools: what the model may call. store: where the chat lives. prio: queue priority (lower runs first).
MODES = {
    "admin": {"tools": ALL_TOOLS, "store": "legacy", "prio": 0},  # HARNESS_TOKEN bearer: the CLI/API caller
    "user+shell": {"tools": ALL_TOOLS, "store": "user", "prio": 1},
    "user": {"tools": FILES + WEB + AGENT, "store": "user", "prio": 1},
    "public": {"tools": [], "store": "client", "prio": 2},
}
ADDR = re.compile(r"^[a-z0-9._%+\-]{1,64}@[a-z0-9.\-]{1,190}\.[a-z]{2,}$")


def normalize(address):
    a = address.strip().lower() if isinstance(address, str) else ""
    if len(a) > 254 or not ADDR.match(a):
        raise HarnessError("bad_request", "Enter a valid email address.")
    return a


def check_password(pw):
    if not isinstance(pw, str) or not 1 <= len(pw) <= 256 or re.search(r"[\x00-\x1f]", pw):
        raise HarnessError("bad_request", "Enter your password.")
    return pw


# ---- signed cookie -------------------------------------------------------------------------------------------------
def _key():
    k = os.environ.get("HARNESS_SESSION_KEY", "")
    return k.encode() if len(k) >= 16 else None


def enabled():
    """Sign-in exists only when HARNESS_SESSION_KEY (16+ chars) is set; without it everybody is public."""
    return _key() is not None


def _sig(data):
    return base64.urlsafe_b64encode(hmac.new(_key(), data, hashlib.sha256).digest()).rstrip(b"=")


def make_cookie(address, now=None):
    data = base64.urlsafe_b64encode(json.dumps({"a": address, "e": int((now or time.time()) + MAX_AGE)}).encode()).rstrip(b"=")
    return (data + b"." + _sig(data)).decode()


def read_cookie(value, now=None):
    """The address in a valid, unexpired cookie, else None. Never raises."""
    try:
        data, sig = value.encode().split(b".")
        if not enabled() or not hmac.compare_digest(sig, _sig(data)):
            return None
        p = json.loads(base64.urlsafe_b64decode(data + b"=" * (-len(data) % 4)))
        return p["a"] if p["e"] > (now or time.time()) and ADDR.match(p["a"]) else None
    except (ValueError, KeyError, TypeError, AttributeError):
        return None


def cookie_from(header):
    for part in (header or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == COOKIE:
            return v
    return None


def mode_for(address):
    shell = {a.strip().lower() for a in os.environ.get("HARNESS_SHELL_USERS", "").split(",")}
    return "user+shell" if address in shell else "user"


# ---- mail sign-in --------------------------------------------------------------------------------------------------
def imap_verify(address, password):
    """True/False for right/wrong password. Raises login_unavailable when the mail server can't be asked."""
    try:
        c = imaplib.IMAP4_SSL(os.environ.get("MAIL_HOST", "mail.chocorot.net"), int(os.environ.get("MAIL_PORT", 993)), timeout=10)
    except (OSError, imaplib.IMAP4.error) as e:
        raise HarnessError("login_unavailable", detail=e) from e
    try:
        c.login(address, password)
        return True
    except imaplib.IMAP4.error:  # NO [AUTHENTICATIONFAILED]: wrong password or no such mailbox (same answer on purpose)
        return False
    except OSError as e:
        raise HarnessError("login_unavailable", detail=e) from e
    finally:
        try:
            c.logout()
        except Exception:
            pass


verify_password = imap_verify  # looked up at call time so tests can swap it


# ---- throttles -----------------------------------------------------------------------------------------------------
class Throttle:
    """Sliding window per key. `allow` records a hit and says whether the caller is still under `limit` per `window` s."""

    def __init__(self):
        self.hits, self.lock = collections.defaultdict(collections.deque), threading.Lock()

    def _recent(self, key, window, now):
        q = self.hits[key]
        while q and q[0] <= now - window:
            q.popleft()
        return q

    def blocked(self, key, limit, window):
        with self.lock:
            return len(self._recent(key, window, time.time())) >= limit

    def hit(self, key, window=3600):
        with self.lock:
            now = time.time()
            self._recent(key, window, now).append(now)
            if len(self.hits) > 5000:  # forget idle keys so a scan of many IPs can't grow this forever
                for k in [k for k, q in self.hits.items() if not q or q[-1] <= now - window]:
                    del self.hits[k]

    def allow(self, key, limit, window):
        if self.blocked(key, limit, window):
            return False
        self.hit(key, window)
        return True


# ---- per-user storage ----------------------------------------------------------------------------------------------
def uid(address):
    return hashlib.sha256(address.encode()).hexdigest()[:32]


def db_path(address):
    """One SQLite file per user: another user's rows are not even reachable by a buggy query."""
    base = os.path.dirname(os.environ.get("HARNESS_DB", "harness.db")) or "."
    p = Path(base) / "users" / uid(address) / "harness.db"
    p.parent.mkdir(parents=True, exist_ok=True)
    return str(p)


def session_ws(ws, address, sid, create=True):
    """One workspace directory per session: files, uploads, anything the tools touch."""
    p = Path(ws) / "users" / uid(address) / str(sid)
    if create:
        p.mkdir(parents=True, exist_ok=True)
    return p
