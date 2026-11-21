import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
process.env.AUTH_SECRET = 'ab'.repeat(32)
const { authorizeUrl, completeLogin, newFlow, openFlow, roleFromClaims, safeNext, sealFlow, ssoConfig, SsoError } = await import('./sso.ts')
type SsoConfig = Parameters<typeof authorizeUrl>[0]

const cfg: SsoConfig = { issuer: 'https://sso.test', clientId: 'ai', clientSecret: 's3cret', redirectUri: 'https://ai.test/api/auth/sso/callback' }
const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'EdDSA', kid: 'k1' }] })
const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' })

type Over = Partial<{ aud: string; iss: string; nonce: string | undefined; amr: string[]; roles: unknown; email: string; verified: boolean; exp: number; key: CryptoKey }>
async function idToken(nonce: string, o: Over = {}) {
  const now = Math.floor(Date.now() / 1000)
  const j = new SignJWT({ amr: o.amr ?? ['pwd', 'otp'], roles: 'roles' in o ? o.roles : ['user'], email: o.email ?? 'Alice@Chocorot.net', email_verified: o.verified ?? true, name: 'Alice', ...(('nonce' in o ? o.nonce : nonce) !== undefined ? { nonce: 'nonce' in o ? o.nonce : nonce } : {}) })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' }).setIssuer(o.iss ?? cfg.issuer).setAudience(o.aud ?? cfg.clientId).setSubject('user-1').setIssuedAt(now).setExpirationTime(o.exp ?? now + 600)
  return j.sign(o.key ?? privateKey)
}
const fetchReturning = (id_token: string | undefined, status = 200) => (async () => new Response(JSON.stringify(id_token ? { id_token } : {}), { status })) as unknown as typeof fetch
const login = async (o: Over = {}) => { const { flow } = newFlow('/chat'); return completeLogin(cfg, { code: 'c', flow }, { fetch: fetchReturning(await idToken(flow.nonce, o)), keys }) }

test('a good token gives the user with the role from the claim', async () => {
  assert.deepEqual(await login(), { sub: 'user-1', email: 'alice@chocorot.net', name: 'Alice', role: 'user', roles: ['user'] })
  assert.equal((await login({ roles: ['shell'] })).role, 'shell')
  assert.equal((await login({ roles: ['user', 'shell'] })).role, 'shell')
})

test('every kind of bad token is refused', async () => {
  const bad: [string, Over][] = [
    ['wrong audience', { aud: 'mail' }], ['wrong issuer', { iss: 'https://evil.test' }], ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ['signed by another key', { key: other.privateKey }], ['no nonce', { nonce: undefined }], ['wrong nonce', { nonce: 'not-ours' }],
    ['password only (no otp)', { amr: ['pwd'] }], ['email not verified', { verified: false }], ['no roles', { roles: [] }], ['roles missing', { roles: undefined }], ['unknown role only', { roles: ['viewer'] }], ['admin is not an AI role', { roles: ['admin'] }],
  ]
  for (const [why, o] of bad) await assert.rejects(login(o), SsoError, why)
})

test('token endpoint failure or a response without id_token is refused', async () => {
  const { flow } = newFlow('/')
  await assert.rejects(completeLogin(cfg, { code: 'c', flow }, { fetch: fetchReturning(undefined, 400), keys }), SsoError)
  await assert.rejects(completeLogin(cfg, { code: 'c', flow }, { fetch: fetchReturning(undefined, 200), keys }), SsoError)
})

test('the token request carries the client secret, code and PKCE verifier', async () => {
  const { flow } = newFlow('/')
  let seen: { url: string; init: RequestInit } | undefined
  const f = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ id_token: await idToken(flow.nonce) })) }) as unknown as typeof fetch
  await completeLogin(cfg, { code: 'the-code', flow }, { fetch: f, keys })
  assert.equal(seen!.url, 'https://sso.test/token')
  const body = seen!.init.body as URLSearchParams
  assert.deepEqual([body.get('grant_type'), body.get('code'), body.get('code_verifier'), body.get('redirect_uri')], ['authorization_code', 'the-code', flow.verifier, cfg.redirectUri])
  assert.equal((seen!.init.headers as Record<string, string>).authorization, `Basic ${Buffer.from('ai:s3cret').toString('base64')}`)
})

