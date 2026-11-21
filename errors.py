"""Typed failures. ONE table (KINDS) says how every failure looks to the user and to the model; from_upstream() and
classify() map exceptions onto it. A new failure type is a new row here, no other code changes."""
import http.client
import json
import re
import urllib.error

NOTE_PREFIX = "[run failed: "  # marks the note we save in a session so the model knows its last reply failed

# status: HTTP status for non-stream replies. retryable: the UI offers a Retry button. auto: the harness itself retries.
# msg: plain words for the user. hint: what the model is told so it can react.
KINDS = {
    "upstream_down": {"status": 502, "retryable": True, "auto": True,
                      "msg": "The AI model server can't be reached right now.",
                      "hint": "The model backend was unreachable. Nothing was lost; the user can retry."},
    "upstream_timeout": {"status": 504, "retryable": True, "auto": False,
                         "msg": "The model took too long to answer.",
                         "hint": "The model backend timed out. Try a shorter or simpler step."},
    "upstream_5xx": {"status": 502, "retryable": True, "auto": True,
                     "msg": "The model server hit an error.",
                     "hint": "The model backend returned a server error."},
    "upstream_4xx": {"status": 502, "retryable": False, "auto": False,
                     "msg": "The model server rejected the request.",
                     "hint": "The model backend rejected the request as invalid."},
    "upstream_auth": {"status": 502, "retryable": False, "auto": False,
                      "msg": "The model server refused our credentials. The admin needs to fix the key.",
                      "hint": "The model backend refused the harness credentials."},
    "upstream_bad_stream": {"status": 502, "retryable": True, "auto": True,
                            "msg": "The model's reply was cut off or garbled.",
                            "hint": "The model reply stream broke before it finished."},
    "context_overflow": {"status": 413, "retryable": False, "auto": False,
                         "msg": "This conversation is too long for the model. Start a new chat.",
                         "hint": "The conversation exceeded the model context window even after shrinking old tool output."},
    "busy": {"status": 503, "retryable": True, "auto": False,
             "msg": "The AI is busy with other requests. Try again in a moment.",
             "hint": "The run queue was full."},
    "rate_limited": {"status": 429, "retryable": True, "auto": False,
                     "msg": "Too many requests. Wait a moment and try again.", "hint": "The caller was rate limited."},
    "login_unavailable": {"status": 503, "retryable": True, "auto": False,
                          "msg": "Sign-in is unavailable right now (the mail server can't be reached). Try again shortly.",
                          "hint": ""},
    "forbidden": {"status": 403, "retryable": False, "auto": False, "msg": "You don't have access to that.", "hint": ""},
    "bad_request": {"status": 400, "retryable": False, "auto": False, "msg": "That request was not valid.", "hint": ""},
    "not_found": {"status": 404, "retryable": False, "auto": False, "msg": "Not found.", "hint": ""},
    "auth": {"status": 401, "retryable": False, "auto": False, "msg": "unauthorized", "hint": ""},
    "internal": {"status": 500, "retryable": True, "auto": False,
                 "msg": "Something broke inside the harness.",
                 "hint": "An internal error stopped the run."},
}
BACKOFF = (2, 6, 15)  # seconds before auto-retry 1, 2, 3...
# LM Studio / llama.cpp wording for a prompt that does not fit the window
OVERFLOW = re.compile(r"context (length|window|size|overflow)|n_ctx|too many tokens|maximum context|"
                      r"exceeds? the (available )?context|tokens to keep", re.I)


class HarnessError(Exception):
    def __init__(self, kind, message=None, *, code=None, detail=""):
        row = KINDS[kind]
        self.message = message or row["msg"]
        super().__init__(self.message)
        self.kind, self.code, self.detail = kind, code or kind, str(detail)
        self.status, self.retryable, self.auto, self.hint = row["status"], row["retryable"], row["auto"], row["hint"]

    def note(self):
        """Text saved into the session so the model's next turn knows what happened."""
        return f"{NOTE_PREFIX}{self.kind}/{self.code}] {self.message} {self.hint}".strip()

    def event(self, rid=None):
        # `d` duplicates `msg` for older pages that only read `d`
        return {"t": "error", "kind": self.kind, "code": self.code, "msg": self.message, "d": self.message,
                "retryable": self.retryable, "detail": self.detail[:300], "rid": rid, "note": self.note()}

    def body(self, rid=None):
        return {"error": self.message, "kind": self.kind, "code": self.code, "retryable": self.retryable, "rid": rid}


def _body(e):
    """The backend's own explanation (LM Studio puts the reason in the HTTP body). Bounded; never raises."""
    try:
        raw = e.read(2000).decode(errors="replace")
    except Exception:
        return ""
    try:
        err = json.loads(raw).get("error")
        return err.get("message", raw) if isinstance(err, dict) else str(err or raw)
    except (ValueError, AttributeError):
        return raw


def from_upstream(e):
    """Map an exception raised while talking to the model backend onto a HarnessError."""
    if isinstance(e, HarnessError):
        return e
    if isinstance(e, urllib.error.HTTPError):
        body, s = _body(e), e.code
        if s in (401, 403):
            kind = "upstream_auth"
        elif OVERFLOW.search(body):
            kind = "context_overflow"
        elif s >= 500 or s == 429:
            kind = "upstream_5xx"
        else:
            kind = "upstream_4xx"
        return HarnessError(kind, code=f"http_{s}", detail=body)
    reason = e.reason if isinstance(e, urllib.error.URLError) else e
    if isinstance(reason, TimeoutError):
        return HarnessError("upstream_timeout", code="timeout", detail=e)
    if isinstance(e, ValueError):
        return HarnessError("upstream_bad_stream", code="bad_json", detail=e)
    if isinstance(e, ConnectionRefusedError) or isinstance(reason, ConnectionRefusedError):
        return HarnessError("upstream_down", code="refused", detail=e)
    if isinstance(e, (OSError, http.client.HTTPException)):
        return HarnessError("upstream_down", code=type(reason).__name__.lower(), detail=e)
    return classify(e)


def classify(e):
    """Any exception -> HarnessError. Unknown ones are `internal` (the caller logs the traceback)."""
    if isinstance(e, HarnessError):
        return e
    return HarnessError("internal", code=type(e).__name__, detail=f"{type(e).__name__}: {e}")
