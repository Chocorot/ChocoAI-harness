"""Runtime settings. ONE table (FIELDS) drives validation, storage and the /manage manifest, so a new setting is one
row here and appears in the dashboard with no dashboard change. Overrides live in a JSON file next to the DB and are
re-read on every call: an edit applies from the next run, no restart."""
import json
import math
import os
import shutil
import tempfile

SYSTEM_PROMPT = (  # the tools a caller may use are described by tools.prompts_for(), appended per run
    "You are an agent working in a workspace directory. Complete the user's goal with the tools you are given. Rules: "
    "read only the line ranges you need; "
    "prefer edit_file (exact unique old_text) over rewriting files; "
    "check your work; "
    "keep replies short; "
    "when done, reply with a brief summary and call no tools."
)

PUBLIC_PROMPT = (
    "You are a friendly, concise assistant on a public website. You cannot browse the web, run code or use tools. "
    "If asked to, say so briefly. Do not claim to remember earlier visits."
)

# type: string | text | int | float. `env`: an environment variable that supplies the default when set.
# `optional`: the default is "not sent to the backend". A null value resets a field to its default.
FIELDS = [
    {"key": "system_prompt", "label": "System prompt", "type": "text", "default": SYSTEM_PROMPT, "min": 1, "max": 8000,
     "help": "Sent first in every run. Keep it short: the backend window is 16K tokens. Applies from the next run, also to resumed sessions."},
    {"key": "model", "label": "Model", "type": "string", "default": "qwen/qwen3.6-35b-a3b", "env": "MODEL", "min": 1, "max": 200,
     "help": "Model id sent to the backend."},
    {"key": "max_turns", "label": "Max turns per run", "type": "int", "default": 15, "min": 1, "max": 100,
     "help": "Model calls before a run is stopped (a stopped session can be continued)."},
    {"key": "compact_at", "label": "Compact above (est. tokens)", "type": "int", "default": 11000, "min": 1000, "max": 200000,
     "help": "Older tool traffic is shrunk above this estimate. Keep it below the backend window minus room for the reply."},
    {"key": "keep_turns", "label": "Turns kept intact", "type": "int", "default": 4, "min": 1, "max": 50,
     "help": "The last N turns are never shrunk by compaction."},
    {"key": "max_seconds", "label": "Max seconds per run", "type": "int", "default": 900, "min": 1, "max": 7200,
     "help": "Wall-clock budget of one run (including helpers). The run stops with a notice when it is used up."},
    {"key": "max_run_tokens", "label": "Max tokens per run", "type": "int", "default": 200000, "min": 1000, "max": 5000000,
     "help": "Prompt + reply tokens added up over every model call of a run (prompts are re-sent each turn)."},
    {"key": "delegate_turns", "label": "Max turns of a helper", "type": "int", "default": 8, "min": 1, "max": 50,
     "help": "Model calls a delegated subtask may use before it must report back."},
    {"key": "retries", "label": "Auto-retries on model errors", "type": "int", "default": 2, "min": 0, "max": 5,
     "help": "How often a run silently retries when the model server is down, errors or garbles a reply (waits 2s, 6s, 15s)."},
    {"key": "max_queue", "label": "Max runs waiting in line", "type": "int", "default": 8, "min": 0, "max": 100,
     "help": "One run executes at a time. More waiting than this gets a 'busy' answer."},
    {"key": "public_prompt", "label": "Public chat prompt", "type": "text", "default": PUBLIC_PROMPT, "min": 1, "max": 4000,
     "help": "System prompt for visitors who are not signed in (chat only, no tools)."},
    {"key": "public_rpm", "label": "Public requests per minute (per IP)", "type": "int", "default": 6, "min": 1, "max": 600,
     "help": "Visitors above this get a 'too many requests' answer."},
    {"key": "max_queue_public", "label": "Public visitors allowed to wait", "type": "int", "default": 2, "min": 0, "max": 100,
     "help": "Public visitors are refused (busy) when this many are already waiting, so signed-in users still get in."},
    {"key": "public_max_chars", "label": "Public history size (characters)", "type": "int", "default": 24000, "min": 500, "max": 200000,
     "help": "Older messages of a public chat are dropped above this size. The window is 16K tokens."},
    {"key": "public_max_tokens", "label": "Public max reply tokens", "type": "int", "default": 1024, "min": 16, "max": 32768,
     "help": "Caps the length of a public reply so one visitor can't hold the model for minutes."},
    {"key": "temperature", "label": "Temperature", "type": "float", "default": None, "optional": True, "min": 0, "max": 2,
     "help": "Empty = backend default."},
    {"key": "max_tokens", "label": "Max reply tokens", "type": "int", "default": None, "optional": True, "min": 16, "max": 131072,
     "help": "Empty = backend default."},
]
BY_KEY = {f["key"]: f for f in FIELDS}


