/**
 * Internet for the model: read a page as text, search through SearxNG. All network access of the tools lives here.
 * SSRF guard: only public addresses are ever contacted. The hostname is resolved once, every address must be public, and we
 * connect to that exact address (so a DNS answer that changes between check and connect can't redirect us); every redirect
 * is checked again. Fetched text is wrapped as untrusted data. Port of legacy/web.py.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { ToolError } from './errors.ts'

export const PAGE_CHARS = 8000 // per call; the model pages with `start` (a 16K-token window can't take more)
export const MAX_BYTES = 1_000_000
export const MAX_REDIRECTS = 3
const TIMEOUT = 10_000 // per socket operation, ms
const DEADLINE = 25_000 // whole fetch, ms
const UA = 'Mozilla/5.0 (compatible; ChocoHarness/1.0)'
const TEXT_TYPES = ['text/', 'application/json', 'application/xml', 'application/xhtml', 'application/rss', 'application/atom']
export const WRAP = 'untrusted_web_content'

// ---- which addresses count as "the public internet" ----------------------------------------------------------------------
type Cidr4 = [number, number] // [network, prefix length]
const ip4 = (s: string): number => s.split('.').reduce((n, p) => n * 256 + Number(p), 0)
const c4 = (s: string): Cidr4 => {
  const [a, p] = s.split('/')
  return [ip4(a!), Number(p)]
}
const inV4 = (n: number, [net_, bits]: Cidr4): boolean => bits === 0 || Math.floor(n / 2 ** (32 - bits)) === Math.floor(net_ / 2 ** (32 - bits))
// Not globally routable (same list as Python's ipaddress.is_global) plus the tailnet range 100.64/10 and multicast.
const NON_GLOBAL_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'].map(c4)
const GLOBAL_V4_EXCEPTIONS = ['192.0.0.9/32', '192.0.0.10/32'].map(c4)

/** An IPv6 text form as a BigInt (handles `::` and a dotted IPv4 tail). */
function v6ToBig(s: string): bigint {
  let h = s.split('%')[0]!.toLowerCase()
  const tail = h.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (tail) {
    const n = ip4(tail[1]!)
    h = h.slice(0, -tail[1]!.length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16)
  }
  const [left, right] = h.split('::')
  const l = left ? left.split(':') : []
  const r = right === undefined ? [] : right ? right.split(':') : []
  const mid = right === undefined ? [] : Array(8 - l.length - r.length).fill('0')
  return [...l, ...mid, ...r].reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n)
}
const c6 = (s: string): [bigint, number] => {
  const [a, p] = s.split('/')
  return [v6ToBig(a!), Number(p)]
}
const inV6 = (n: bigint, [net_, bits]: [bigint, number]): boolean => n >> BigInt(128 - bits) === net_ >> BigInt(128 - bits)
const NON_GLOBAL_V6 = ['::/128', '::1/128', '64:ff9b:1::/48', '100::/64', '2001::/23', '2001:db8::/32', '2002::/16', 'fc00::/7', 'fe80::/10', 'ff00::/8', '3fff::/20'].map(c6)
const GLOBAL_V6_EXCEPTIONS = ['2001:1::1/128', '2001:1::2/128', '2001:3::/32', '2001:4:112::/48', '2001:20::/28', '2001:30::/28'].map(c6)

/** True only for globally routable addresses (not private, loopback, link-local, tailnet 100.64/10, multicast...). */
export function publicIp(ip: string): boolean {
  const clean = ip.split('%')[0]!
  if (net.isIPv4(clean)) {
    const n = ip4(clean)
    if (clean === '255.255.255.255') return false
    if (GLOBAL_V4_EXCEPTIONS.some((c) => inV4(n, c))) return true
    return !NON_GLOBAL_V4.some((c) => inV4(n, c))
  }
  if (!net.isIPv6(clean)) return false
  const n = v6ToBig(clean)
  if (n >> 32n === 0xffffn) return publicIp([24, 16, 8, 0].map((s) => Number((n >> BigInt(s)) & 0xffn)).join('.')) // IPv4-mapped (::ffff:a.b.c.d)
  if (GLOBAL_V6_EXCEPTIONS.some((c) => inV6(n, c))) return true
  return !NON_GLOBAL_V6.some((c) => inV6(n, c))
}

/** Network seams; tests replace them to talk to a local server or fake DNS. */
export const hooks = {
  publicIp,
  lookup: async (host: string): Promise<string[]> => (await dnsLookup(host, { all: true })).map((a) => a.address),
}

