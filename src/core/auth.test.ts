import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_TOOLS, checkPassword, dbPath, MODES, modeForRoles, normalize, sessionWs, Throttle, uid } from './auth.ts'
import { golden } from './test-helpers.ts'

const g = golden('auth')

test('address normalisation and password checks give the Python answers', () => {
  const run = (f: () => unknown) => {
    try {
      return { ok: f() }
    } catch (e: any) {
      return { err: { kind: e.kind, message: e.message } }
    }
  }
  for (const [a, expected] of g.normalize) assert.deepEqual(run(() => normalize(a)), expected, String(a))
  for (const [p, expected] of g.password) assert.deepEqual(run(() => checkPassword(p)), expected, String(p))
})

test('the per-user id is the same sha256 prefix as Python, so existing chats are found', () => {
  for (const [a, id] of g.uid) assert.equal(uid(a), id)
})

test('mode table: admin all, shell all, user no shell, public none; priorities admin < users < public', () => {
  const g2 = golden('effort_and_prompts')
  assert.deepEqual(JSON.parse(JSON.stringify(MODES)), { ...g2.modes, ...{} })
  assert.ok(!MODES.user.tools.includes('run_bash'))
  assert.ok(MODES['user+shell'].tools.includes('run_bash'))
  assert.deepEqual(MODES.public.tools, [])
  assert.equal(ALL_TOOLS.length, 8)
})

test('SSO roles become modes: shell beats user only when HARNESS_SHELL=unconfined, no matching role = no access', () => {
  const was = process.env.HARNESS_SHELL
  try {
    delete process.env.HARNESS_SHELL
    assert.equal(modeForRoles(['shell']), 'user') // no opt-in: the shell role is just a user
    assert.equal(modeForRoles(['user', 'shell']), 'user')
    process.env.HARNESS_SHELL = 'unconfined'
    assert.deepEqual([modeForRoles(['user']), modeForRoles(['shell']), modeForRoles(['user', 'shell']), modeForRoles(['admin']), modeForRoles([]), modeForRoles('user'), modeForRoles(undefined)], ['user', 'user+shell', 'user+shell', null, null, null, null])
  } finally {
    if (was === undefined) delete process.env.HARNESS_SHELL
    else process.env.HARNESS_SHELL = was
  }
})

test('storage paths come only from the identity and an integer id, one directory per user and session', () => {
  const base = mkdtempSync(join(tmpdir(), 'auth-'))
  const env = { HARNESS_DB: join(base, 'harness.db') }
  const p = dbPath('alice@chocorot.net', env)
  assert.equal(p, join(base, 'users', uid('alice@chocorot.net'), 'harness.db'))
  assert.ok(existsSync(join(base, 'users', uid('alice@chocorot.net'))))
  const ws = sessionWs(base, 'alice@chocorot.net', 3)
  assert.equal(ws, join(base, 'users', uid('alice@chocorot.net'), '3'))
  assert.ok(existsSync(ws))
  assert.ok(!existsSync(sessionWs(base, 'bob@chocorot.net', 9, false)))
})

test('throttle: sliding window, blocked until old hits expire, idle keys are forgotten', () => {
  const t = new Throttle()
  const now = 1_000_000
  for (let i = 0; i < 3; i++) assert.equal(t.allow('ip', 3, 60, now + i), true)
  assert.equal(t.allow('ip', 3, 60, now + 10), false)
  assert.equal(t.blocked('ip', 3, 60, now + 10), true)
  assert.equal(t.allow('ip', 3, 60, now + 61_000), true) // the old hits left the window
  assert.equal(t.allow('other', 3, 60, now), true) // another key is independent
})
