/**
 * The whole HTTP API, called as functions (no Next server needed), against a fake model. A port of the Python API tests:
 * modes and isolation, public chat, failures, queue, chat management, attachments, automations, the manage API.
 */
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as agent from '../core/agent.ts'
import { MODES, dbPath, uid } from '../core/auth.ts'
import * as db from '../core/db.ts'
import { HarnessError, NOTE_PREFIX } from '../core/errors.ts'
import * as model from '../core/model.ts'
import * as settings from '../core/settings.ts'
import { call, FakeModel, freshEnv } from '../core/test-helpers.ts'
import * as api from './api.ts'
import { newSession, sealSession, SESSION_COOKIE } from './session.ts'
import { deps, shared } from './state.ts'

let dir = ''
let fake = new FakeModel()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  dir = freshEnv()
  mkdirSync(join(dir, 'ws'))
  Object.assign(process.env, { HARNESS_WORKSPACE: join(dir, 'ws'), HARNESS_TOKEN: 'tok', HARNESS_SHELL: 'unconfined', AUTH_SECRET: 'ab'.repeat(32), SSO_ISSUER: 'https://sso.test', SSO_CLIENT_ID: 'ai', SSO_CLIENT_SECRET: 's', SSO_REDIRECT_URI: 'https://ai.test/cb' })
  for (const k of ['HARNESS_TRUST_PROXY', 'HARNESS_ADMIN_TOKEN', 'HARNESS_KEEPALIVE', 'HARNESS_TZ']) delete process.env[k]
  ;(globalThis as any).__harness = undefined // a fresh queue, throttles and scheduler per test
  fake = new FakeModel()
  deps.chat = fake.fn
  settings.save({ retries: 0, smart_titles: false })
})

// ---- a tiny client ---------------------------------------------------------------------------------------------------------
const cookieFor = async (address: string, roles: string[] = ['user']) => `${SESSION_COOKIE}=${await sealSession(newSession(address, roles))}`

interface Opts {
  body?: unknown
  cookie?: string | Promise<string>
  headers?: Record<string, string>
  raw?: string
}

async function req(method: string, path: string, o: Opts = {}) {
  const headers: Record<string, string> = { host: 'localhost', ...(o.headers ?? {}) }
  const cookie = await o.cookie
  if (cookie) headers.cookie = cookie
  const init: RequestInit = { method, headers }
  if (o.raw !== undefined) init.body = o.raw
  else if (o.body !== undefined) init.body = JSON.stringify(o.body)
  const r = new Request('http://localhost' + path, init)
  const url = new URL(r.url)
  const p = url.pathname
  let m: RegExpMatchArray | null
  let res: Response | Promise<Response> | null = null
  if (p === '/health') res = api.health()
  else if (p === '/api/me' && method === 'GET') res = api.me(r)
  else if (p === '/api/logout' && method === 'POST') res = api.logout(r)
  else if (p === '/api/chat' && method === 'POST') res = api.chat(r)
  else if (p === '/task' && method === 'POST') res = api.task(r)
  else if (p === '/api/sessions' && method === 'GET') res = api.sessionsList(r)
  else if ((m = p.match(/^\/api\/sessions\/([^/]+)$/))) res = method === 'GET' ? api.sessionGet(r, m[1]!) : method === 'PATCH' ? api.sessionPatch(r, m[1]!) : method === 'DELETE' ? api.sessionDelete(r, m[1]!) : null
  else if ((m = p.match(/^\/api\/sessions\/([^/]+)\/uploads\/([^/]+)$/)) && method === 'GET') res = api.uploadGet(r, m[1]!, decodeURIComponent(m[2]!))
  else if (p === '/api/automations' && (method === 'GET' || method === 'POST')) res = api.automationsApi(r, method)
  else if ((m = p.match(/^\/api\/automations\/([^/]+)$/)) && (method === 'PATCH' || method === 'DELETE')) res = api.automationsApi(r, method, m[1]!)
  else if ((m = p.match(/^\/api\/automations\/([^/]+)\/run$/)) && method === 'POST') res = api.automationsApi(r, 'POST', m[1]!, true)
  else if ((m = p.match(/^\/manage\/(manifest|sessions|errors|settings)$/))) res = api.manage(r, m[1] as 'manifest')
  const response = res ? await res : new Response('{"error":"not found"}', { status: 404 })
  const text = await response.text()
  return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text), events: () => text.split('\n\n').filter((x) => x.startsWith('data:')).map((x) => JSON.parse(x.slice(5))) }
}
const stream = async (path: string, body: unknown, cookie?: string | Promise<string>) => (await req('POST', path, { body, cookie })).events()

const att = (name: string, raw: Buffer | string) => ({ name, data: Buffer.from(raw).toString('base64') })
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('jpeg-bytes-here-123')])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-bytes-here-1234')])
const alice = () => cookieFor('alice@example.com')
const bob = () => cookieFor('bob@example.com')
const root = () => cookieFor('root@example.com', ['shell'])
const boom = (kind: ConstructorParameters<typeof HarnessError>[0] = 'upstream_down'): model.ChatFn => async () => { throw new HarnessError(kind) }

