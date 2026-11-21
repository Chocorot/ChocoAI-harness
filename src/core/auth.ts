/**
 * Who is calling and what they may do. MODES is the one table that says what each kind of caller may do. Also: per-user
 * storage paths and throttles. Sign-in itself is the Choco SSO (src/lib/session.ts, the OIDC routes); this file only
 * turns an identity into a mode. Port of legacy/auth.py.
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HarnessError } from './errors.ts'

const FILES = ['read_file', 'edit_file', 'write_file']
const SHELL = ['run_bash']
const WEB = ['web_fetch', 'web_search']
const AGENT = ['update_plan', 'delegate']
export const ALL_TOOLS = [...FILES, ...SHELL, ...WEB, ...AGENT]

export type Mode = 'admin' | 'user+shell' | 'user' | 'public'
export interface ModeRow {
  /** What the model may call. */
  tools: string[]
  /** Where the chat lives. */
  store: 'legacy' | 'user' | 'client'
  /** Queue priority (lower runs first). */
  prio: number
}

export const MODES: Record<Mode, ModeRow> = {
  admin: { tools: ALL_TOOLS, store: 'legacy', prio: 0 }, // HARNESS_TOKEN bearer: the script/API caller
  'user+shell': { tools: ALL_TOOLS, store: 'user', prio: 1 },
  user: { tools: [...FILES, ...WEB, ...AGENT], store: 'user', prio: 1 },
  public: { tools: [], store: 'client', prio: 2 },
}

const ADDR = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/

export function normalize(address: unknown): string {
  const a = typeof address === 'string' ? address.trim().toLowerCase() : ''
  if (a.length > 254 || !ADDR.test(a)) throw new HarnessError('bad_request', 'Enter a valid email address.')
  return a
}

export function checkPassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 1 || pw.length > 256 || /[\x00-\x1f]/.test(pw)) throw new HarnessError('bad_request', 'Enter your password.')
  return pw
}

// ---- who may sign in (the `allowed_users` setting, edited in the status dashboard) -------------------------------------------
const ENTRY = /^(@[a-z0-9.-]+\.[a-z]{2,}|[a-z0-9._%+-]{1,64}@[a-z0-9.-]+\.[a-z]{2,})$/

/** One entry per line, comma or space separated, lower-cased. An entry is an address, or `@domain` for every address of a domain. */
export const parseAllowList = (text: unknown): string[] => (typeof text === 'string' ? text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean) : [])

/** Error text for a list that cannot be saved, else null. */
export function allowListError(text: string): string | null {
  const bad = parseAllowList(text).find((e) => !ENTRY.test(e))
  return bad ? `has an entry that is not an email address or @domain: ${bad.slice(0, 40)}` : null
}

/** An empty list means "everyone the SSO lets in"; otherwise only listed addresses (or whole listed domains). */
export function isAllowed(address: string, list: unknown): boolean {
  const l = parseAllowList(list)
  if (!l.length) return true
  const a = address.toLowerCase()
  return l.includes(a) || l.includes(a.slice(a.lastIndexOf('@')))
}

export const isAddress = (a: unknown): a is string => typeof a === 'string' && ADDR.test(a)

/**
 * A signed-in caller's mode from the SSO roles claim for this app: `shell` = user + shell, `user` = user, anything else = no access (null).
 * The shell is not confined (it can read other users' files), so the `shell` role only grants it when the operator set
 * HARNESS_SHELL=unconfined; otherwise a shell user is a plain user and the shell stays admin-only (`/task`).
 */
export function modeForRoles(roles: unknown): Mode | null {
  if (!Array.isArray(roles)) return null
  if (roles.includes('shell') && process.env.HARNESS_SHELL === 'unconfined') return 'user+shell'
  return roles.includes('user') || roles.includes('shell') ? 'user' : null
}

// ---- throttles ---------------------------------------------------------------------------------------------------------
/** Sliding window per key. `allow` records a hit and says whether the caller is still under `limit` per `window` seconds. */
export class Throttle {
  hits = new Map<string, number[]>()

  private recent(key: string, window: number, now: number): number[] {
    const q = (this.hits.get(key) ?? []).filter((t) => t > now - window * 1000)
    this.hits.set(key, q)
    return q
  }

  blocked(key: string, limit: number, window: number, now = Date.now()): boolean {
    return this.recent(key, window, now).length >= limit
  }

  hit(key: string, window = 3600, now = Date.now()): void {
    this.recent(key, window, now).push(now)
    if (this.hits.size > 5000) {
      // forget idle keys so a scan of many IPs can't grow this forever
      for (const [k, q] of this.hits) if (!q.length || q[q.length - 1]! <= now - window * 1000) this.hits.delete(k)
    }
  }

  allow(key: string, limit: number, window: number, now = Date.now()): boolean {
    if (this.blocked(key, limit, window, now)) return false
    this.hit(key, window, now)
    return true
  }
}

// ---- per-user storage ------------------------------------------------------------------------------------------------
export const uid = (address: string): string => createHash('sha256').update(address).digest('hex').slice(0, 32)

/** One SQLite file per user: another user's rows are not even reachable by a buggy query. */
export function dbPath(address: string, env: Record<string, string | undefined> = process.env): string {
  const base = dirname(env.HARNESS_DB ?? 'harness.db') || '.'
  const p = join(base, 'users', uid(address), 'harness.db')
  mkdirSync(dirname(p), { recursive: true })
  return p
}

/** One workspace directory per session: files, uploads, anything the tools touch. */
export function sessionWs(ws: string, address: string, sid: number, create = true): string {
  const p = join(ws, 'users', uid(address), String(sid))
  if (create) mkdirSync(p, { recursive: true })
  return p
}
