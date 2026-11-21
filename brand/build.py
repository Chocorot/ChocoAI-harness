#!/usr/bin/env python3
"""Builds ChocoAI's brand files from ONE geometry definition: the SVG logo set, the PNG/ICO icons and the social-preview and
store images. Nothing here is AI-generated art: the SVGs are drawn from numbers below, and the PNGs are photographs
(screenshots) of real pages rendered by Firefox from the scenes in brand/scenes/.
Dev tool, macOS: needs Firefox (headless screenshots) and `sips` (resizing). Not run by CI or Docker.
Usage: python3 brand/build.py [stamp|scenes|all]   (default all). Output goes to web/ (see docs/branding-and-seo.md).
SINCE 2026-11-21 the icons (SVG, PNG, ICO) are NOT built here: they come from the shared ChocoHost-Design repo (`node brand/install.mjs ai <this repo>`), so all Choco apps look the same. This script only stamps ?v=N into the icon URLs and builds the preview/store images (scenes)."""
import functools
import http.server
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB, SCENES = ROOT / "web", ROOT / "brand" / "scenes"
FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox"

# ---- the mark: a speech bubble with a centred tail (mirror symmetric) holding an AI spark (64 x 64 grid) ------------------
VERSION = 4  # bump when the look changes: it is written into the icon URLs (?v=N), so browsers and apps refetch instead of showing a cached icon
BG_TOP, BG_BOT = "#35b4bc", "#16727a"  # brand teal, light to deep
DEEP, WHITE = "#0f5a61", "#ffffff"
BUBBLE = "M20 12h24a9 9 0 0 1 9 9v16a9 9 0 0 1-9 9H37.5L32 52l-5.5-6H20a9 9 0 0 1-9-9V21a9 9 0 0 1 9-9z"
SPARK_C, SPARK_R, PINCH = (32, 29), 10.5, 0.12  # centred in the bubble body, so the whole mark is symmetric about x = 32


def spark(fill):
    (cx, cy), r, k = SPARK_C, SPARK_R, PINCH
    return (f'<path fill="{fill}" d="M{cx} {cy - r}Q{cx + r * k:.2f} {cy - r * k:.2f} {cx + r} {cy}Q{cx + r * k:.2f} {cy + r * k:.2f} {cx} {cy + r}'
            f'Q{cx - r * k:.2f} {cy + r * k:.2f} {cx - r} {cy}Q{cx - r * k:.2f} {cy - r * k:.2f} {cx} {cy - r}Z"/>')


def mark(bubble=WHITE, sparkle=DEEP):
    """The mark alone on a 64 grid. Default colours are for teal surfaces."""
    return f'<path fill="{bubble}" d="{BUBBLE}"/>{spark(sparkle)}'


def svg(inner, size=64, view="0 0 64 64", extra=""):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" width="{size}" height="{size}"{extra}>{inner}</svg>\n'


def tile_bg(radius, uid="g"):
    return (f'<defs><linearGradient id="{uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{BG_TOP}"/><stop offset="1" stop-color="{BG_BOT}"/></linearGradient></defs>'
            f'<rect width="64" height="64" rx="{radius}" fill="url(#{uid})"/>')


def scaled(k):  # the mark scaled about the centre of the grid
    return f'<g transform="translate({32 - 32 * k:.2f} {32 - 32 * k:.2f}) scale({k})">{mark()}</g>'


def write_svgs():
    icons = WEB / "icons"
    icons.mkdir(exist_ok=True)
    label = ' role="img" aria-label="ChocoAI"'
    (icons / "mark.svg").write_text(svg(mark(), extra=label))  # white bubble: for teal surfaces. The app's logo tile uses this file
    (icons / "mark-dark.svg").write_text(svg(mark(DEEP, WHITE), extra=label))  # deep teal bubble: for light backgrounds
    (icons / "mark-mono.svg").write_text(svg(f'<path d="{BUBBLE}"/>', extra=label))  # one colour, no spark detail (stamps, print)
    (icons / "icon.svg").write_text(svg(tile_bg(14) + scaled(0.9), extra=label))  # app icon / favicon
    (icons / "icon-maskable.svg").write_text(svg(f'<rect width="64" height="64" fill="{BG_BOT}"/>' + tile_bg(0, "m") + scaled(0.56)))  # full bleed, mark inside the safe zone
    stamp_version()
    print("svg ok")


