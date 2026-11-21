import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as agent from './agent.ts'
import { MODES } from './auth.ts'
import * as db from './db.ts'
import type { Message } from './db.ts'
import * as errors from './errors.ts'
import { HarnessError } from './errors.ts'
import * as model from './model.ts'
import * as settings from './settings.ts'
import * as tools from './tools.ts'
import { call, FakeModel, freshEnv, golden } from './test-helpers.ts'

beforeEach(() => void freshEnv())

test('titles, plan cleaning, public history trimming and the prompt text equal Python', () => {
  const t = golden('titles')
  for (const [input, out] of t.short) assert.equal(agent.shortTitle(input), out, JSON.stringify(input))
  for (const [input, out] of t.clean) assert.equal(agent.cleanTitle(input), out, JSON.stringify(input))
  for (const [raw, out] of golden('plan_steps')) assert.deepEqual(agent.planSteps(raw), out, JSON.stringify(raw).slice(0, 60))
  const hist = [['assistant', 'orphan'], ['user', 'u'.repeat(50)], ['assistant', 'a'.repeat(50)], ['user', 'u2'.repeat(30)], ['assistant', 'a2'], ['user', 'last']].map(([role, content]) => ({ role: role!, content: content! }))
  for (const [cap, out] of golden('trim_history')) assert.deepEqual(agent.trimHistory(hist, cap), out, String(cap))
  const p = golden('effort_and_prompts')
  assert.deepEqual(model.EFFORT, p.effort)
  assert.equal(agent.DEFAULT_EFFORT, p.default)
  assert.equal(agent.HELPER_PROMPT, p.helper)
  assert.equal(agent.systemText(MODES.admin.tools), p.system_all)
  assert.equal(agent.systemText(MODES.user.tools, 'high'), p.system_user)
  assert.equal(agent.systemText(null), p.system_none)
})

test('short and clean title edge cases (port of the Python title tests)', () => {
  assert.equal(agent.shortTitle('# Plan a trip to https://example.org/kyoto-guide and check the weather for next week please'), 'Plan a trip to example.org and check the…')
  assert.equal(agent.shortTitle('a'.repeat(100)), 'a'.repeat(48) + '…') // no space to cut at
  assert.ok([...agent.shortTitle('word '.repeat(40))].length <= 49)
  assert.equal(agent.cleanTitle('Title: "Kyoto trip plan."\nExtra explanation'), 'Kyoto trip plan')
  assert.equal(agent.cleanTitle('**Weather in Kyoto**'), 'Weather in Kyoto')
  for (const bad of ['', '   ', 'x', '\n\n']) assert.equal(agent.cleanTitle(bad), '')
  assert.ok([...agent.cleanTitle('word '.repeat(40))].length <= 60)
})

function ctx() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-'))
  return { conn: db.connect(join(dir, 'h.db')), ws: dir }
}
const noRetry = () => settings.save({ retries: 0 })

test('loop: tools run, everything is persisted, resume appends, max turns stops with a valid history', async () => {
  const { conn, ws } = ctx()
  const [sid, messages] = agent.start(conn, 'make f', null)
  const fake = new FakeModel(call('write_file', { path: 'f.txt', content: 'hi' }, '1'), 'done')
  const out = await agent.runAgent(conn, sid, messages, ws, { chat: fake.fn })
  assert.equal(out, 'done')
  assert.equal(readFileSync(join(ws, 'f.txt'), 'utf8'), 'hi')
  assert.equal(db.load(conn, sid).length, 5) // system, user, assistant, tool, assistant
  assert.equal((conn.prepare('SELECT tool FROM audit').pluck().get()), 'write_file')
  const [sid2, resumed] = agent.start(conn, 'again', sid) // resume appends to the same history
  assert.deepEqual([sid2, resumed.length], [sid, 6])
  const loop: Message = { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'run_bash', arguments: '{bad' } }] }
  const stuck = await agent.runAgent(conn, sid, resumed, ws, { maxTurns: 2, chat: async () => [structuredClone(loop), {}] })
  assert.match(stuck, /max_turns/)
  assert.match(resumed[resumed.length - 1]!.content, /invalid JSON/)
})

