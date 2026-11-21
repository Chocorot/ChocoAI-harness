/** Back-channel logout: what a logout token must be, and that a revoked sign-in stops working on the next request. */
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { freshEnv } from '../core/test-helpers.ts'
import * as api from './api.ts'
import { backchannelLogout, sessionRevoked } from './backchannel.ts'
import { newSession, sealSession, SESSION_COOKIE } from './session.ts'
import { completeLogin, newFlow } from './sso.ts'

const ISS = 'https://sso.test'
const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'EdDSA', kid: 'k1' }] })
const stranger = await generateKeyPair('EdDSA', { crv: 'Ed25519' })

beforeEach(() => {
  freshEnv()
  Object.assign(process.env, { AUTH_SECRET: 'ab'.repeat(32), SSO_ISSUER: ISS, SSO_CLIENT_ID: 'ai', SSO_CLIENT_SECRET: 's', SSO_REDIRECT_URI: 'https://ai.test/api/auth/sso/callback', HARNESS_PUBLIC_URL: 'https://ai.test' })
  delete process.env.HARNESS_TOKEN
  ;(globalThis as any).__harness = undefined
})

type Over = Partial<{ typ: string; aud: string; iss: string; sid: string | null; sub: string | null; events: unknown; nonce: string; iat: number; jti: string | null; key: CryptoKey }>
async function logoutToken(o: Over = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: Record<string, unknown> = { events: 'events' in o ? o.events : { 'http://schemas.openid.net/event/backchannel-logout': {} } }
  if (o.sid !== null) claims.sid = o.sid ?? 'sid-1'
  if (o.nonce) claims.nonce = o.nonce
  const j = new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', kid: 'k1', typ: o.typ ?? 'logout+jwt' }).setIssuer(o.iss ?? ISS).setAudience(o.aud ?? 'ai').setIssuedAt(o.iat ?? now).setExpirationTime(now + 120)
  if (o.sub !== null) j.setSubject(o.sub ?? 'user-1')
  if (o.jti !== null) j.setJti(o.jti ?? crypto.randomUUID())
  return j.sign(o.key ?? privateKey)
}
const post = (token: string | null, method = 'POST') =>
  backchannelLogout(new Request('https://ai.test/api/auth/sso/backchannel-logout', { method, ...(method === 'POST' ? { body: new URLSearchParams(token === null ? {} : { logout_token: token }), headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}) }), { keys })

const cookieFor = async (s: ReturnType<typeof newSession>) => `${SESSION_COOKIE}=${await sealSession(s)}`
const me = async (cookie: string) => (await (await api.me(new Request('https://ai.test/api/me', { headers: { cookie } }))).json()).mode

test('a valid logout token ends exactly that sign-in, on the very next request; others are untouched', async () => {
  const mine = await cookieFor(newSession('alice@example.com', ['user'], Date.now(), { sid: 'sid-1', sub: 'user-1' }))
  const other = await cookieFor(newSession('alice@example.com', ['user'], Date.now(), { sid: 'sid-2', sub: 'user-1' }))
  assert.equal(await me(mine), 'user')
  const r = await post(await logoutToken())
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal(await me(mine), 'public') // signed out
  assert.equal(await me(other), 'user') // another sign-in of the same person is not touched
})

test('every kind of bad logout token is refused and changes nothing', async () => {
  const mine = await cookieFor(newSession('alice@example.com', ['user'], Date.now(), { sid: 'sid-1', sub: 'user-1' }))
  const old = Math.floor(Date.now() / 1000) - 3600
  const bad: [string, Over][] = [
    ['signed by another key', { key: stranger.privateKey }],
    ['wrong audience (meant for mail)', { aud: 'mail' }],
    ['wrong issuer', { iss: 'https://evil.test' }],
    ['typ JWT: an ID token shape, not a logout token', { typ: 'JWT' }],
    ['no events claim', { events: undefined }],
    ['wrong event', { events: { 'http://example.test/other': {} } }],
    ['carries a nonce', { nonce: 'n' }],
    ['issued an hour ago (replay of an old capture)', { iat: old }],
    ['no jti', { jti: null }],
    ['neither sid nor sub', { sid: null, sub: null }],
  ]
  for (const [why, o] of bad) {
    assert.equal((await post(await logoutToken(o))).status, 400, why)
    assert.equal(await me(mine), 'user', `${why}: the session must survive`)
  }
  assert.equal((await post('not.a.jwt')).status, 400)
  assert.equal((await post(null)).status, 400)
})