// ---- identity and modes ----------------------------------------------------------------------------------------------------------
test('without HARNESS_SHELL=unconfined the shell role is a plain user: no shell tool', async () => {
  delete process.env.HARNESS_SHELL
  const me = await (await req('GET', '/api/me', { cookie: root() })).json()
  assert.deepEqual([me.mode, me.capabilities.shell], ['user', false])
})

test('/api/me: visitor, user, shell user, admin; a forged or expired cookie is just a visitor; a role the app does not know gets nothing', async () => {
  const me = async (o: Opts = {}) => (await req('GET', '/api/me', o)).json()
  const a = await me({ cookie: alice() })
  assert.deepEqual([a.mode, a.address, a.capabilities.shell, a.capabilities.history], ['user', 'alice@example.com', false, 'user'])
  const v = await me()
  assert.deepEqual([v.mode, v.address, v.capabilities.tools, v.capabilities.login], ['public', null, [], true])
  const r = await me({ cookie: root() })
  assert.deepEqual([r.mode, r.capabilities.shell], ['user+shell', true])
  assert.equal((await me({ headers: { authorization: 'Bearer tok' } })).mode, 'admin')
  assert.equal((await me({ cookie: `${SESSION_COOKIE}=forged.value` })).mode, 'public')
  assert.equal((await me({ cookie: cookieFor('alice@example.com', ['admin', 'viewer']) })).mode, 'public') // SSO said yes, but not for this app
  const old = `${SESSION_COOKIE}=${await sealSession(newSession('alice@example.com', ['user'], Date.now() - 13 * 3600 * 1000))}`
  assert.equal((await me({ cookie: old })).mode, 'public') // past its 12 hours
  assert.equal((await req('GET', '/health')).json().ok, true)
  delete process.env.SSO_ISSUER
  assert.equal((await me()).capabilities.login, false) // no SSO configured: sign-in is off
})

test('logout clears the cookie and refuses a foreign origin', async () => {
  const r = await req('POST', '/api/logout')
  assert.match(r.headers.get('set-cookie')!, /Max-Age=0/)
  assert.equal((await req('POST', '/api/logout', { headers: { origin: 'https://evil.example' } })).status, 403)
})