test('a failed run leaves a note the model sees; retry removes it; an unknown session is a typed error', async () => {
  noRetry()
  const { conn, ws } = ctx()
  const boom = (kind: ConstructorParameters<typeof HarnessError>[0] = 'upstream_5xx') => async (): Promise<[Message, {}]> => { throw new HarnessError(kind) }
  const [sid, msgs] = agent.start(conn, 'do it', null)
  await assert.rejects(agent.runAgent(conn, sid, msgs, ws, { chat: boom('upstream_timeout') }), HarnessError)
  const saved = db.load(conn, sid)
  assert.deepEqual([saved[saved.length - 1]!.role, saved[saved.length - 1]!.content === msgs[msgs.length - 1]!.content], ['assistant', true])
  assert.ok(saved[saved.length - 1]!.content.startsWith(errors.NOTE_PREFIX + 'upstream_timeout/upstream_timeout]'))
  const [, more] = agent.start(conn, 'try shorter', sid) // a new message: the note stays so the model knows
  assert.deepEqual(more.slice(-3).map((m) => m.role), ['user', 'assistant', 'user'])
  const [, again] = agent.start(conn, null, sid, { retry: true }) // plain retry: note removed
  assert.equal(again[again.length - 1]!.content, 'try shorter')
  const [sid2, msgs2] = agent.start(conn, 'x', null)
  await assert.rejects(agent.runAgent(conn, sid2, msgs2, ws, { chat: boom() }), HarnessError)
  const [, again2] = agent.start(conn, null, sid2, { retry: true })
  assert.deepEqual(again2.map((m) => m.role), ['system', 'user'])
  assert.equal(db.load(conn, sid2).length, 2)
  assert.throws(() => agent.start(conn, 'x', 999), (e: any) => e.kind === 'not_found')
})

test('orphan tool calls (a crash between a call and its result) are repaired on resume, once', () => {
  const { conn } = ctx()
  const sid = db.newSession(conn, 'g')
  const calls = [0, 1].map((i) => ({ id: `c${i}`, type: 'function', function: { name: 'run_bash', arguments: '{}' } }))
  for (const m of [{ role: 'system', content: 's' }, { role: 'user', content: 'g' }, { role: 'assistant', content: null, tool_calls: calls }, { role: 'tool', tool_call_id: 'c0', content: 'done' }]) db.saveMsg(conn, sid, m)
  const [, msgs] = agent.start(conn, 'go on', sid)
  assert.deepEqual(msgs.slice(-3).map((m) => m.role), ['tool', 'tool', 'user'])
  assert.match(msgs[msgs.length - 2]!.content, /error\[interrupted\]/)
  assert.deepEqual(db.load(conn, sid).slice(1), msgs.slice(1)) // the repaired history is what the DB holds (msgs[0] is the live prompt)
  const before = msgs.length
  agent.repairTail(conn, sid, msgs)
  assert.equal(msgs.length, before) // idempotent
})

function modeRun(allow: string[] | null = null) {
  const { conn, ws } = ctx()
  noRetry()
  const evs: any[] = []
  const run = async (chat: model.ChatFn, maxTurns?: number, goal = 'go') => {
    const [sid, msgs] = agent.start(conn, goal, null, { allow })
    const out = await agent.runAgent(conn, sid, msgs, ws, { chat, emit: (e) => evs.push(e), allow, maxTurns })
    return { out, sid, msgs }
  }
  return { conn, evs, run }
}

test('update_plan emits a checklist and cleans its input; an empty plan is a tool error', async () => {
  const { evs, run } = modeRun()
  const plan = [{ text: 'read', status: 'done' }, { text: 'write', status: 'weird' }, 'just a string', { nope: 1 }, '  ']
  const a = await run(new FakeModel(call('update_plan', { steps: plan }), 'done').fn)
  assert.deepEqual(evs.find((e) => e.t === 'plan').steps, [{ text: 'read', status: 'done' }, { text: 'write', status: 'todo' }, { text: 'just a string', status: 'todo' }])
  assert.equal(a.msgs[3]!.content, 'ok: plan has 3 steps, 1 done')
  const b = await run(new FakeModel(call('update_plan', { steps: [] }), 'done').fn)
  assert.ok(b.msgs[3]!.content.startsWith('error[bad_args]'))
})

