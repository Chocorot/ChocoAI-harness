"""The 4 tools: JSON schemas + handlers. Handlers never raise; they return an error string."""
import subprocess
from pathlib import Path

LIMIT = 4000  # max chars of bash stdout / stderr returned to the model


def _fn(name, desc, props, req):
    return {"type": "function", "function": {"name": name, "description": desc, "parameters": {
        "type": "object", "properties": props, "required": req}}}


S, I = {"type": "string"}, {"type": "integer"}
SCHEMAS = [
    _fn("read_file", "Read lines with numbers (default 1-200).",
        {"path": S, "start_line": I, "end_line": I}, ["path"]),
    _fn("edit_file", "Replace old_text with new_text; old_text must occur exactly once.",
        {"path": S, "old_text": S, "new_text": S}, ["path", "old_text", "new_text"]),
    _fn("write_file", "Create/overwrite a small file.", {"path": S, "content": S}, ["path", "content"]),
    _fn("run_bash", "Run a shell command in the workspace.", {"command": S, "timeout": I}, ["command"]),
]


def _path(ws, p):
    full = (ws / p).resolve()  # absolute p replaces ws, resolve() follows symlinks
    if not full.is_relative_to(ws.resolve()):
        raise ValueError(f"path outside workspace: {p}")
    return full


def read_file(ws, path, start_line=1, end_line=200):
    lines = _path(ws, path).read_text(errors="replace").splitlines()
    start, end = max(1, start_line), min(end_line, len(lines), start_line + 399)  # hard cap 400 lines
    body = "\n".join(f"{n}: {lines[n - 1]}" for n in range(start, end + 1))
    return f"[lines {start}-{end} of {len(lines)}]\n{body}"


def edit_file(ws, path, old_text, new_text):
    p = _path(ws, path)
    text = p.read_text()
    n = text.count(old_text) if old_text else 0
    if n != 1:
        return f"error: old_text found {n} times, need exactly 1 (add context to make it unique)"
    p.write_text(text.replace(old_text, new_text, 1))
    return "ok"


def write_file(ws, path, content):
    p = _path(ws, path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return f"ok, wrote {len(content)} chars"


def run_bash(ws, command, timeout=30, auto_approve=False):
    if not auto_approve and input(f"\nrun `{command}`? [y/N] ").strip().lower() != "y":
        return "error: command denied by user"
    try:
        r = subprocess.run(command, shell=True, cwd=ws, capture_output=True, text=True,
                           errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        return f"error: timeout after {timeout}s"
    return f"exit={r.returncode}\nstdout:\n{r.stdout[:LIMIT]}\nstderr:\n{r.stderr[:LIMIT]}"


def run(name, args, ws, auto_approve=False):
    ws = Path(ws)
    handlers = {"read_file": read_file, "edit_file": edit_file, "write_file": write_file}
    if name != "run_bash" and name not in handlers:
        return f"error: unknown tool {name}"
    try:
        if name == "run_bash":
            return run_bash(ws, auto_approve=auto_approve, **args)
        return handlers[name](ws, **args)
    except Exception as e:  # bad args, missing file, permission, outside workspace...
        return f"error: {type(e).__name__}: {e}"
