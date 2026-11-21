import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HarnessError } from './errors.ts'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as db from './db.ts'

test('sessions, messages, titles and effort behave like the Python db layer', () => {
  const c = db.connect(':memory:')
  const sid = db.newSession(c, 'goal text', 'First title', 0, 'medium')
  assert.deepEqual(db.getSession(c, sid), { title: 'First title', titleState: 0, effort: 'medium' })
  db.saveMsg(c, sid, { role: 'user', content: 'hi' })
  db.saveMsg(c, sid, { role: 'assistant', content: 'yo' })
  assert.deepEqual(db.load(c, sid).map((m) => m.content), ['hi', 'yo'])
  db.dropLast(c, sid)
  assert.equal(db.load(c, sid).length, 1)
  assert.equal(db.rename(c, sid, 'Model title', 1), true) // 0 -> 1 lands
  assert.equal(db.rename(c, sid, 'Another model title', 1), false) // only once
  assert.equal(db.rename(c, sid, 'Mine', 2), true) // the user can always rename
  assert.equal(db.rename(c, sid, 'Late model title', 1), false) // and a user name is never overwritten
  assert.equal(db.getSession(c, sid)!.title, 'Mine')
  db.setEffort(c, sid, 'high')
  assert.equal(db.getSession(c, sid)!.effort, 'high')
  assert.equal(db.sessionExists(c, sid), true)
  assert.equal(db.sessionExists(c, 999), false)
  assert.equal(db.getSession(c, 999), null)
})

test('usage, tool audit, stats and the session list', () => {
  const c = db.connect(':memory:')
  const sid = db.newSession(c, 'g', null, 0, null)
  db.logUsage(c, sid, 0, 10, 5, 12)
  db.logUsage(c, sid, 1, null, null, 7)
  db.logTool(c, sid, 'read_file', { path: 'a' }, 'x'.repeat(800))
  assert.deepEqual(db.stats(c), { sessions: 1, turns: 2, promptTokens: 10, completionTokens: 5, toolCalls: 1, errors: 0 })
  const [s] = db.listSessions(c)
  assert.deepEqual([s!.id, s!.title, s!.turns, s!.tokens, s!.toolCalls], [sid, 'g', 2, 15, 1])
  assert.equal((c.prepare('SELECT length(result) n FROM audit').get() as { n: number }).n, 500) // results are cut like in Python
  db.deleteSession(c, sid)
  assert.deepEqual(db.stats(c), { sessions: 0, turns: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0, errors: 0 })
})

test('the errors table is a ring of the newest 200', () => {
  const c = db.connect(':memory:')
  for (let i = 0; i < 230; i++) db.logError(c, `r${i}`, null, new HarnessError('internal', 'm', { detail: 'd' }))
  const rows = db.listErrors(c, 500) as Array<{ rid: string }>
  assert.equal(rows.length, 200)
  assert.equal(rows[0]!.rid, 'r229')
})

test('an older database file gets the missing session columns added once, keeping its rows', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'db-')), 'old.db')
  const old = new Database(path)
  old.exec("CREATE TABLE sessions(id INTEGER PRIMARY KEY, goal TEXT, created REAL); INSERT INTO sessions(goal, created) VALUES('old chat', 1)")
  old.close()
  const cols = (c: db.Conn) => (c.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((r) => r.name)
  const c = db.connect(path)
  assert.deepEqual(cols(c), ['id', 'goal', 'created', 'title', 'title_state', 'effort'])
  assert.deepEqual(db.getSession(c, 1), { title: 'old chat', titleState: 0, effort: null }) // no title: the goal is shown
  c.close()
  assert.deepEqual(cols(db.connect(path)), ['id', 'goal', 'created', 'title', 'title_state', 'effort']) // a second open changes nothing
})