/** The address to connect to. Refuses when ANY answer is non-public (a mixed answer is a rebinding trick). */
export async function resolve(host: string): Promise<string> {
  let ips: string[]
  if (net.isIP(host)) ips = [host]
  else {
    try {
      ips = [...new Set(await hooks.lookup(host))]
    } catch (e) {
      throw new ToolError('fetch_failed', `can't resolve ${host}: ${(e as { message?: string }).message ?? e}`, 'check the address')
    }
  }
  if (!ips.length || !ips.every((i) => hooks.publicIp(i))) throw new ToolError('fetch_blocked', `${host} is not a public internet address`, 'only public websites can be opened')
  return ips[0]!
}

function split(url: unknown): { u: URL; port: number; host: string } {
  const bad = (m: string) => new ToolError('bad_url', m, 'send a full https:// address')
  if (typeof url !== 'string' || !url.trim() || url.length > 2000) throw bad('url must be a web address (up to 2000 characters)')
  // The URL parser is forgiving (`http:///x` and `http:x` become http://x/); an empty host or a missing `//` must stay an error.
  if (!/^https?:\/\/[^/?#\s]/i.test(url.trim())) throw bad('only plain http(s) addresses without a login are allowed')
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    throw bad('only plain http(s) addresses without a login are allowed')
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) throw bad('only plain http(s) addresses without a login are allowed')
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(port) || port > 65535) throw new ToolError('bad_url', 'invalid port', '')
  return { u, port, host: u.hostname.replace(/^\[|\]$/g, '') }
}

/** One request to the address we checked. Returns the response head and the first MAX_BYTES of the body. */
function request(u: URL, host: string, port: number, ip: string, stop: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve_, reject) => {
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request(
      {
        host,
        port,
        path: (u.pathname || '/') + u.search,
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'identity', Connection: 'close' },
        // connect to the address we checked, not whatever the name resolves to now (TLS still verifies the real host name)
        lookup: (_h: string, opts: { all?: boolean }, cb: (...a: any[]) => void) => (opts?.all ? cb(null, [{ address: ip, family: net.isIPv6(ip) ? 6 : 4 }]) : cb(null, ip, net.isIPv6(ip) ? 6 : 4)),
        servername: net.isIP(host) ? undefined : host,
        timeout: TIMEOUT,
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        const finish = () => resolve_({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).subarray(0, MAX_BYTES) })
        res.on('data', (c: Buffer) => {
          chunks.push(c)
          size += c.length
          if (size >= MAX_BYTES || Date.now() >= stop) {
            res.destroy()
            finish()
          }
        })
        res.on('end', finish)
        res.on('error', (e) => (size > 0 ? finish() : reject(e)))
        res.on('close', finish)
      },
    )
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })
}

/** [body text, final url, content type], following up to MAX_REDIRECTS redirects, each one re-checked. */
async function get(url: string): Promise<{ body: string; final: string; ctype: string }> {
  const stop = Date.now() + DEADLINE
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { u, port, host } = split(url)
    const ip = await resolve(host)
    let r
    try {
      r = await request(u, host, port, ip, stop)
    } catch (e) {
      const err = e as { name?: string; message?: string }
      throw new ToolError('fetch_failed', `${err.name ?? 'Error'}: ${err.message ?? e}`, 'the site may be down; try later or another address')
    }
    const loc = r.headers.location
    if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
      url = new URL(loc, url).href
      continue
    }
    const ctypeFull = String(r.headers['content-type'] ?? '')
    const ctype = ctypeFull.split(';')[0]!.trim().toLowerCase()
    if (r.status >= 400) throw new ToolError('fetch_failed', `the site answered HTTP ${r.status}`, 'try another address')
    if (ctype && !TEXT_TYPES.some((t) => ctype.startsWith(t))) throw new ToolError('fetch_failed', `can't read content type ${ctype}`, 'only text pages can be opened')
    const label = ctypeFull.match(/charset=([\w-]+)/i)?.[1] ?? 'utf-8'
    let text: string
    try {
      text = new TextDecoder(label, { fatal: false }).decode(r.body)
    } catch {
      throw new ToolError('fetch_failed', `LookupError: unknown encoding: ${label}`, 'the site may be down; try later or another address')
    }
    return { body: text, final: url, ctype }
  }
  throw new ToolError('fetch_failed', 'too many redirects', 'try the final address directly')
}

// ---- HTML -> readable text (the same rules as Python's HTMLParser version) ---------------------------------------------------
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', middot: '·', bull: '•', laquo: '«', raquo: '»', times: '×', trade: '™', sect: '§', para: '¶' }
// shortcut: the common named entities only (not the full HTML5 table of ~2000); upgrade if pages show raw `&name;`
const unescape = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m
  })

const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'template'])
const BLOCK = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'header', 'footer', 'pre', 'table', 'ul', 'ol', 'blockquote', 'title'])
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