// ---- public visitors -------------------------------------------------------------------------------------------------------------------
test('public chat: no tools, no storage, a reply cap, extra keys dropped, always streams', async () => {
  const evs = await stream('/api/chat', { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again', evil: 1 }] })
  assert.deepEqual(evs.filter((e) => e.t !== 'status').map((e) => e.t), ['text', 'done'])
  const c = fake.calls[0]!
  assert.deepEqual([c.schemas, c.maxTokens], [[], 1024])
  assert.deepEqual(c.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user'])
  assert.equal(c.messages[0]!.content, settings.get('public_prompt'))
  assert.ok(!('evil' in c.messages[3]!))
  assert.ok(!existsSync(join(dir, 'users'))) // nothing stored server side
  assert.equal(db.stats(db.connect()).sessions, 0)
  const r = await req('POST', '/api/chat', { body: { messages: [{ role: 'user', content: 'hi' }], stream: false } })
  assert.ok(r.text.startsWith('data:')) // public chat always streams
})

test('public chat: validation, trimming, the rate limit and the failure note for the page', async () => {
  const bad = [{}, { messages: [] }, { messages: 'x' }, { messages: [{ role: 'system', content: 'x' }] }, { messages: [{ role: 'user', content: ' ' }] }, { messages: [{ role: 'assistant', content: 'x' }] }, { messages: [{ role: 'user', content: 5 }] }, { messages: ['x'] }]
  for (const body of bad) {
    const r = await req('POST', '/api/chat', { body })
    assert.deepEqual([r.status, r.json().kind], [400, 'bad_request'], JSON.stringify(body))
  }
  settings.save({ public_max_chars: 500 })
  assert.equal((await req('POST', '/api/chat', { body: { messages: [{ role: 'user', content: 'x'.repeat(501) }] } })).status, 400)
  const long = [...Array.from({ length: 9 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'y'.repeat(200) })), { role: 'user', content: 'last' }]
  const evs = await stream('/api/chat', { messages: long })
  assert.equal(evs[0].t, 'trimmed')
  settings.save({ public_rpm: 3 }) // the request above already counted for this IP
  const codes = []
  for (let i = 0; i < 3; i++) codes.push((await req('POST', '/api/chat', { body: { messages: [{ role: 'user', content: 'hi' }] } })).status)
  assert.deepEqual(codes, [200, 200, 429])
  deps.chat = boom('upstream_down')
  settings.save({ public_rpm: 600 })
  const e = (await stream('/api/chat', { messages: [{ role: 'user', content: 'hi' }] })).pop()
  assert.deepEqual([e.t, e.kind, e.retryable], ['error', 'upstream_down', true])
  assert.ok(e.note.startsWith(NOTE_PREFIX))
})

test('a visitor cannot touch user endpoints, /task, or run without a token; /task is 404 with no token set', async () => {
  for (const [m, p] of [['GET', '/api/sessions'], ['GET', '/api/sessions/1'], ['DELETE', '/api/sessions/1']] as const) assert.equal((await req(m, p)).status, 401, p)
  assert.equal((await req('POST', '/task', { body: { goal: 'x' } })).status, 401) // no bearer
  assert.equal((await req('POST', '/task', { body: { goal: 'x' }, cookie: root() })).status, 401) // a cookie is not a bearer
  delete process.env.HARNESS_TOKEN
  assert.equal((await req('POST', '/task', { body: { goal: 'x' } })).status, 404)
})

test('visitors are turned away first when the line is full, so signed-in users still get in', async () => {
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  let started = false
  deps.chat = async () => ((started = true), await gate, [{ role: 'assistant', content: 'x' }, {}])
  const first = stream('/api/chat', { goal: 'a' }, alice())
  while (!started) await sleep(5)
  settings.save({ max_queue_public: 0 })
  const evs = await stream('/api/chat', { messages: [{ role: 'user', content: 'hi' }] })
  assert.deepEqual([evs[evs.length - 1].t, evs[evs.length - 1].kind], ['error', 'busy'])
  open()
  await first
})

// ---- signed-in users and isolation --------------------------------------------------------------------------------------------------
test('a user chat lives in their own DB and workspace, resumes, and hides the system prompt', async () => {
  const evs = await stream('/api/chat', { goal: 'hello' }, alice())
  const sid = evs[0].id
  assert.deepEqual([evs[0].t, evs[evs.length - 1].t], ['session', 'done'])
  assert.deepEqual((fake.calls[0]!.schemas as any[]).map((t) => t.function.name), MODES.user.tools)
  assert.ok(!MODES.user.tools.includes('run_bash') && MODES.user.tools.includes('web_fetch'))
  assert.ok(existsSync(join(dir, 'ws', 'users', uid('alice@example.com'), String(sid))))
  assert.equal(db.stats(db.connect()).sessions, 0) // not in the original DB
  assert.deepEqual((await req('GET', '/api/sessions', { cookie: alice() })).json().sessions.map((s: any) => [s.id, s.goal]), [[sid, 'hello']])
  const msgs = (await req('GET', `/api/sessions/${sid}`, { cookie: alice() })).json().messages
  assert.deepEqual(msgs.map((m: any) => [m.role, m.content]), [['user', 'hello'], ['assistant', 'ok']])
  assert.equal((await stream('/api/chat', { session: sid, goal: 'more' }, alice())).pop().t, 'done')
  assert.equal((await req('GET', `/api/sessions/${sid}`, { cookie: alice() })).json().messages.length, 4)
})

test('users cannot see, touch or resume each other\'s sessions; the same id in two accounts stays separate; delete removes only the owner\'s', async () => {
  const sid = (await stream('/api/chat', { goal: 'alice secret' }, alice()))[0].id
  assert.equal((await req('GET', `/api/sessions/${sid}`, { cookie: bob() })).status, 404) // indistinguishable from "never existed"
  assert.equal((await req('DELETE', `/api/sessions/${sid}`, { cookie: bob() })).status, 404)
  const r = await req('POST', '/api/chat', { body: { session: sid, goal: 'x', stream: false }, cookie: bob() })
  assert.deepEqual([r.status, r.json().kind], [404, 'not_found'])
  assert.deepEqual((await req('GET', '/api/sessions', { cookie: bob() })).json().sessions, [])
  const bsid = (await stream('/api/chat', { goal: 'bob thing' }, bob()))[0].id
  assert.equal(bsid, sid)
  assert.equal((await req('GET', `/api/sessions/${sid}`, { cookie: bob() })).json().messages[0].content, 'bob thing')
  assert.equal((await req('GET', `/api/sessions/${sid}`, { cookie: alice() })).json().messages[0].content, 'alice secret')
  assert.notEqual(dbPath('alice@example.com'), dbPath('bob@example.com'))
  assert.equal(db.load(db.connect(dbPath('bob@example.com')), sid)[1]!.content, 'bob thing')
  assert.equal((await req('DELETE', `/api/sessions/${sid}`, { cookie: bob() })).status, 200)
  assert.ok(!existsSync(join(dir, 'ws', 'users', uid('bob@example.com'), String(sid))))
  assert.ok(existsSync(join(dir, 'ws', 'users', uid('alice@example.com'), String(sid))))
  assert.equal((await req('GET', `/api/sessions/${sid}`, { cookie: alice() })).status, 200)
  assert.equal((await req('GET', '/api/sessions/abc', { cookie: alice() })).status, 404)
})

test('the shell is only for the shell role, enforced even when the model asks for it anyway', async () => {
  fake = new FakeModel(call('run_bash', { command: 'echo hi' }, '1'), 'done')
  deps.chat = fake.fn
  const res = (await stream('/api/chat', { goal: 'run it' }, alice())).find((e) => e.t === 'result')
  assert.deepEqual([res.ok, /error\[forbidden\]/.test(res.d)], [false, true])
  fake = new FakeModel(call('run_bash', { command: 'echo hi' }, '1'), 'done')
  deps.chat = fake.fn
  const res2 = (await stream('/api/chat', { goal: 'run it' }, root())).find((e) => e.t === 'result')
  assert.deepEqual([res2.ok, res2.d.includes('stdout:\nhi')], [true, true])
  assert.ok((fake.calls[0]!.schemas as any[]).some((t) => t.function.name === 'run_bash'))
})

test('/task with the bearer token runs on the original DB; the admin token does not open /task', async () => {
  fake = new FakeModel('legacy ok')
  deps.chat = fake.fn
  const r = await req('POST', '/task', { body: { goal: 'x' }, headers: { authorization: 'Bearer tok' } })
  assert.deepEqual([r.status, r.json().reply], [200, 'legacy ok'])
  assert.equal(db.stats(db.connect()).sessions, 1)
  process.env.HARNESS_ADMIN_TOKEN = 'adm'
  assert.equal((await req('POST', '/task', { body: { goal: 'x' }, headers: { authorization: 'Bearer adm' } })).status, 401)
})

// ---- failures --------------------------------------------------------------------------------------------------------------------------
const task = (body: unknown, raw?: string) => req('POST', '/task', { body, raw, headers: { authorization: 'Bearer tok' } })

test('bad requests get typed 4xx; an unknown session is plain HTTP 404 in both modes', async () => {
  for (const raw of ['{nope', '[1]', '']) {
    const r = await task(undefined, raw)
    assert.deepEqual([r.status, r.json().kind], [400, 'bad_request'], raw)
  }
  assert.equal((await task({ goal: 5 })).status, 400)
  assert.equal((await task({ session: 'x' })).status, 400)
  assert.equal((await task({})).status, 400)
  for (const stream of [false, true]) {
    const r = await task({ session: 999, stream })
    assert.deepEqual([r.status, r.json().kind], [404, 'not_found'])
  }
  assert.equal((await req('GET', '/nope')).status, 404)
})

test('a backend failure is a clear reply with a request id, and is logged for the dashboard', async () => {
  deps.chat = boom('upstream_down')
  process.env.HARNESS_ADMIN_TOKEN = 'adm'
  const r = await task({ goal: 'x' })
  const b = r.json()
  assert.deepEqual([r.status, b.kind, b.retryable, b.rid.length], [502, 'upstream_down', true, 8])
  assert.match(b.error, /can't be reached/)
  const errs = (await req('GET', '/manage/errors', { headers: { authorization: 'Bearer adm' } })).json()
  assert.deepEqual([errs.errors[0].kind, errs.errors[0].rid], ['upstream_down', b.rid])
  assert.equal((await req('GET', '/manage/manifest', { headers: { authorization: 'Bearer adm' } })).json().stats.errors, 1)
})

test('a stream ends with an error event, then retry continues and removes the note', async () => {
  deps.chat = boom('upstream_5xx')
  const evs = (await task({ goal: 'x', stream: true })).events()
  assert.deepEqual(evs.map((e) => e.t), ['session', 'status', 'error'])
  const err = evs[evs.length - 1]
  assert.deepEqual([err.kind, err.retryable, err.d === err.msg], ['upstream_5xx', true, true])
  deps.chat = async () => [{ role: 'assistant', content: 'fine' }, {}]
  const r = await task({ session: evs[0].id, retry: true })
  assert.deepEqual([r.status, r.json().reply], [200, 'fine'])
  const sent: any[] = []
  deps.chat = async (m) => (sent.push(m), [{ role: 'assistant', content: 'ok' }, {}])
  await task({ session: evs[0].id, goal: 'again' })
  assert.ok(!sent[0].some((m: any) => String(m.content ?? '').startsWith(NOTE_PREFIX))) // retry removed the note
})

test('an unexpected exception still gets a reply, never a dropped connection', async () => {
  const spy = console.error
  console.error = () => {}
  try {
    deps.chat = async () => { throw new RangeError('bug') }
    const r = await task({ goal: 'x' })
    assert.deepEqual([r.status, r.json().kind], [500, 'internal'])
  } finally {
    console.error = spy
  }
})

test('a full line answers busy; a waiting request is told its place and pinged; it runs when its turn comes', async () => {
  process.env.HARNESS_KEEPALIVE = '0.05'
  settings.save({ max_queue: 1 })
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  let started = false
  deps.chat = async () => ((started = true), await gate, [{ role: 'assistant', content: 'slow' }, {}])
  const first = task({ goal: 'a' })
  while (!started) await sleep(5)
  const second = task({ goal: 'b', stream: true })
  await sleep(400) // b is now waiting in line and has been pinged
  const third = await task({ goal: 'c' }) // the line is full (limit 1)
  assert.deepEqual([third.status, third.json().kind], [503, 'busy'])
  open()
  await first
  const raw = await second
  const evs = raw.events()
  assert.deepEqual(evs[0], { t: 'queued', pos: 1 })
  assert.deepEqual(evs[evs.length - 1], { t: 'done' })
  assert.ok(raw.text.includes(': ka')) // keepalive comments while waiting
})

test('a run is detached from the connection: it finishes and saves even if nobody reads the stream; /api/sessions/:id says running until then', async () => {
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  let started = false
  deps.chat = async () => ((started = true), await gate, [{ role: 'assistant', content: 'finished' }, {}])
  const res = await api.chat(new Request('http://localhost/api/chat', { method: 'POST', headers: { host: 'localhost', cookie: await alice() }, body: JSON.stringify({ goal: 'long job' }) }))
  await res.body!.cancel() // the browser went away
  while (!started) await sleep(5)
  const sid = (await req('GET', '/api/sessions', { cookie: alice() })).json().sessions[0].id
  const mid = (await req('GET', `/api/sessions/${sid}`, { cookie: alice() })).json()
  assert.deepEqual([mid.running, mid.messages.map((m: any) => m.role)], [true, ['user']]) // saved so far
  open()
  for (let i = 0; i < 100 && (await req('GET', `/api/sessions/${sid}`, { cookie: alice() })).json().running; i++) await sleep(20)
  const end = (await req('GET', `/api/sessions/${sid}`, { cookie: alice() })).json()
  assert.deepEqual([end.running, end.messages[end.messages.length - 1].content], [false, 'finished'])
})

// ---- chat management --------------------------------------------------------------------------------------------------------------------
const listing = async () => (await req('GET', '/api/sessions', { cookie: alice() })).json().sessions
const newChat = async (goal = 'Plan a 3 day trip to Kyoto and check the weather for next week', extra: Record<string, unknown> = {}) => (await stream('/api/chat', { goal, ...extra }, alice()))[0].id
const waitFor = async <T>(f: () => Promise<T | undefined | null | false> | T | undefined | null | false) => {
  for (let i = 0; i < 150; i++) {
    const r = await f()
    if (r) return r
    await sleep(20)
  }
  assert.fail('timed out')
}

test('a new chat gets an instant title; the model writes a better one after the first answer, once', async () => {
  const sid = await newChat()
  const s = (await listing())[0]
  assert.deepEqual([s.id, s.title, s.titleState], [sid, 'Plan a 3 day trip to Kyoto and check the…', 0])
  settings.save({ smart_titles: true })
  fake = new FakeModel('Here is a plan.', 'Kyoto trip plan')
  deps.chat = fake.fn
  const sid2 = await newChat()
  const t = await waitFor(async () => (await listing()).find((x: any) => x.titleState === 1))
  assert.deepEqual([t.id, t.title], [sid2, 'Kyoto trip plan'])
  const ask = fake.calls[1]!
  assert.deepEqual([ask.schemas, ask.maxTokens, ask.effort], [[], 60, 'low'])
  assert.match(ask.messages[1]!.content, /Plan a 3 day trip/)
  await stream('/api/chat', { session: sid2, goal: 'and day two?' }, alice()) // a follow-up never asks for another title
  await sleep(300)
  assert.equal(fake.calls.length, 3)
})

test('a title the user typed survives a slow model title; title failures leave the automatic one', async () => {
  settings.save({ smart_titles: true })
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  deps.chat = async (_m, _e, _s, _t, effort) => (effort === 'low' ? (await gate, [{ role: 'assistant', content: 'Auto title' }, {}]) : [{ role: 'assistant', content: 'answer' }, {}])
  const sid = await newChat()
  const p = await req('PATCH', `/api/sessions/${sid}`, { body: { title: '  My   own name ' }, cookie: alice() })
  assert.equal(p.json().title, 'My own name')
  open()
  await sleep(400)
  assert.deepEqual([(await listing())[0].title, (await listing())[0].titleState], ['My own name', 2])
  for (const reply of [new HarnessError('upstream_down'), '', '   ', '\n']) {
    deps.chat = async (_m, _e, _s, _t, effort) => {
      if (effort === 'low') {
        if (reply instanceof Error) throw reply
        return [{ role: 'assistant', content: reply }, {}]
      }
      return [{ role: 'assistant', content: 'answer' }, {}]
    }
    const evs = await stream('/api/chat', { goal: 'hello there' }, alice())
    assert.equal(evs[evs.length - 1].t, 'done') // the user never sees a title problem
  }
  await sleep(400)
  assert.ok((await listing()).filter((s: any) => s.goal === 'hello there').every((s: any) => s.title === 'hello there' && s.titleState === 0))
})

test('rename: validation, locking, isolation, origin check', async () => {
  const sid = await newChat('hello')
  const patch = (body: unknown, cookie?: Promise<string>, headers?: Record<string, string>) => req('PATCH', `/api/sessions/${sid}`, { body, cookie, headers })
  const ok = await patch({ title: 'Trip notes' }, alice())
  assert.deepEqual([ok.status, ok.json().title, ok.json().titleState], [200, 'Trip notes', 2])
  assert.equal((await req('GET', `/api/sessions/${sid}`, { cookie: alice() })).json().title, 'Trip notes')
  for (const bad of [{}, { title: '' }, { title: '   ' }, { title: 'x'.repeat(81) }, { title: 5 }, { title: null, effort: null }, { effort: 'extreme' }]) assert.equal((await patch(bad, alice())).status, 400, JSON.stringify(bad))
  assert.equal((await patch({ title: 'mine now' }, bob())).status, 404) // somebody else's chat looks like no chat
  assert.equal((await patch({ title: 'x' })).status, 401)
  assert.equal((await patch({ title: 'x' }, alice(), { origin: 'https://evil.example' })).status, 403)
  assert.equal((await req('PATCH', '/api/sessions/999', { body: { title: 'x' }, cookie: alice() })).status, 404)
  assert.equal((await listing())[0].title, 'Trip notes')
})

test('thinking effort: offered from one table, sent as a field and a hint, remembered per chat; visitors too', async () => {
  const e = (await req('GET', '/api/me')).json().capabilities.effort
  assert.deepEqual([e.default, e.levels.map((x: any) => x.id)], ['medium', ['low', 'medium', 'high']])
  const sid = await newChat('think hard', { effort: 'high' })
  assert.equal(fake.calls[0]!.effort, 'high')
  assert.ok(fake.calls[0]!.messages[0]!.content.includes(model.EFFORT.high!.hint))
  assert.equal((await req('GET', `/api/sessions/${sid}`, { cookie: alice() })).json().effort, 'high')
  await stream('/api/chat', { session: sid, goal: 'more' }, alice()) // no level sent: the chat keeps its own
  assert.equal(fake.calls[1]!.effort, 'high')
  await stream('/api/chat', { session: sid, goal: 'quick one', effort: 'low' }, alice()) // changed for this chat
  assert.deepEqual([fake.calls[2]!.effort, fake.calls[2]!.messages[0]!.content.includes(model.EFFORT.high!.hint)], ['low', false])
  const other = await newChat('a different chat') // another chat is not affected
  assert.equal((await req('GET', `/api/sessions/${other}`, { cookie: alice() })).json().effort, 'medium')
  assert.equal((await req('PATCH', `/api/sessions/${other}`, { body: { effort: 'high' }, cookie: alice() })).json().effort, 'high')
  const bad = await req('POST', '/api/chat', { body: { goal: 'x', effort: 'extreme', stream: false }, cookie: alice() })
  assert.deepEqual([bad.status, bad.json().kind], [400, 'bad_request'])
  await stream('/api/chat', { messages: [{ role: 'user', content: 'hi' }], effort: 'low' })
  assert.equal(fake.calls[fake.calls.length - 1]!.effort, 'low')
  assert.equal((await req('POST', '/api/chat', { body: { messages: [{ role: 'user', content: 'hi' }], effort: 'bogus' } })).status, 400)
  assert.equal(agent.systemText(null, 'high'), settings.get('system_prompt') + ' ' + model.EFFORT.high!.hint)
})

// ---- attachments -------------------------------------------------------------------------------------------------------------------------
test('attachment capabilities follow the mode and the vision setting', async () => {
  const caps = async (cookie?: Promise<string>) => (await req('GET', '/api/me', { cookie })).json().capabilities.attachments
  assert.deepEqual(await caps(), { image: false, documents: [] })
  const a = await caps(alice())
  assert.deepEqual([a.image, a.documents.includes('.pdf'), a.documents.includes('.docx'), a.documents.includes('.txt')], [false, true, true, true])
  settings.save({ vision: true })
  assert.equal((await caps(alice())).image, true)
  assert.equal((await caps()).image, false)
})

test('a document reaches the model, is saved in the chat folder, and the title is what was typed', async () => {
  const evs = await stream('/api/chat', { goal: 'summarise this', attachments: [att('notes.txt', 'Remember the milk.')] }, alice())
  const sid = evs[0].id
  assert.equal(fake.calls[0]!.messages[1]!.content, 'summarise this\n\n<attached_file name="notes.txt">\nRemember the milk.\n</attached_file>')
  assert.equal(readFileSync(join(dir, 'ws', 'users', uid('alice@example.com'), String(sid), 'uploads', 'notes.txt'), 'utf8'), 'Remember the milk.')
  assert.equal((await listing())[0].goal, 'summarise this')
  assert.match((await req('GET', `/api/sessions/${sid}`, { cookie: alice() })).json().messages[0].content, /Remember the milk\./)
  const only = await stream('/api/chat', { attachments: [att('n.txt', 'data')] }, alice())
  assert.ok(only.length && fake.calls[fake.calls.length - 1]!.messages[1]!.content.startsWith('Please look at the attached file.'))
})

test('a photo needs vision and is sent only on its own newest turn; the DB keeps a reference, not the bytes', async () => {
  const refused = await req('POST', '/api/chat', { body: { goal: 'what is this?', attachments: [att('p.jpg', JPG)], stream: false }, cookie: alice() })
  assert.deepEqual([refused.status, refused.json().kind], [400, 'bad_request'])
  assert.match(refused.json().error, /photos yet/)
  assert.deepEqual(await listing(), []) // refused before a session exists
  settings.save({ vision: true })
  const sid = (await stream('/api/chat', { goal: 'what is this?', attachments: [att('p.jpg', JPG)] }, alice()))[0].id
  const first = fake.calls[0]!.messages[1]!.content
  assert.deepEqual(first.map((p: any) => p.type), ['text', 'image_url'])
  assert.equal(first[1].image_url.url, 'data:image/jpeg;base64,' + JPG.toString('base64'))
  await stream('/api/chat', { session: sid, goal: 'and the left side?' }, alice())
  assert.equal(fake.calls[1]!.messages[1]!.content[1].type, 'image_url') // a follow-up question still sees the newest photo
  await stream('/api/chat', { session: sid, goal: 'now this one', attachments: [att('q.png', PNG)] }, alice())
  const third = fake.calls[2]!.messages
  assert.deepEqual(third[1]!.content[1], { type: 'text', text: '[an earlier photo is not shown]' })
  assert.equal(third[third.length - 1]!.content[1].image_url.url, 'data:image/png;base64,' + PNG.toString('base64'))
  assert.deepEqual((await req('GET', `/api/sessions/${sid}`, { cookie: alice() })).json().messages[0].content[1], { type: 'image_ref', name: 'uploads/p.jpg' })
})

test('uploads are served only to their owner, never rendered inline, and names cannot escape', async () => {
  settings.save({ vision: true })
  const sid = (await stream('/api/chat', { goal: 'x', attachments: [att('p.jpg', JPG), att('n.txt', 'hello')] }, alice()))[0].id
  const img = await req('GET', `/api/sessions/${sid}/uploads/p.jpg`, { cookie: alice() })
  assert.deepEqual([img.status, img.headers.get('content-type'), img.headers.get('x-content-type-options'), img.headers.get('content-security-policy')!.includes('sandbox')], [200, 'image/jpeg', 'nosniff', true])
  const doc = await req('GET', `/api/sessions/${sid}/uploads/n.txt`, { cookie: alice() })
  assert.deepEqual([doc.text, doc.headers.get('content-type'), doc.headers.get('content-disposition')!.includes('attachment')], ['hello', 'application/octet-stream', true])
  assert.equal((await req('GET', `/api/sessions/${sid}/uploads/p.jpg`, { cookie: bob() })).status, 404)
  await stream('/api/chat', { goal: 'bob' }, bob()) // bob's session 1 exists now, but has no such file
  assert.equal((await req('GET', `/api/sessions/${sid}/uploads/p.jpg`, { cookie: bob() })).status, 404)
  assert.equal((await req('GET', `/api/sessions/${sid}/uploads/p.jpg`)).status, 401)
  for (const bad of ['..%2Fharness.py', '.hidden', 'missing.png', 'a%2Fb']) assert.equal((await req('GET', `/api/sessions/${sid}/uploads/${bad}`, { cookie: alice() })).status, 404, bad)
})

test('visitors and admin cannot attach; sizes and counts are capped', async () => {
  const v = await req('POST', '/api/chat', { body: { messages: [{ role: 'user', content: 'hi' }], attachments: [att('a.txt', 'x')] } })
  assert.equal(v.status, 200) // a visitor's extra field is ignored: public chat reads only `messages`
  assert.equal(fake.calls[fake.calls.length - 1]!.messages.at(-1)!.content, 'hi')
  const a = await task({ goal: 'x', attachments: [att('a.txt', 'x')] })
  assert.deepEqual([a.status, a.json().kind], [400, 'bad_request'])
  assert.equal((await req('POST', '/api/chat', { body: { messages: [{ role: 'user', content: 'x'.repeat(1_100_000) }] } })).status, 400) // visitors keep the 1 MB limit
  const chat = (body: unknown) => req('POST', '/api/chat', { body: { stream: false, ...(body as object) }, cookie: alice() })
  assert.equal((await chat({ goal: 'x', attachments: Array(5).fill(att('a.txt', 'x')) })).status, 400)
  assert.match((await chat({ goal: 'x', attachments: [att('a.exe', 'MZ')] })).json().error, /can't read \.exe/)
})

// ---- automations ---------------------------------------------------------------------------------------------------------------------------
const newAuto = (extra: Record<string, unknown> = {}, cookie: Promise<string> = alice()) => req('POST', '/api/automations', { body: { name: 'News', prompt: 'Find three tech headlines', schedule: { kind: 'interval', every_min: 30 }, ...extra }, cookie })

test('automations: capability follows mode and the limit; create, list, edit, delete; nobody else can touch them', async () => {
  const caps = async (cookie?: Promise<string>) => (await req('GET', '/api/me', { cookie })).json().capabilities.automations
  assert.deepEqual([await caps(), await caps(alice())], [false, true])
  const a = (await newAuto()).json()
  assert.deepEqual([a.name, a.enabled, a.lastRun], ['News', true, null])
  assert.ok(a.nextRun > Date.now() / 1000 + 29 * 60)
  assert.deepEqual((await req('GET', '/api/automations', { cookie: alice() })).json().automations.map((x: any) => x.id), [a.id])
  const b = (await req('PATCH', `/api/automations/${a.id}`, { body: { enabled: false, name: 'Paused' }, cookie: alice() })).json()
  assert.deepEqual([b.enabled, b.name], [false, 'Paused'])
  assert.equal((await req('PATCH', `/api/automations/${a.id}`, { body: { enabled: 'no' }, cookie: alice() })).status, 400)
  assert.equal((await newAuto({ schedule: { kind: 'interval', every_min: 1 } })).status, 400)
  for (const [m, p, body] of [['PATCH', `/api/automations/${a.id}`, { enabled: false }], ['DELETE', `/api/automations/${a.id}`, undefined], ['POST', `/api/automations/${a.id}/run`, {}]] as const) assert.equal((await req(m, p, { body, cookie: bob() })).status, 404, m)
  assert.deepEqual((await req('GET', '/api/automations', { cookie: bob() })).json().automations, [])
  for (const [m, p, body] of [['GET', '/api/automations', undefined], ['POST', '/api/automations', { name: 'x' }], ['DELETE', '/api/automations/1', undefined], ['POST', '/api/automations/1/run', {}]] as const) assert.equal((await req(m, p, { body })).status, 401, m)
  assert.equal((await newAuto({}, alice()).then(() => req('POST', '/api/automations', { body: { name: 'x', prompt: 'y', schedule: { kind: 'interval', every_min: 30 } }, cookie: alice(), headers: { origin: 'https://evil.example' } }))).status, 403)
  assert.equal((await req('DELETE', `/api/automations/${a.id}`, { cookie: alice() })).status, 200)
  assert.equal((await req('DELETE', `/api/automations/${a.id}`, { cookie: alice() })).status, 404)
  assert.equal((await req('PUT', '/api/automations', { body: {}, cookie: alice() })).status, 404)
  settings.save({ max_automations: 0 })
  assert.equal(await caps(alice()), false)
  assert.equal((await newAuto()).status, 400)
})

test('a due job becomes a saved chat without the shell, named after the job; a failure is recorded; run now keeps the schedule', async () => {
  const a = (await req('POST', '/api/automations', { body: { name: 'Daily digest', prompt: 'Make the digest', schedule: { kind: 'daily', at: '07:00' } }, cookie: root() })).json()
  assert.equal(await shared().scheduler.tick(Date.now() / 1000 + 2 * 86400), 1)
  const names = (fake.calls[0]!.schemas as any[]).map((t) => t.function.name)
  assert.ok(['web_fetch', 'web_search', 'update_plan'].every((n) => names.includes(n)))
  assert.ok(!names.includes('run_bash')) // unattended jobs never get the shell
  const sessions = (await req('GET', '/api/sessions', { cookie: root() })).json().sessions
  assert.deepEqual(sessions.map((s: any) => [s.title, s.titleState]), [['⏰ Daily digest', 2]]) // a job's name is never replaced by an automatic title
  const msgs = (await req('GET', `/api/sessions/${sessions[0].id}`, { cookie: root() })).json().messages
  assert.deepEqual(msgs.map((m: any) => [m.role, m.content]), [['user', 'Make the digest'], ['assistant', 'ok']])
  const s = (await req('GET', '/api/automations', { cookie: root() })).json().automations[0]
  assert.deepEqual([s.lastStatus, s.lastSession, s.id], ['ok', sessions[0].id, a.id])

  deps.chat = boom('upstream_down')
  await newAuto()
  await shared().scheduler.tick(Date.now() / 1000 + 3600)
  const failed = (await req('GET', '/api/automations', { cookie: alice() })).json().automations[0]
  assert.match(failed.lastStatus, /^upstream_down:/)
  assert.notEqual(failed.lastSession, null) // the chat exists, with the failure note inside

  deps.chat = fake.fn
  const c = (await newAuto({ name: 'Run now' }, bob())).json()
  assert.equal((await req('POST', `/api/automations/${c.id}/run`, { body: {}, cookie: bob() })).status, 200)
  let st: any
  for (let i = 0; i < 100; i++) {
    st = (await req('GET', '/api/automations', { cookie: bob() })).json().automations[0]
    if (st.lastStatus) break
    await sleep(50)
  }
  assert.deepEqual([st.lastStatus, st.nextRun], ['ok', c.nextRun])
})

// ---- the dashboard's admin API ---------------------------------------------------------------------------------------------------------------
const manage = (path: string, method = 'GET', body?: unknown, token: string | null = 'adm') => req(method, path, { body, headers: token ? { authorization: `Bearer ${token}` } : {} })

test('manage API: off without its token, its own token only, manifest shape, validated all-or-nothing settings, session list', async () => {
  assert.equal((await manage('/manage/manifest')).status, 404) // no admin token configured: the API does not exist
  process.env.HARNESS_ADMIN_TOKEN = 'adm'
  assert.equal((await manage('/manage/manifest', 'GET', undefined, null)).status, 401)
  assert.equal((await manage('/manage/manifest', 'GET', undefined, 'tok')).status, 401) // the /task token does not open /manage
  assert.equal((await manage('/manage/nope')).status, 404)
  const m = (await manage('/manage/manifest')).json()
  assert.deepEqual([m.kind, m.status, m.stats.sessions, m.name], ['choco-harness', 'idle', 0, 'ChocoAI harness'])
  assert.equal(m.backend.model, settings.get('model'))
  const saved = (await manage('/manage/settings', 'PUT', { settings: { max_turns: 7, system_prompt: 'Hi.' } })).json()
  const vals = Object.fromEntries(saved.settings.map((f: any) => [f.key, f.value]))
  assert.deepEqual([vals.max_turns, vals.system_prompt], [7, 'Hi.'])
  const err = await manage('/manage/settings', 'PUT', { settings: { max_turns: 0 } })
  assert.deepEqual([err.status, err.json().error], [400, 'max_turns must be between 1 and 100'])
  assert.equal((await manage('/manage/settings', 'PUT', { settings: { zzz: 1 } })).status, 400)
  assert.equal((await manage('/manage/settings', 'PUT', {})).status, 400)
  assert.equal(settings.get('max_turns'), 7) // the failed saves changed nothing
  const conn = db.connect()
  const sid = db.newSession(conn, 'g'.repeat(500))
  db.logUsage(conn, sid, 0, 100, 20, 90)
  db.logUsage(conn, sid, 1, null, null, 95) // a backend that reported no tokens
  db.logTool(conn, sid, 'run_bash', { command: 'ls' }, 'ok')
  conn.close()
  const d = (await manage('/manage/sessions?limit=5')).json()
  const s = d.sessions[0]
  assert.deepEqual([s.id, s.goal.length, s.turns, s.tokens, s.toolCalls], [sid, 200, 2, 120, 1])
  assert.equal((await manage('/manage/sessions?limit=abc')).status, 400)
  assert.equal((await manage('/manage/manifest')).json().stats.promptTokens, 100)
  assert.equal((await manage('/manage/settings', 'PUT', undefined)).status, 400)
})
