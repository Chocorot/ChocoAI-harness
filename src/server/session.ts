/**
 * The signed-in session of the AI app: who (address), what the SSO says they may do (roles), when it ends.
 * A sealed (encrypted) cookie like status and mail use. Not remembered: 12 hours, so a role removed in the SSO
 * stops working within half a day. No password is ever held here (the SSO checked it).
 * It also keeps the SSO's `sid` (the SSO session this sign-in came from) and `sub`, so the SSO can end it at once through
 * back-channel logout (src/server/backchannel.ts), and the ID token, which the SSO needs as `id_token_hint` to sign out for real.
 */
import { CompactEncrypt, compactDecrypt } from 'jose'
import { isAddress } from '../core/auth.ts'

export const SESSION_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-choco-ai' : 'choco-ai'
export const SESSION_SECONDS = 12 * 60 * 60

export interface Session {
  address: string
  roles: string[]
  /** Unix seconds. Checked on every load: a cookie's maxAge is controlled by the client. */
  exp: number
  /** Unix seconds this session started: a logout for a whole user (no sid) only ends sessions that started before it. */
  iat?: number
  /** The SSO session id from the ID token, and the SSO user id. */
  sid?: string
  sub?: string
  /** The ID token, only used as `id_token_hint` when signing out. */
  idToken?: string
}

/** 32 bytes from AUTH_SECRET (64 hex characters, or 32-byte base64). Required in production, no fallback. */
export function sessionKey(env: Record<string, string | undefined> = process.env): Uint8Array {
  const raw = env.AUTH_SECRET?.trim()
  if (!raw) {
    if (env.NODE_ENV === 'production') throw new Error('AUTH_SECRET is required. Generate one with: openssl rand -hex 32')
    return new Uint8Array(32).fill(0x2a) // development only
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return new Uint8Array(Buffer.from(raw, 'hex'))
  const b = Buffer.from(raw, 'base64')
  if (b.length === 32) return new Uint8Array(b)
  throw new Error('AUTH_SECRET must be 32 bytes: 64 hex characters or 32-byte base64 (openssl rand -hex 32)')
}

export async function sealSession(s: Session): Promise<string> {
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(s))).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(sessionKey())
}

export async function unsealSession(token: string | undefined | null, now = Date.now()): Promise<Session | null> {
  if (!token) return null
  try {
    const { plaintext } = await compactDecrypt(token, sessionKey())
    const s = JSON.parse(new TextDecoder().decode(plaintext)) as Session
    if (typeof s.exp !== 'number' || s.exp * 1000 < now || !isAddress(s.address) || !Array.isArray(s.roles)) return null
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined)
    return { address: s.address, roles: s.roles.filter((r) => typeof r === 'string'), exp: s.exp, iat: typeof s.iat === 'number' ? s.iat : undefined, sid: str(s.sid), sub: str(s.sub), idToken: str(s.idToken) }
  } catch {
    return null // wrong key, tampered, garbage: all the same answer
  }
}

export const newSession = (address: string, roles: string[], now = Date.now(), sso: Pick<Session, 'sid' | 'sub' | 'idToken'> = {}): Session => ({ address, roles, exp: Math.floor(now / 1000) + SESSION_SECONDS, iat: Math.floor(now / 1000), ...sso })

/** The value of one cookie from a Cookie header. */
export function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}
