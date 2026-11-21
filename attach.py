"""Attachments of one chat message: a photo for the model to look at, documents turned into text.
Limits are the constants below. The model backend only ever gets an image on the newest message that has one (expand)."""
import base64
import re
import subprocess
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from errors import HarnessError, ToolError

MAX_FILES = 4  # per message, photo included
MAX_IMAGE_BYTES = 2_500_000
MAX_DOC_BYTES = 3_000_000
DOC_CHARS = 12_000  # text kept per document (the model window is 16K tokens)
TOTAL_CHARS = 24_000  # across all documents of one message
XML_LIMIT = 20_000_000  # largest word/document.xml we unpack (zip bombs)
WRAP = "attached_file"
IMAGE_MIME = {"jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp"}
TEXT_EXT = (".txt .md .csv .tsv .json .xml .yaml .yml .toml .ini .log .html .css .js .ts .py .sh .sql .c .h .cpp .java .go .rs .rb .php").split()


def bad(msg):
    return HarnessError("bad_request", msg)


def image_kind(raw):
    if raw[:3] == b"\xff\xd8\xff":
        return "jpg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if raw[:4] == b"GIF8":
        return "gif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return None


# ---- readers: bytes -> text (raise ToolError/HarnessError-free: they raise ValueError with a plain reason) ----------------------
def read_text(raw):
    if b"\x00" in raw[:4096]:
        raise ValueError("that doesn't look like a text file")
    return raw.decode("utf-8", errors="replace")


def read_docx(raw):
    import io
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            info = z.getinfo("word/document.xml")
            if info.file_size > XML_LIMIT:
                raise ValueError("that document is too large to read")
            root = ET.fromstring(z.read(info))
    except (zipfile.BadZipFile, KeyError, ET.ParseError):
        raise ValueError("that isn't a readable .docx file") from None
    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    paras = []
    for p in root.iter(ns + "p"):
        paras.append("".join("\t" if n.tag == ns + "tab" else "\n" if n.tag == ns + "br" else (n.text or "")
                             for n in p.iter() if n.tag in (ns + "t", ns + "tab", ns + "br")))
    return "\n".join(paras)


def read_pdf(raw):
    """Text layer via poppler's pdftotext (an apt package in the image). Scanned PDFs have no text layer: no OCR."""
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "in.pdf"
        f.write_bytes(raw)
        try:
            r = subprocess.run(["pdftotext", "-layout", "-q", str(f), "-"], capture_output=True, timeout=30)
        except FileNotFoundError:
            raise ValueError("reading PDFs isn't set up on this server") from None
        except subprocess.TimeoutExpired:
            raise ValueError("that PDF took too long to read") from None
    text = r.stdout.decode("utf-8", errors="replace")
    if r.returncode != 0 and not text.strip():
        raise ValueError("that isn't a readable PDF")
    if not text.strip():
        raise ValueError("that PDF has no text layer (is it a scan?), so I can't read it")
    return text


READERS = {**{e: read_text for e in TEXT_EXT}, ".docx": read_docx, ".pdf": read_pdf}  # extension -> reader: a new type is a row


def extract(path):
    """Text of a stored document (used by read_file for .pdf/.docx so a long document can be read page by page)."""
    p = Path(path)
    reader = READERS.get(p.suffix.lower())
    try:
        return reader(p.read_bytes())
    except ValueError as e:
        raise ToolError("unreadable", str(e), "") from None


# ---- one message's attachments ---------------------------------------------------------------------------------------------
def clean_name(name):
    base = re.sub(r"[^\w.\- ]", "_", Path(str(name).replace("\\", "/")).name).strip(" .")[:80]
    return base or "file"


def unique(name, used):
    stem, dot, ext = name.rpartition(".") if "." in name else (name, "", "")
    n, out = 1, name
    while out in used:
        n += 1
        out = f"{stem}-{n}{dot}{ext}"
    used.add(out)
    return out