def stamp_version():
    """Write ?v=VERSION into every icon/preview URL of the page head, the manifest and the stylesheet."""
    for f in (WEB / "index.html", WEB / "manifest.webmanifest", WEB / "app.css"):
        text = f.read_text()
        text = re.sub(r"((?:/favicon\.ico|/icons/[\w.\-]+\.(?:png|svg)))(?:\?v=\d+)?(?=[\"'])", rf"\1?v={VERSION}", text)
        f.write_text(text)


# ---- rendering: Firefox photographs a page, sips resizes -------------------------------------------------------------------
def shot(url, out, w, h):
    prof = tempfile.mkdtemp(prefix="ffbrand-")
    try:
        subprocess.run([FIREFOX, "--headless", "-profile", prof, "--no-remote", "--screenshot", str(out), f"--window-size={w},{h}", url],
                       capture_output=True, timeout=120, check=False)
    finally:
        shutil.rmtree(prof, ignore_errors=True)
    if not Path(out).exists():
        sys.exit(f"screenshot failed: {url}")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def translate_path(self, path):  # /brand/... comes from brand/, everything else from web/
        p = path.split("?")[0]
        base = ROOT if p.startswith("/brand/") else WEB
        return str(base / p.lstrip("/"))


def serve():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def resize(src, dst, px):
    subprocess.run(["sips", "-z", str(px), str(px), str(src), "--out", str(dst)], capture_output=True, check=True)


def ico(pngs, out):
    """A .ico that holds PNG images (supported by every browser since IE9)."""
    data = [Path(p).read_bytes() for p in pngs]
    head, body, offset = struct.pack("<HHH", 0, 1, len(data)), b"", 6 + 16 * len(data)
    for p, d in zip(pngs, data):
        px = int(struct.unpack(">I", d[16:20])[0])
        head += struct.pack("<BBBBHHII", px % 256, px % 256, 0, 0, 1, 32, len(d), offset)
        body += d
        offset += len(d)
    Path(out).write_bytes(head + body)


def write_icons():
    srv, base = serve()
    tmp = Path(tempfile.mkdtemp(prefix="brand-"))
    try:
        for name, svgname in (("any", "icon.svg"), ("maskable", "icon-maskable.svg")):
            page = tmp / f"{name}.html"
            page.write_text(f'<!doctype html><meta charset=utf-8><style>html,body{{margin:0;background:transparent}}img{{display:block;width:1024px;height:1024px}}</style><img src="{base}/icons/{svgname}">')
            shutil.copy(page, WEB / f"_{name}.html")  # must be served by the same origin
            try:
                shot(f"{base}/_{name}.html", tmp / f"{name}-1024.png", 1024, 1024)
            finally:
                (WEB / f"_{name}.html").unlink(missing_ok=True)
        icons = WEB / "icons"
        for px, src, dst in ((512, "any", "icon-512.png"), (192, "any", "icon-192.png"), (180, "any", "apple-touch-icon.png"),
                             (512, "maskable", "icon-maskable-512.png")):
            resize(tmp / f"{src}-1024.png", icons / dst, px)
        for px in (16, 32, 48):
            resize(tmp / "any-1024.png", tmp / f"f{px}.png", px)
        ico([tmp / "f16.png", tmp / "f32.png", tmp / "f48.png"], WEB / "favicon.ico")
        print("icons ok")
    finally:
        srv.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


def write_scenes():
    srv, base = serve()
    try:
        for scene, out, w, h in (("og", WEB / "icons" / "og.png", 1200, 630),
                                 ("shot-wide", WEB / "icons" / "screenshot-wide.png", 1280, 800),
                                 ("shot-narrow", WEB / "icons" / "screenshot-narrow.png", 390, 844)):
            shot(f"{base}/brand/scenes/{scene}.html", out, w, h)
        print("scenes ok")
    finally:
        srv.shutdown()


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("svg", "icons"):
        sys.exit("icons moved: run `node brand/install.mjs ai <path to this repo>` in ChocoHost-Design (docs/brand.md there)")
    if what in ("stamp", "all"):
        stamp_version()
        print("stamp ok")
    if what in ("scenes", "all"):
        write_scenes()
