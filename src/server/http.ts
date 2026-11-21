/** The request/response plumbing every route uses: who is calling, typed errors, JSON replies, origin check, body limits. */
import { timingSafeEqual } from 'node:crypto'
import { isAllowed, MODES, modeForRoles, type Mode } from '../core/auth.ts'
import * as db from '../core/db.ts'
import * as errors from '../core/errors.ts'
import * as settings from '../core/settings.ts'
import { ClientGone } from './sse.ts'
import { cookieValue, SESSION_COOKIE, unsealSession } from './session.ts'

export const MAX_BODY = 1_000_000 // bytes accepted on a request
export const ATTACH_BODY = 9_000_000 // signed-in chat requests may carry attachments (base64: up to ~6 MB of files)

const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' }

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...SECURITY, 'Cache-Control': 'no-store', ...headers } })
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Bearer check for an env-configured token. */
export const bearerOk = (req: Request, token: string | undefined): boolean => Boolean(token) && safeEqual(req.headers.get('authorization') ?? '', `Bearer ${token}`)

export interface Who {
  mode: Mode
  address: string | null
}

/** (mode, address). Bearer HARNESS_TOKEN = admin; a valid sign-in cookie with an AI role = user; anything else = public. */
export async function who(req: Request): Promise<Who> {
  if (bearerOk(req, process.env.HARNESS_TOKEN)) return { mode: 'admin', address: null }
  const s = await unsealSession(cookieValue(req.headers.get('cookie'), SESSION_COOKIE))
  const mode = s ? modeForRoles(s.roles) : null
  // the list is read on every request, so removing someone in the dashboard shuts them out at once, not when their cookie expires
  return s && mode && isAllowed(s.address, settings.get('allowed_users')) ? { mode, address: s.address } : { mode: 'public', address: null }
}

export async function needUser(req: Request): Promise<string> {
  const w = await who(req)
  if (!w.address) throw new errors.HarnessError('auth', 'Sign in to use saved chats.')
  return w.address
}

/** Cookie requests must come from our own page (on top of SameSite=Lax). */
export function sameOrigin(req: Request): void {
  const origin = req.headers.get('origin')
  if (origin) {
    let host = ''
    try {
      host = new URL(origin).host
    } catch {
      host = ''
    }
    if (host !== req.headers.get('host')) throw new errors.HarnessError('forbidden')
  }
}

/** Client IP: the socket address cannot be read from a route handler, so we trust the proxy headers ONLY when HARNESS_TRUST_PROXY=1
 * (the compose file publishes on 127.0.0.1, every request comes through our own tunnel). Otherwise all callers share one key. */
export function clientIp(req: Request): string {
  if (process.env.HARNESS_TRUST_PROXY === '1') {
    const fwd = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    if (fwd) return fwd
  }
  return 'unknown'
}

/** This site's own address for canonical and social-preview URLs. HARNESS_PUBLIC_URL wins; otherwise it is built from the Host
 * header. A Host that is not plainly a host name gives "" (relative URLs) instead of putting attacker-chosen text into the page. */
export function siteUrl(req: Request): string {
  const env = (process.env.HARNESS_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
  if (env) return env
  const host = req.headers.get('host') ?? ''
  if (!/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(host)) return ''
  const fwd = process.env.HARNESS_TRUST_PROXY === '1' ? (req.headers.get('x-forwarded-proto') ?? '').split(',')[0]!.trim() : ''
  return `${fwd === 'https' ? 'https' : 'http'}://${host}`
}

/** A JSON object body of at most `limit` bytes (a larger one is refused without reading all of it). */
export async function readJson(req: Request, limit = MAX_BODY): Promise<Record<string, any>> {
  const bad = (m: string) => new errors.HarnessError('bad_request', m)
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) throw bad('Request body is missing or too large.')
  const reader = req.body?.getReader()
  if (!reader) throw bad('Request body is missing or too large.')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel()
      throw bad('Request body is missing or too large.')
    }
    chunks.push(value)
  }
  if (!size) throw bad('Request body is missing or too large.')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw bad('Request body must be JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('Request body must be a JSON object.')
  return parsed as Record<string, any>
}

const CLIENT_MISTAKES = new Set(['auth', 'not_found', 'bad_request', 'busy', 'forbidden', 'rate_limited'])

/** Server errors go to stderr as one JSON line and into the (legacy) errors table; client mistakes do not. */
export function logError(rid: string, sid: number | null, err: errors.HarnessError): void {
  if (CLIENT_MISTAKES.has(err.kind)) return
  console.error(JSON.stringify({ ts: Math.round(Date.now()) / 1000, rid, session: sid, kind: err.kind, code: err.code, msg: err.message, detail: err.detail.slice(0, 300) }))
  try {
    const conn = db.connect()
    try {
      db.logError(conn, rid, sid, err)
    } finally {
      conn.close()
    }
  } catch {
    // logging must never hide the real reply
  }
}

/** Run a handler. Whatever fails becomes a typed error reply: the socket is never closed silently. */
export async function guarded(fn: (rid: string) => Promise<Response>): Promise<Response> {
  const rid = crypto.randomUUID().replaceAll('-', '').slice(0, 8)
  try {
    return await fn(rid)
  } catch (e) {
    if (e instanceof ClientGone) return new Response(null, { status: 499 })
    const err = errors.classify(e)
    if (err.kind === 'internal') console.error(e)
    logError(rid, null, err)
    return json(err.body(rid), err.status)
  }
}

export const modeRow = (mode: Mode) => MODES[mode]