def process(atts, vision):
    """Validate and read the attachments. Returns (doc_text, images, saves):
    doc_text = wrapped extracts to append to the user's text, images = [(stored path, bytes)], saves = [(stored path, bytes)]
    of every original (the model's file tools can open them from the session directory). Raises HarnessError(bad_request)."""
    if not atts:
        return "", [], []
    if not isinstance(atts, list) or len(atts) > MAX_FILES:
        raise bad(f"At most {MAX_FILES} attachments per message.")
    used, docs, images, saves, left = set(), [], [], [], TOTAL_CHARS
    for a in atts:
        if not isinstance(a, dict) or not isinstance(a.get("name"), str) or not isinstance(a.get("data"), str):
            raise bad("An attachment was not valid.")
        try:
            raw = base64.b64decode(a["data"], validate=True)
        except ValueError:
            raise bad("An attachment was not valid.") from None
        name, kind = clean_name(a["name"]), image_kind(raw)
        if kind:
            if not vision:
                raise bad("This assistant can't look at photos yet.")
            if images:
                raise bad("One photo per message, please.")
            if len(raw) > MAX_IMAGE_BYTES:
                raise bad("That photo is too large.")
            stored = f"uploads/{unique(Path(name).stem + '.' + kind, used)}"  # named by what the bytes are, not by the claimed extension
            images.append((stored, raw))
            continue
        name = unique(name, used)
        ext = Path(name).suffix.lower()
        if ext not in READERS:
            raise bad(f"I can't read {ext or 'that kind of'} files. I can read: photos, {', '.join(sorted(READERS))}.")
        if len(raw) > MAX_DOC_BYTES:
            raise bad(f"{name} is too large.")
        try:
            text = READERS[ext](raw).strip()
        except ValueError as e:
            raise bad(f"{name}: {e}.") from None
        keep = text[:min(DOC_CHARS, left)]
        left -= len(keep)
        note = "" if len(keep) == len(text) else f' (truncated: {len(keep)} of {len(text)} characters; the whole file is saved as uploads/{name} and can be read in parts)'
        docs.append(f'\n\n<{WRAP} name="{name}"{note}>\n{keep.replace(f"</{WRAP}>", "")}\n</{WRAP}>')
        saves.append((f"uploads/{name}", raw))
    return "".join(docs), images, saves


def save(ws, files):
    for rel, raw in files:
        p = Path(ws) / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(raw)


def content(text, doc_text, images):
    """The user message: plain text, or a list of parts when there is a photo (image_ref is ours, expand() makes it real)."""
    full = text + doc_text
    return full if not images else [{"type": "text", "text": full}, *({"type": "image_ref", "name": n} for n, _ in images)]


STORED = re.compile(r"^uploads/[\w][\w.\-]{0,99}$")


def expand(messages, ws):
    """Messages as the model backend should get them: an image_ref becomes an image_url data URL on the newest message that
    has one; older ones become a short note, so one photo is not re-sent with every turn."""
    last = max((i for i, m in enumerate(messages) if isinstance(m.get("content"), list)), default=None)
    if last is None:
        return messages
    out = []
    for i, m in enumerate(messages):
        if not isinstance(m.get("content"), list):
            out.append(m)
            continue
        parts = []
        for p in m["content"]:
            if p.get("type") != "image_ref":
                parts.append(p)
                continue
            f = Path(ws) / p["name"] if STORED.match(str(p.get("name"))) else None
            if i != last:
                parts.append({"type": "text", "text": "[an earlier photo is not shown]"})
            elif f and f.is_file():
                mime = IMAGE_MIME.get(f.suffix.lstrip(".").lower(), "image/jpeg")
                parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(f.read_bytes()).decode()}"}})
            else:
                parts.append({"type": "text", "text": "[the photo is no longer available]"})
        out.append({**m, "content": parts})
    return out