test('the same logout token twice: the second is refused (replay)', async () => {
  const t = await logoutToken({ jti: 'once' })
  assert.equal((await post(t)).status, 200)
  assert.equal((await post(t)).status, 400)
})

test('a token without sid ends every sign-in of that user that started before it, not later ones', async () => {
  const early = newSession('alice@example.com', ['user'], Date.now() - 60_000, { sub: 'user-9' })
  const late = newSession('alice@example.com', ['user'], Date.now() + 60_000, { sub: 'user-9' })
  assert.equal((await post(await logoutToken({ sid: null, sub: 'user-9' }))).status, 200)
  assert.equal(sessionRevoked(early), true)
  assert.equal(sessionRevoked(late), false)
  assert.equal(sessionRevoked(newSession('bob@example.com', ['user'], Date.now() - 60_000, { sub: 'user-8' })), false)
})

test('a session from before back-channel logout (no sid, no sub) is never matched; GET is refused; SSO off = 404', async () => {
  assert.equal(sessionRevoked(newSession('alice@example.com', ['user'])), false)
  assert.equal((await post(null, 'GET')).status, 405)
  delete process.env.SSO_ISSUER
  assert.equal((await post(await logoutToken())).status, 404)
})

test('the callback keeps sid, sub and the ID token in the session; sign-out hands back the SSO logout address', async () => {
  const { flow } = newFlow('/')
  const now = Math.floor(Date.now() / 1000)
  const idToken = await new SignJWT({ amr: ['pwd', 'otp'], roles: ['user'], email: 'alice@example.com', email_verified: true, nonce: flow.nonce, sid: 'sid-7' })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' }).setIssuer(ISS).setAudience('ai').setSubject('user-7').setIssuedAt(now).setExpirationTime(now + 600).sign(privateKey)
  const cfg = { issuer: ISS, clientId: 'ai', clientSecret: 's', redirectUri: 'https://ai.test/api/auth/sso/callback' }
  const user = await completeLogin(cfg, { code: 'c', flow }, { fetch: (async () => new Response(JSON.stringify({ id_token: idToken }))) as unknown as typeof fetch, keys })
  assert.deepEqual([user.sid, user.sub, user.idToken], ['sid-7', 'user-7', idToken])
  const cookie = await cookieFor(newSession(user.email, user.roles, Date.now(), { sid: user.sid ?? undefined, sub: user.sub, idToken: user.idToken }))
  const res = await api.logout(new Request('https://ai.test/api/logout', { method: 'POST', headers: { cookie, origin: 'https://ai.test', host: 'ai.test' } }))
  const { next } = await res.json()
  const u = new URL(next)
  assert.deepEqual([u.origin + u.pathname, u.searchParams.get('id_token_hint'), u.searchParams.get('post_logout_redirect_uri')], [`${ISS}/logout`, idToken, 'https://ai.test/'])
  assert.match(res.headers.get('set-cookie') ?? '', /Max-Age=0/)
  // an old session without an ID token just signs out here
  const none = await api.logout(new Request('https://ai.test/api/logout', { method: 'POST', headers: { cookie: await cookieFor(newSession('a@example.com', ['user'])), origin: 'https://ai.test', host: 'ai.test' } }))
  assert.equal((await none.json()).next, null)
})
