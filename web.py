"""Internet for the model: read a page as text, search through SearxNG. All network access of the tools lives here.
SSRF guard: only public addresses are ever contacted. The hostname is resolved once, every address must be public, and we
connect to that exact address (so a DNS answer that changes between check and connect can't redirect us); every redirect
is checked again. Fetched text is wrapped as untrusted data."""
import html.parser
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import time
import urllib.parse
import urllib.request

from errors import ToolError

PAGE_CHARS = 8000  # per call; the model pages with `start` (a 16K-token window can't take more)
MAX_BYTES = 1_000_000
MAX_REDIRECTS = 3
TIMEOUT = 10  # per socket operation
DEADLINE = 25  # whole fetch
UA = "Mozilla/5.0 (compatible; ChocoHarness/1.0)"
TEXT_TYPES = ("text/", "application/json", "application/xml", "application/xhtml", "application/rss", "application/atom")
WRAP = "untrusted_web_content"


def public_ip(ip):
    """True only for globally routable addresses (not private, loopback, link-local, tailnet 100.64/10, multicast...)."""
    a = ipaddress.ip_address(ip)
    a = getattr(a, "ipv4_mapped", None) or a
    return a.is_global and not a.is_multicast  # multicast counts as "global" in the stdlib, but is not a website


def resolve(host, port):
    """The address to connect to. Refuses when ANY answer is non-public (a mixed answer is a rebinding trick)."""
    try:
        ips = list(dict.fromkeys(i[4][0].split("%")[0] for i in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)))
    except socket.gaierror as e:
        raise ToolError("fetch_failed", f"can't resolve {host}: {e.strerror or e}", "check the address") from None
    if not ips or not all(public_ip(i) for i in ips):
        raise ToolError("fetch_blocked", f"{host} is not a public internet address", "only public websites can be opened")
    return ips[0]


def _split(url):
    if not isinstance(url, str) or not url.strip() or len(url) > 2000:
        raise ToolError("bad_url", "url must be a web address (up to 2000 characters)", "send a full https:// address")
    u = urllib.parse.urlsplit(url.strip())
    if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password:
        raise ToolError("bad_url", "only plain http(s) addresses without a login are allowed", "send a full https:// address")
    try:
        port = u.port or (443 if u.scheme == "https" else 80)
    except ValueError:
        raise ToolError("bad_url", "invalid port", "") from None
    return u, port


def _get(url):
    """(body bytes, final url, content type) following up to MAX_REDIRECTS redirects, each one re-checked."""
    stop = time.time() + DEADLINE
    for _ in range(MAX_REDIRECTS + 1):
        u, port = _split(url)
        ip = resolve(u.hostname, port)
        try:
            sock = socket.create_connection((ip, port), TIMEOUT)
            if u.scheme == "https":
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=u.hostname)
            conn = http.client.HTTPConnection(u.hostname, port, timeout=TIMEOUT)
            conn.sock = sock  # connect to the address we checked, not whatever the name resolves to now
            conn.request("GET", (u.path or "/") + (f"?{u.query}" if u.query else ""),
                         headers={"User-Agent": UA, "Accept": "text/html,text/plain;q=0.9,*/*;q=0.5",
                                  "Accept-Encoding": "identity", "Connection": "close"})
            r = conn.getresponse()
            if r.status in (301, 302, 303, 307, 308) and r.getheader("Location"):
                url = urllib.parse.urljoin(url, r.getheader("Location"))
                conn.close()
                continue
            ctype = (r.getheader("Content-Type") or "").split(";")[0].strip().lower()
            if r.status >= 400:
                raise ToolError("fetch_failed", f"the site answered HTTP {r.status}", "try another address")
            if ctype and not ctype.startswith(TEXT_TYPES):
                raise ToolError("fetch_failed", f"can't read content type {ctype}", "only text pages can be opened")
            body = b""
            while len(body) < MAX_BYTES and time.time() < stop:
                chunk = r.read(16384)
                if not chunk:
                    break
                body += chunk
            m = re.search(r"charset=([\w-]+)", r.getheader("Content-Type") or "", re.I)
            return body[:MAX_BYTES].decode(m.group(1) if m else "utf-8", errors="replace"), url, ctype
        except (OSError, http.client.HTTPException, LookupError) as e:  # LookupError: unknown charset
            raise ToolError("fetch_failed", f"{type(e).__name__}: {e}", "the site may be down; try later or another address") from None
    raise ToolError("fetch_failed", "too many redirects", "try the final address directly")


class _Text(html.parser.HTMLParser):
    """HTML -> readable text: drops scripts/styles, keeps paragraphs, and keeps link targets as `text (url)`."""
    SKIP = {"script", "style", "noscript", "svg", "template"}
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer",
             "pre", "table", "ul", "ol", "blockquote", "title"}

    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base, self.out, self.skip, self.href, self.links = base, [], 0, None, 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        if tag in self.BLOCK:
            self.out.append("\n")
        if tag == "a":
            self.href = dict(attrs).get("href")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        if tag in self.BLOCK:
            self.out.append("\n")
        if tag == "a" and self.href and self.links < 40:
            url = urllib.parse.urljoin(self.base, self.href)
            if url.startswith(("http://", "https://")):
                self.out.append(f" ({url})")
                self.links += 1
            self.href = None

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)


def to_text(body, ctype, url):
    if ctype in ("text/html", "application/xhtml+xml", ""):
        p = _Text(url)
        p.feed(body)
        body = "".join(p.out)
    lines = [re.sub(r"[ \t\r\f\v]+", " ", ln).strip() for ln in body.splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def wrap(url, text):
    return f'<{WRAP} url="{url}">\n{text.replace(WRAP, "untrusted-content")}\n</{WRAP}>'


def fetch(url, start=0):
    """web_fetch tool: the page as text, PAGE_CHARS at a time."""
    body, final, ctype = _get(url)
    text = to_text(body, ctype, final)
    start = start if isinstance(start, int) and not isinstance(start, bool) and start >= 0 else 0
    end = min(len(text), start + PAGE_CHARS)
    more = f" More: call web_fetch again with start={end}." if end < len(text) else ""
    return wrap(final, f"[chars {start}-{end} of {len(text)}.{more}]\n{text[start:end]}" if text else "[the page has no readable text]")


def search(query):
    """web_search tool: top results from the SearxNG instance in SEARCH_URL (an operator-set, trusted address)."""
    base = os.environ.get("SEARCH_URL", "")
    if not base.startswith(("http://", "https://")):
        raise ToolError("search_unavailable", "web search is not set up", "use web_fetch with a known address instead")
    if not isinstance(query, str) or not query.strip() or len(query) > 300:
        raise ToolError("bad_args", "query must be 1 to 300 characters", "")
    url = f"{base}{'&' if '?' in base else '?'}{urllib.parse.urlencode({'q': query.strip(), 'format': 'json'})}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=20) as r:
            results = json.loads(r.read(MAX_BYTES))["results"][:5]
    except (OSError, ValueError, KeyError, http.client.HTTPException) as e:
        raise ToolError("search_failed", f"{type(e).__name__}: {e}", "try again or use web_fetch") from None
    if not results:
        return wrap("search", "[no results]")
    return wrap("search", "\n\n".join(f"{i}. {x.get('title', '')}\n{x.get('url', '')}\n{(x.get('content') or '')[:300]}"
                                      for i, x in enumerate(results, 1)))