def path():
    if os.environ.get("HARNESS_SETTINGS"):
        return os.environ["HARNESS_SETTINGS"]
    return os.path.join(os.path.dirname(os.environ.get("HARNESS_DB", "harness.db")) or ".", "settings.json")


def default(key):
    f = BY_KEY[key]
    env = os.environ.get(f["env"]) if f.get("env") else None
    return env if env else f["default"]


def _check(f, v):
    """Error text, or None when v is a valid value for field f."""
    t = f["type"]
    if t in ("string", "text"):
        if not isinstance(v, str):
            return "must be text"
        if len(v.strip()) < f["min"] or len(v) > f["max"]:
            return f"must have {f['min']} to {f['max']} characters"
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return "must be a number"
    if t == "int" and not isinstance(v, int):
        return "must be a whole number"
    if not math.isfinite(v) or not f["min"] <= v <= f["max"]:
        return f"must be between {f['min']} and {f['max']}"
    return None


def _read():
    try:
        with open(path()) as fh:
            raw = json.load(fh)
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def get(key):
    """The override when it is present and still valid, else the default (a hand-edited bad file can never break a run)."""
    v = _read().get(key)
    return v if v is not None and _check(BY_KEY[key], v) is None else default(key)


def current():
    return {f["key"]: get(f["key"]) for f in FIELDS}


def validate(updates):
    """(clean, None) or (None, error). All or nothing. A null value means "reset to default"."""
    if not isinstance(updates, dict) or not updates:
        return None, "settings must be a non-empty object"
    clean = {}
    for key, value in updates.items():
        f = BY_KEY.get(key)
        if not f:
            return None, f"unknown setting: {key}"
        if value is not None:
            err = _check(f, value)
            if err:
                return None, f"{key} {err}"
        clean[key] = value
    return clean, None


def save(updates):
    """Validate, merge into the file (atomic replace, previous file kept as .bak). Returns (current values, None) or (None, error)."""
    clean, err = validate(updates)
    if err:
        return None, err
    stored = _read()
    for key, value in clean.items():
        if value is None:
            stored.pop(key, None)
        else:
            stored[key] = value
    p = path()
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    if os.path.exists(p):
        shutil.copy2(p, p + ".bak")
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p) or ".", prefix=".settings-")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(stored, fh, indent=2)
        os.replace(tmp, p)
    except BaseException:
        os.unlink(tmp)
        raise
    return current(), None


def manifest():
    """The settings block of GET /manage/manifest (the contract is in choc-node-agent docs/ai-gateway.md)."""
    out = []
    for f in FIELDS:
        row = {k: f[k] for k in ("key", "label", "type", "help", "min", "max") if k in f}
        row.update(value=get(f["key"]), default=default(f["key"]), optional=bool(f.get("optional")))
        out.append(row)
    out.append({"key": "base_url", "label": "Backend URL", "type": "readonly",
                "value": os.environ.get("BASE_URL", "http://localhost:1235/v1"),
                "help": "Set by the BASE_URL environment variable (restart to change)."})
    return out
