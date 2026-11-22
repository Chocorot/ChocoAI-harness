/**
 * Sign-in through the Choco SSO (OpenID Connect, authorization code + PKCE). Same flow as status and mail.
 * The SSO's side: repo ChocoHost-SSO, docs/oidc.md. Our side of the contract:
 *
 *  - the SSO has already checked the password and that this user has a role for the `ai` client; we still verify the ID token
 *    (signature, issuer, audience, expiry, nonce) and that the password step ran (`amr` has `pwd`). The authenticator code is only asked
 *    for the `shell` role: a `shell` role in a token whose `amr` has no `otp` is treated as a plain `user` (never as a shell);
 *  - the SSO's `roles` claim for the `ai` client decides access: `user` = chat + tools without the shell, `shell` = the same plus the
 *    shell tool; no such role = no access, whatever else the token says;
 *  - `state` + PKCE + nonce tie the callback to the browser that started it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { CompactEncrypt, compactDecrypt, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { sessionKey } from './session.ts'

export const START_PATH = '/api/auth/sso/start'
export const CALLBACK_PATH = '/api/auth/sso/callback'
export const FLOW_COOKIE = 'choco_ai_sso_flow'
export const FLOW_SECONDS = 600

export interface SsoConfig {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
}

/** null = SSO not configured: the app falls back to its own login (as before). */
export function ssoConfig(env: Record<string, string | undefined> = process.env): SsoConfig | null {
  const issuer = env.SSO_ISSUER?.trim().replace(/\/+$/, '')
  const clientId = env.SSO_CLIENT_ID?.trim()
  const clientSecret = env.SSO_CLIENT_SECRET?.trim()
  // Explicit on purpose: a NEXT_PUBLIC_* value is baked in at build time, and this app is built once and run elsewhere.
  const redirectUri = env.SSO_REDIRECT_URI?.trim() ?? ''
  if (!issuer || !clientId || !clientSecret || !redirectUri) return null
  return { issuer, clientId, clientSecret, redirectUri }
}

/** Only same-origin paths (an open redirect after login is a phishing primitive). */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '/'
  return raw
}

export interface Flow {
  state: string
  nonce: string
  verifier: string
  next: string
}

export const newFlow = (next: string): { flow: Flow; challenge: string } => {
  const verifier = randomBytes(32).toString('base64url')
  return {
    flow: { state: randomBytes(16).toString('base64url'), nonce: randomBytes(16).toString('base64url'), verifier, next: safeNext(next) },
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  }
}

export function authorizeUrl(cfg: SsoConfig, flow: Flow, challenge: string): string {
  const u = new URL(`${cfg.issuer}/authorize`)
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: 'openid email profile',
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()
  return u.toString()
}

/** The flow secrets travel in an encrypted, short-lived cookie (same key as the session). */
export async function sealFlow(flow: Flow, now = Date.now()): Promise<string> {
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify({ ...flow, exp: now + FLOW_SECONDS * 1000 })))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .encrypt(sessionKey())
}

export async function openFlow(token: string | undefined, now = Date.now()): Promise<Flow | null> {
  if (!token) return null
  try {
    const { plaintext } = await compactDecrypt(token, sessionKey())
    const f = JSON.parse(new TextDecoder().decode(plaintext)) as Flow & { exp: number }
    if (typeof f.exp !== 'number' || f.exp < now || !f.state || !f.nonce || !f.verifier) return null
    return { state: f.state, nonce: f.nonce, verifier: f.verifier, next: safeNext(f.next) }
  } catch {
    return null
  }
}

export const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export type AiRole = 'shell' | 'user'

/** shell beats user; anything else (or nothing) = no access. */
export function roleFromClaims(roles: unknown): AiRole | null {
  if (!Array.isArray(roles)) return null
  if (roles.includes('shell')) return 'shell'
  return roles.includes('user') ? 'user' : null
}

export interface SsoUser {
  sub: string
  email: string
  name: string | null
  role: AiRole
  roles: string[]
  /** The SSO session this sign-in belongs to (null from an SSO that does not send it) and the raw ID token (for sign-out). */
  sid: string | null
  idToken: string
}

export class SsoError extends Error {}

/**
 * Trade the code for tokens (server to server, with the client secret and the
 * PKCE verifier) and verify the ID token. Throws SsoError for anything wrong;
 * callers show one generic message and log the reason.
 */
export async function completeLogin(
  cfg: SsoConfig,
  args: { code: string; flow: Flow },
  deps: { fetch?: typeof fetch; keys?: JWTVerifyGetKey } = {},
): Promise<SsoUser> {
  const doFetch = deps.fetch ?? fetch
  const keys = deps.keys ?? createRemoteJWKSet(new URL(`${cfg.issuer}/jwks.json`))
  const basic = Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64')
  const res = await doFetch(`${cfg.issuer}/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: args.code, redirect_uri: cfg.redirectUri, code_verifier: args.flow.verifier }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new SsoError(`token endpoint answered ${res.status}`)
  const body = (await res.json()) as { id_token?: unknown }
  if (typeof body.id_token !== 'string') throw new SsoError('no id_token in the response')

  let payload
  try {
    ;({ payload } = await jwtVerify(body.id_token, keys, { issuer: cfg.issuer, audience: cfg.clientId, algorithms: ['EdDSA'], clockTolerance: 30 }))
  } catch (err) {
    throw new SsoError(`id_token rejected: ${err instanceof Error ? err.message : 'invalid'}`)
  }
  if (typeof payload.nonce !== 'string' || !sameSecret(payload.nonce, args.flow.nonce)) throw new SsoError('nonce mismatch')
  const amr = Array.isArray(payload.amr) ? payload.amr : []
  if (!amr.includes('pwd')) throw new SsoError('the password sign-in step is required')
  if (typeof payload.email !== 'string' || payload.email_verified !== true || typeof payload.sub !== 'string') throw new SsoError('token has no verified email')
  // The shell is the one dangerous role: without the authenticator code behind this sign-in it is only a plain `user` (the SSO normally asks for the code first).
  const claimed = (Array.isArray(payload.roles) ? payload.roles : []).filter((r): r is string => typeof r === 'string')
  const downgraded = claimed.includes('shell') && !amr.includes('otp')
  if (downgraded) console.warn('[sso] shell role dropped: this sign-in had no authenticator code')
  const roles = downgraded ? claimed.map((r) => (r === 'shell' ? 'user' : r)) : claimed
  const role = roleFromClaims(roles)
  if (!role) throw new SsoError('account has no AI role')
  return { sub: payload.sub, email: payload.email.toLowerCase().trim(), name: typeof payload.name === 'string' ? payload.name : null, role, roles, sid: typeof payload.sid === 'string' ? payload.sid : null, idToken: body.id_token }
}
