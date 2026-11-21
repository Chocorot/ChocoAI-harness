#!/usr/bin/env python3
"""Builds ChocoAI's brand files from ONE geometry definition: the SVG logo set, the PNG/ICO icons and the social-preview and
store images. Nothing here is AI-generated art: the SVGs are drawn from numbers below, and the PNGs are photographs
(screenshots) of real pages rendered by Firefox from the scenes in brand/scenes/.
Dev tool, macOS: needs Firefox (headless screenshots) and `sips` (resizing). Not run by CI or Docker.
Usage: python3 brand/build.py [svg|icons|scenes|all]   (default all). Output goes to web/ (see docs/branding-and-seo.md)."""
import functools
import http.server
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

# ---- the mark: a chocolate bar of 2x2 squares, one square is an AI spark (64 x 64 grid) ----------------------------------
BG_TOP, BG_BOT = "#2fa8b0", "#16727a"  # brand teal, light to deep
CHOC, SPARK = "#4f2e1d", "#ffc54d"  # dark chocolate, golden spark
T, GAP, M, R = 25.5, 3, 5, 6  # square size, groove, margin, corner radius
POS = (M, M + T + GAP)  # 5 and 33.5
CX = POS[1] + T / 2  # centre of the right column
SPARK_PATH = (f"M{CX:.2f} 3.2C{CX + 1.5:.2f} 12.6 {CX + 5:.2f} 16.3 {CX + 14.2:.2f} 17.75C{CX + 5:.2f} 19.2 {CX + 1.5:.2f} 22.9 {CX:.2f} 32.3"
              f"C{CX - 1.5:.2f} 22.9 {CX - 5:.2f} 19.2 {CX - 14.2:.2f} 17.75C{CX - 5:.2f} 16.3 {CX - 1.5:.2f} 12.6 {CX:.2f} 3.2Z")


def square(x, y, fill, shine="#ffffff", shine_opacity=0.16):
    """One chocolate square: flat colour plus a thin raised edge, which fades away at small sizes."""
    return (f'<rect x="{x}" y="{y}" width="{T}" height="{T}" rx="{R}" fill="{fill}"/>'
            f'<rect x="{x + 3.2}" y="{y + 3.2}" width="{T - 6.4}" height="{T - 6.4}" rx="{R - 2.6}" fill="none" stroke="{shine}" stroke-opacity="{shine_opacity}" stroke-width="1.3"/>')


def mark(tile=CHOC, spark=SPARK, shine="#ffffff", shine_opacity=0.16):
    """The mark alone on a 64 grid: three squares and the spark in the top right."""
    sq = "".join(square(x, y, tile, shine, shine_opacity) for x, y in ((POS[0], POS[0]), (POS[0], POS[1]), (POS[1], POS[1])))
    return f'{sq}<path fill="{spark}" d="{SPARK_PATH}"/>'


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
    (icons / "mark.svg").write_text(svg(mark(), extra=' role="img" aria-label="ChocoAI"'))  # transparent, for light backgrounds
    (icons / "icon.svg").write_text(svg(tile_bg(14) + scaled(0.74), extra=' role="img" aria-label="ChocoAI"'))  # app icon / favicon
    (icons / "icon-maskable.svg").write_text(svg(f'<rect width="64" height="64" fill="{BG_BOT}"/>' + tile_bg(0, "m") + scaled(0.5)))  # full bleed, mark inside the safe zone
    (icons / "mark-light.svg").write_text(svg(mark("#f4ece6", SPARK, "#4f2e1d", 0.18), extra=' role="img" aria-label="ChocoAI"'))  # for dark backgrounds
    (icons / "mark-mono.svg").write_text(svg(mark("#000", "#000", "#fff", 0)))  # one colour (stamps, print)
    print("svg ok")


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
    if what in ("svg", "all"):
        write_svgs()
    if what in ("icons", "all"):
        write_icons()
    if what in ("scenes", "all"):
        write_scenes()
