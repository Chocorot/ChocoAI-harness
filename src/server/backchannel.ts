/**
 * Back-channel logout: the SSO tells us a sign-in ended (sign-out in any Choco app, password change, role change, disable).
 * We remember it and refuse that session from the next request on. Contract: ChocoHost-SSO docs/oidc.md ("Back-channel logout").
 *
 * What a logout token must be, all checked here (a forged one would sign users out, so none of this is optional):
 *  signed by the SSO's key (EdDSA, its JWKS), `iss` = the SSO, `aud` = our client id, header `typ: logout+jwt` (so an ID token
 *  can never pass), an `events` claim for back-channel logout, NO `nonce`, a fresh `iat`, a `jti` we have not seen, and a `sid`
 *  or `sub` to end. Anything else is a 400 and changes nothing.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import * as db from '../core/db.ts'
import { SESSION_SECONDS, type Session } from './session.ts'
import { ssoConfig, type SsoConfig } from './sso.ts'

export const BACKCHANNEL_PATH = '/api/auth/sso/backchannel-logout'
const EVENT = 'http://schemas.openid.net/event/backchannel-logout'
const MAX_TOKEN_AGE = 300 // seconds: the SSO sends them at once, so an old one is a replay
const KEEP = SESSION_SECONDS + 3600 // how long a revocation matters: as long as a session this old could still be valid

export class LogoutTokenError extends Error {}

const jwksCache = new Map<string, JWTVerifyGetKey>()
const keysFor = (cfg: SsoConfig): JWTVerifyGetKey => {
  let k = jwksCache.get(cfg.issuer)
  if (!k) jwksCache.set(cfg.issuer, (k = createRemoteJWKSet(new URL(`${cfg.issuer}/jwks.json`))))
  return k
}

export interface Verified {
  sid: string | null
  sub: string | null
  jti: string
}

export async function verifyLogoutToken(cfg: SsoConfig, token: string, deps: { keys?: JWTVerifyGetKey; now?: Date } = {}): Promise<Verified> {
  let payload
  try {
    ;({ payload } = await jwtVerify(token, deps.keys ?? keysFor(cfg), {
      issuer: cfg.issuer,
      audience: cfg.clientId,
      algorithms: ['EdDSA'],
      typ: 'logout+jwt',
      clockTolerance: 30,
      maxTokenAge: MAX_TOKEN_AGE,
      requiredClaims: ['iat', 'jti'],
      currentDate: deps.now,
    }))
  } catch (err) {
    throw new LogoutTokenError(`rejected: ${err instanceof Error ? err.message : 'invalid'}`)
  }
  const events = payload.events as Record<string, unknown> | undefined
  if (!events || typeof events !== 'object' || !(EVENT in events)) throw new LogoutTokenError('no back-channel logout event')
  if ('nonce' in payload) throw new LogoutTokenError('a logout token must not carry a nonce')
  const sid = typeof payload.sid === 'string' && payload.sid ? payload.sid : null
  const sub = typeof payload.sub === 'string' && payload.sub ? payload.sub : null
  if (!sid && !sub) throw new LogoutTokenError('neither sid nor sub')
  return { sid, sub, jti: String(payload.jti) }
}

const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' }
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...noStore } })

/** POST /api/auth/sso/backchannel-logout (form body `logout_token`). Server to server: no cookies, no Origin check. */
export async function backchannelLogout(req: Request, deps: { keys?: JWTVerifyGetKey; now?: Date } = {}): Promise<Response> {
  const cfg = ssoConfig()
  if (!cfg) return reply(404, { error: 'not found' })
  if (req.method !== 'POST') return reply(405, { error: 'method not allowed' })
  let token = ''
  try {
    token = String((await req.formData()).get('logout_token') ?? '')
  } catch {
    return reply(400, { error: 'invalid_request' })
  }
  if (!token || token.length > 8000) return reply(400, { error: 'invalid_request' })
  let v: Verified
  try {
    v = await verifyLogoutToken(cfg, token, deps)
  } catch (err) {
    console.warn('[sso] logout token refused:', err instanceof Error ? err.message : err)
    return reply(400, { error: 'invalid_request' })
  }
  const now = Math.floor((deps.now?.getTime() ?? Date.now()) / 1000)
  const conn = db.connect()
  try {
    if (db.seenLogoutJti(conn, v.jti, now + MAX_TOKEN_AGE + 60)) return reply(400, { error: 'invalid_request' }) // replay
    if (v.sid) db.revoke(conn, `sid:${v.sid}`, now + KEEP, now)
    else db.revoke(conn, `sub:${v.sub}`, now + KEEP, now)
  } finally {
    conn.close()
  }
  return reply(200, {})
}

/** True when the SSO ended this sign-in. Cheap (one indexed read) and runs on every request that has a session. */
export function sessionRevoked(s: Session): boolean {
  if (!s.sid && !s.sub) return false // a session from before back-channel logout existed: nothing to match
  const conn = db.connect()
  try {
    return db.isRevoked(conn, s)
  } finally {
    conn.close()
  }
}
