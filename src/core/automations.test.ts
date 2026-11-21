import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbPath } from './auth.ts'
import * as automations from './automations.ts'
import * as db from './db.ts'
import { HarnessError } from './errors.ts'
import * as settings from './settings.ts'
import { golden } from './test-helpers.ts'

const base = mkdtempSync(join(tmpdir(), 'auto-'))
process.env.HARNESS_DB = join(base, 'harness.db')
process.env.HARNESS_SETTINGS = join(base, 'settings.json')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  writeFileSync(process.env.HARNESS_SETTINGS!, '{}')
  delete process.env.HARNESS_TZ
})

const attempt = (f: () => unknown) => {
  try {
    return { ok: f() }
  } catch (e: any) {
    return { err: { kind: e.kind, message: e.message } }
  }
}

test('schedule validation gives the Python results and messages', () => {
  for (const [s, expected] of golden('schedules').clean) assert.deepEqual(attempt(() => automations.cleanSchedule(s)), expected, JSON.stringify(s))
  assert.throws(() => automations.cleanSchedule({ kind: 'interval', every_min: 5 }), HarnessError)
  settings.save({ min_interval_min: 5 }) // the floor is a live setting
  assert.equal((automations.cleanSchedule({ kind: 'interval', every_min: 5, junk: 1 }) as { every_min: number }).every_min, 5)
})

test('next run equals Python in four zones around daylight saving changes (incl. times that do not exist)', () => {
  for (const c of golden('next_run')) {
    process.env.HARNESS_TZ = c.tz
    assert.equal(automations.nextRun(c.schedule, c.now), c.next, JSON.stringify(c))
  }
})

test('daily runs follow the configured zone; the day of the spring change is 23 hours', () => {
  process.env.HARNESS_TZ = 'America/New_York'
  const at = (y: number, m: number, d: number, h: number) => new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00-0${m === 3 && d >= 8 ? 4 : 5}:00`).getTime() / 1000
  const nxt = automations.nextRun({ kind: 'daily', at: '09:00' }, at(2026, 3, 7, 10))
  assert.equal(nxt, at(2026, 3, 8, 9))
  assert.equal(nxt - at(2026, 3, 7, 9), 23 * 3600)
})

test('CRUD, limits and which updates recompute the next run', () => {
  const conn = db.connect(':memory:')
  const mk = (extra: Record<string, unknown> = {}) => automations.create(conn, 'a@example.com', { name: 'Morning news', prompt: 'Summarise the news', schedule: { kind: 'daily', at: '07:00' }, ...extra }, 1000)
  const a = mk()
  assert.deepEqual([a.name, a.enabled, a.lastStatus, a.schedule], ['Morning news', true, null, { kind: 'daily', at: '07:00' }])
  for (const bad of [{ name: ' ' }, { name: 'x'.repeat(61) }, { prompt: '' }, { prompt: 'x'.repeat(2001) }, { schedule: { kind: 'nope' } }]) assert.throws(() => mk(bad), HarnessError)
  for (let i = 0; i < 4; i++) mk()
  assert.throws(() => mk(), /at most 5/)
  settings.save({ max_automations: 6 })
  mk()
  assert.deepEqual([automations.update(conn, a.id, { name: 'Renamed' }, 5000).nextRun], [a.nextRun])
  const c = automations.update(conn, a.id, { schedule: { kind: 'interval', every_min: 60 } }, 5000)
  assert.equal(c.nextRun, 5000 + 3600)
  const d = automations.update(conn, a.id, { enabled: false }, 9000)
  assert.deepEqual([d.enabled, d.nextRun], [false, c.nextRun])
  assert.equal(automations.update(conn, a.id, { enabled: true }, 9000).nextRun, 9000 + 3600)
  for (const bad of [{}, { enabled: 'yes' }, { name: '' }]) assert.throws(() => automations.update(conn, a.id, bad, 1), HarnessError)
  automations.remove(conn, a.id)
  assert.throws(() => automations.get(conn, a.id), HarnessError)
  assert.throws(() => automations.remove(conn, 999), HarnessError)
})

function setup() {
  process.env.HARNESS_DB = join(mkdtempSync(join(tmpdir(), 'auto-')), 'harness.db') // every test gets its own users directory
  const calls: Array<[string, string, string]> = []
  const sched = new automations.Scheduler(async (owner, name, prompt) => (calls.push([owner, name, prompt]), ['ok', 7]))
  const mk = (owner: string, name = 'J') => automations.create(db.connect(dbPath(owner)), owner, { name, prompt: `do ${name}`, schedule: { kind: 'interval', every_min: 15 } }, 1000)
  const state = (owner: string, aid: number) => automations.get(db.connect(dbPath(owner)), aid)
  return { calls, sched, mk, state }
}

test('due jobs run once and the next run moves first', async () => {
  const { calls, sched, mk, state } = setup()
  const a = mk('a1@example.com')
  assert.equal(await sched.tick(1000 + 899), 0) // not due yet
  assert.equal(await sched.tick(1000 + 900), 1)
  const s = state('a1@example.com', a.id)
  assert.deepEqual([calls, s.lastStatus, s.lastSession, s.nextRun], [[['a1@example.com', 'J', 'do J']], 'ok', 7, 1900 + 900])
  assert.equal(await sched.tick(1900), 0) // the same moment again: already moved on
})

test('missed runs do not pile up and users stay separate', async () => {
  const { calls, sched, mk, state } = setup()
  const a = mk('a2@example.com', 'A')
  mk('b2@example.com', 'B')
  assert.equal(await sched.tick(1000 + 10 * 86400), 2) // the server was off for 10 days: one run each, no backlog
  assert.deepEqual(calls.map((c) => c.slice(0, 2)).sort(), [['a2@example.com', 'A'], ['b2@example.com', 'B']])
  assert.equal(state('a2@example.com', a.id).nextRun, 1000 + 10 * 86400 + 900)
})

test('disabled jobs are skipped and one failure does not stop the others', async () => {
  const { sched, mk, state } = setup()
  const owner = 'a3@example.com'
  const [a, b, c] = [mk(owner, 'off'), mk(owner, 'boom'), mk(owner, 'bug')]
  automations.update(db.connect(dbPath(owner)), a.id, { enabled: false }, 1000)
  const failing = new automations.Scheduler(async (_o, name) => {
    if (name === 'boom') throw new HarnessError('upstream_down')
    if (name === 'bug') throw new RangeError('x')
    return ['ok', 1]
  })
  assert.equal(await failing.tick(5000), 2)
  assert.equal(state(owner, a.id).lastStatus, null)
  assert.ok(state(owner, b.id).lastStatus!.startsWith("upstream_down: The AI model server can't be reached"))
  assert.equal(state(owner, c.id).lastStatus, 'internal: RangeError')
  void sched
})

test('run now keeps the schedule and refuses a second start while running', async () => {
  const { mk, state } = setup()
  const owner = 'a4@example.com'
  const a = mk(owner)
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let started = false
  const slow = new automations.Scheduler(async () => ((started = true), await gate, ['ok', 3]))
  assert.equal(slow.runNow(owner, a.id), true)
  while (!started) await sleep(5)
  assert.equal(slow.runNow(owner, a.id), false) // already running
  release()
  for (let i = 0; i < 100 && !state(owner, a.id).lastStatus; i++) await sleep(20)
  const s = state(owner, a.id)
  assert.deepEqual([s.lastStatus, s.nextRun], ['ok', a.nextRun])
  assert.throws(() => slow.runNow(owner, 999), HarnessError)
})