test('delegate runs in a fresh context, returns only the summary, audits the helper tools, nests its events', async () => {
  const { conn, evs, run } = modeRun(MODES.user.tools)
  const fake = new FakeModel(call('delegate', { task: 'find the answer' }, 'd1'), call('web_fetch', { url: 'http://127.0.0.1/' }, 's1'), 'the answer is 42', 'All done: 42')
  const { out, sid, msgs } = await run(fake.fn)
  assert.equal(out, 'All done: 42')
  const helper = fake.calls[1]!
  assert.deepEqual(helper.messages.map((m) => m.role), ['system', 'user']) // fresh context, parent history not copied
  assert.ok(helper.messages[0]!.content.includes(agent.HELPER_PROMPT))
  assert.equal(helper.messages[1]!.content, 'find the answer')
  const names = (helper.schemas as any[]).map((s) => s.function.name)
  assert.ok(!names.includes('update_plan') && !names.includes('delegate') && names.includes('web_fetch')) // helpers can't plan or delegate
  assert.equal(msgs[3]!.content, 'the answer is 42') // the parent sees the summary only
  assert.deepEqual(db.load(conn, sid).map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant'])
  assert.deepEqual((conn.prepare('SELECT tool FROM audit ORDER BY id').pluck().all()), ['web_fetch', 'delegate']) // the helper's tool call is audited
  const sub = evs.filter((e) => e.sub === 'd1')
  for (const t of ['status', 'tool', 'result']) assert.ok(sub.some((e) => e.t === t), t)
  assert.ok(!evs.filter((e) => e.t === 'tool' && e.name === 'delegate').some((e) => 'sub' in e))
})

test('a failing helper is a tool error, not a dead run; helpers respect the caller\'s tool limits', async () => {
  const { run, evs } = modeRun(MODES.user.tools)
  const chat: model.ChatFn = async (messages) => {
    if (messages.length === 2 && messages[0]!.content.includes(agent.HELPER_PROMPT)) throw new HarnessError('upstream_down')
    return messages[messages.length - 1]!.role === 'user' ? [call('delegate', { task: 'x' }), {}] : [{ role: 'assistant', content: 'ok anyway' }, {}]
  }
  const r = await run(chat)
  assert.equal(r.out, 'ok anyway')
  assert.ok(r.msgs[3]!.content.startsWith('error[delegate_failed]'))
  evs.length = 0
  await run(new FakeModel(call('delegate', { task: 't' }), call('run_bash', { command: 'echo hi' }, 'b'), 'no shell', 'fine').fn)
  assert.match(evs.find((e) => e.t === 'result' && e.sub).d, /error\[forbidden\]/)
})

test('budgets: time, tokens and turns each stop the run with one notice, and a stopped run can be continued', async () => {
  const { conn, evs, run } = modeRun()
  settings.save({ max_seconds: 1 })
  const slow: model.ChatFn = async () => (await new Promise((r) => setTimeout(r, 1100)), [call('update_plan', { steps: ['a'] }), {}])
  const t = await run(slow, 5)
  assert.equal(t.out, '[stopped: max_seconds=1 reached]')
  const n = evs.filter((e) => e.t === 'notice')
  assert.deepEqual([n.length, n[0].kind, n[0].reason], [1, 'budget', 'max_seconds=1 reached'])
  settings.save({ max_seconds: null, max_run_tokens: 1000 })
  evs.length = 0
  const tok = await run(async () => [call('update_plan', { steps: ['a'] }), { prompt_tokens: 500, completion_tokens: 100 }], 10)
  assert.equal(tok.out, '[stopped: max_run_tokens=1000 reached]') // 600 + 600 > 1000 after two calls
  assert.equal(evs.filter((e) => e.t === 'status' && e.phase === 'model').length, 2)
  settings.save({ max_run_tokens: null })
  evs.length = 0
  const turns = await run(async () => [call('update_plan', { steps: ['a'] }), {}], 3)
  assert.equal(turns.out, '[stopped: max_turns=3 reached]')
  assert.deepEqual(evs.filter((e) => e.t === 'notice').map((e) => e.reason), ['max_turns=3 reached'])
  const [, msgs] = agent.start(conn, 'continue', turns.sid)
  assert.deepEqual(msgs.slice(-2).map((m) => m.role), ['tool', 'user']) // history stays valid after a budget stop
})

test('a public chat sends no tools, caps the reply, adds the effort hint, and keeps nothing', async () => {
  const fake = new FakeModel('hello visitor')
  const events: any[] = []
  const out = await agent.runPublic([{ role: 'user', content: 'hi' }], (e) => events.push(e), { chat: fake.fn, effort: 'high' })
  assert.equal(out, 'hello visitor')
  const c = fake.calls[0]!
  assert.deepEqual([c.schemas, c.maxTokens, c.effort], [[], 1024, 'high'])
  assert.ok(c.messages[0]!.content.includes('Reasoning effort: high'))
  assert.deepEqual(c.messages.slice(1), [{ role: 'user', content: 'hi' }])
  void tools
})