function htmlText(html: string, base: string): string {
  const out: string[] = []
  let skip = 0
  let href: string | null = null
  let links = 0
  const startTag = (tag: string, attrs: string) => {
    if (SKIP.has(tag)) skip++
    if (BLOCK.has(tag)) out.push('\n')
    if (tag === 'a') {
      const m = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
      href = m ? unescape(m[1] ?? m[2] ?? m[3] ?? '') : null
    }
  }
  const endTag = (tag: string) => {
    if (SKIP.has(tag) && skip) skip--
    if (BLOCK.has(tag)) out.push('\n')
    if (tag === 'a' && href && links < 40) {
      let url = ''
      try {
        url = new URL(href, base).href
      } catch {
        url = ''
      }
      if (url.startsWith('http://') || url.startsWith('https://')) {
        out.push(` (${url})`)
        links++
      }
      href = null
    }
  }
  const re = /<!--[\s\S]*?-->|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][^\s>/]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m.index > last && !skip) out.push(unescape(html.slice(last, m.index)))
    last = re.lastIndex
    if (m[2] === undefined) continue // comment / doctype
    const tag = m[2].toLowerCase()
    if (m[1]) endTag(tag)
    else {
      startTag(tag, m[3] ?? '')
      if ((m[3] ?? '').trimEnd().endsWith('/')) endTag(tag) // <br/> counts as start + end, like HTMLParser
      else if (tag === 'script' || tag === 'style') {
        // raw text: nothing inside is markup. Jump to the closing tag.
        const close = new RegExp(`</${tag}\\s*>`, 'i')
        const rest = html.slice(re.lastIndex)
        const c = close.exec(rest)
        re.lastIndex += c ? c.index : rest.length
        last = re.lastIndex
      } else if (VOID.has(tag)) {
        // no end tag follows
      }
    }
  }
  if (last < html.length && !skip) out.push(unescape(html.slice(last)))
  return out.join('')
}

/** Python's str.splitlines(): splits on \n, \r\n, \r, \v, \f, \x1c-\x1e, \x85, \u2028, \u2029; no trailing empty piece. */
export function splitlines(text: string): string[] {
  const parts = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts
}

export function toText(body: string, ctype: string, url: string): string {
  if (ctype === 'text/html' || ctype === 'application/xhtml+xml' || ctype === '') body = htmlText(body, url)
  const lines = splitlines(body).map((ln) => ln.replace(/[ \t\r\f\v]+/g, ' ').trim())
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export const wrap = (url: string, text: string): string => `<${WRAP} url="${url}">\n${text.replaceAll(WRAP, 'untrusted-content')}\n</${WRAP}>`

/** web_fetch tool: the page as text, PAGE_CHARS at a time. */
export async function fetchPage(url: unknown, start: unknown = 0): Promise<string> {
  const { body, final, ctype } = await get(url as string)
  const text = toText(body, ctype, final)
  const s = typeof start === 'number' && Number.isInteger(start) && start >= 0 ? start : 0
  const end = Math.min(text.length, s + PAGE_CHARS)
  const more = end < text.length ? ` More: call web_fetch again with start=${end}.` : ''
  return wrap(final, text ? `[chars ${s}-${end} of ${text.length}.${more}]\n${text.slice(s, end)}` : '[the page has no readable text]')
}

/** web_search tool: top results from the SearxNG instance in SEARCH_URL (an operator-set, trusted address). */
export async function search(query: unknown): Promise<string> {
  const base = process.env.SEARCH_URL ?? ''
  if (!base.startsWith('http://') && !base.startsWith('https://')) throw new ToolError('search_unavailable', 'web search is not set up', 'use web_fetch with a known address instead')
  if (typeof query !== 'string' || !query.trim() || query.length > 300) throw new ToolError('bad_args', 'query must be 1 to 300 characters', '')
  const url = `${base}${base.includes('?') ? '&' : '?'}${new URLSearchParams({ q: query.trim(), format: 'json' }).toString().replaceAll('%20', '+')}`
  let results: Array<{ title?: string; url?: string; content?: string }>
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new Error(`HTTP Error ${r.status}`)
    results = ((await r.json()) as { results: typeof results }).results.slice(0, 5)
  } catch (e) {
    const err = e as { name?: string; message?: string }
    throw new ToolError('search_failed', `${err.name ?? 'Error'}: ${err.message ?? e}`, 'try again or use web_fetch')
  }
  if (!results.length) return wrap('search', '[no results]')
  return wrap('search', results.map((x, i) => `${i + 1}. ${x.title ?? ''}\n${x.url ?? ''}\n${(x.content ?? '').slice(0, 300)}`).join('\n\n'))
}