test('authorize URL has PKCE S256, state, nonce and the exact redirect', () => {
  const { flow, challenge } = newFlow('/mail')
  const u = new URL(authorizeUrl(cfg, flow, challenge))
  assert.equal(u.origin + u.pathname, 'https://sso.test/authorize')
  assert.deepEqual([u.searchParams.get('code_challenge_method'), u.searchParams.get('redirect_uri'), u.searchParams.get('state'), u.searchParams.get('nonce'), u.searchParams.get('response_type')], ['S256', cfg.redirectUri, flow.state, flow.nonce, 'code'])
  assert.notEqual(u.searchParams.get('code_challenge'), flow.verifier) // the verifier itself never goes in the URL
})

test('flow cookie round-trips, expires, and a tampered one is refused', async () => {
  const { flow } = newFlow('/chat')
  const t = await sealFlow(flow)
  assert.deepEqual(await openFlow(t), flow)
  assert.equal(await openFlow(t, Date.now() + 11 * 60_000), null)
  assert.equal(await openFlow(t.slice(0, -3) + 'AAA'), null)
  assert.equal(await openFlow(undefined), null)
})

test('safeNext only lets same-origin paths through', () => {
  assert.equal(safeNext('/chat?x=1'), '/chat?x=1')
  for (const bad of ['https://evil.test', '//evil.test', '/\\evil.test', '', null, undefined, '/a\nb']) assert.equal(safeNext(bad), '/')
})

test('roleFromClaims: shell beats user; nothing else grants access', () => {
  assert.deepEqual([roleFromClaims(['user', 'shell']), roleFromClaims(['shell']), roleFromClaims(['user']), roleFromClaims(['admin']), roleFromClaims('shell'), roleFromClaims(undefined)], ['shell', 'shell', 'user', null, null, null])
})

test('ssoConfig needs issuer, client id, secret and an explicit redirect URI; otherwise SSO is off', () => {
  const env = { SSO_ISSUER: 'https://sso.test/', SSO_CLIENT_ID: 'ai', SSO_CLIENT_SECRET: 'x', SSO_REDIRECT_URI: 'https://ai.test/api/auth/sso/callback' }
  assert.deepEqual(ssoConfig(env), { issuer: 'https://sso.test', clientId: 'ai', clientSecret: 'x', redirectUri: 'https://ai.test/api/auth/sso/callback' })
  for (const k of Object.keys(env)) assert.equal(ssoConfig({ ...env, [k]: '' }), null, k)
  assert.equal(ssoConfig({ ...env, NEXT_PUBLIC_APP_URL: 'https://ai.test', SSO_REDIRECT_URI: undefined }), null) // no build-time guessing
})

test('redirects use the public address, never the container bind address (http://0.0.0.0:8080)', async () => {
  const { ssoCallback, ssoStart } = await import('./auth-routes.ts')
  const was = { url: process.env.HARNESS_PUBLIC_URL, proxy: process.env.HARNESS_TRUST_PROXY }
  try {
    for (const k of ['SSO_ISSUER', 'SSO_CLIENT_ID', 'SSO_CLIENT_SECRET', 'SSO_REDIRECT_URI']) delete process.env[k] // sign-in off: start goes home
    process.env.HARNESS_PUBLIC_URL = 'https://ai.test'
    assert.equal((await ssoStart(new Request('http://0.0.0.0:8080/api/auth/sso/start'))).headers.get('location'), 'https://ai.test/')
    // a callback with no flow cookie is refused, and the browser is sent to the public site, not the bind address
    assert.equal((await ssoCallback(new Request('http://0.0.0.0:8080/api/auth/sso/callback?code=c&state=s'))).headers.get('location'), 'https://ai.test/?signin=error')
    // without HARNESS_PUBLIC_URL the Host header the browser used is the address (https only behind a trusted proxy)
    delete process.env.HARNESS_PUBLIC_URL
    process.env.HARNESS_TRUST_PROXY = '1'
    const r = await ssoCallback(new Request('http://0.0.0.0:8080/api/auth/sso/callback?code=c&state=s', { headers: { host: 'ai.chocorot.net', 'x-forwarded-proto': 'https' } }))
    assert.equal(r.headers.get('location'), 'https://ai.chocorot.net/?signin=error')
  } finally {
    for (const [k, v] of [['HARNESS_PUBLIC_URL', was.url], ['HARNESS_TRUST_PROXY', was.proxy]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
})
