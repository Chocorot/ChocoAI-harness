import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { HarnessError } from './errors.ts'
import * as model from './model.ts'
import * as settings from './settings.ts'
import type { Message } from './db.ts'
import { convo, convoPy, freshEnv, golden } from './test-helpers.ts'

beforeEach(() => void freshEnv())

test('compaction equals Python for every golden case (sizes, pruned stubs, kept tail)', () => {
  for (const c of golden('compact').cases) {
    const msgs = convo(c.turns, c.big)
    assert.equal(model.estTokens(msgs), c.estBefore, `${c.turns}/${c.big} estimate`)
    assert.deepEqual(model.compact(msgs, c.limit, c.keep), c.out, `${c.turns}/${c.big}/${c.limit}/${c.keep}`)
  }
})

test('compaction: small history untouched, head and tail kept, no orphan tool messages, big arguments pruned, old web results stubbed', () => {
  const small = convoPy(2, 10)
  assert.equal(model.compact(small), small)
  const m = convoPy(10)
  assert.ok(model.estTokens(m) > 11000)
  const c = model.compact(m)
  assert.deepEqual(c.slice(0, 2), m.slice(0, 2))
  assert.deepEqual(c.slice(-8), m.slice(-8)) // last 4 turns verbatim
  assert.ok(model.estTokens(c) < 11000)
  assert.match(c[5]!.content, /pruned read_file/) // c0 is run_bash -> c[3]; c1 read_file -> c[5]
  assert.ok(c[3]!.content.endsWith('chars]'))
  const ids = new Set(c.flatMap((x) => (x.tool_calls ?? []).map((tc: any) => tc.id)))
  assert.ok(c.filter((x) => x.role === 'tool').every((x) => ids.has(x.tool_call_id)))
  const big = convoPy(10)
  big[2]!.tool_calls![0].function.arguments = JSON.stringify({ content: 'y'.repeat(5000) })
  assert.match(model.compact(big)[2]!.tool_calls![0].function.arguments, /_pruned/)
  const web = convoPy(10)
  web[2]!.tool_calls![0].function.name = 'web_fetch'
  web[6]!.tool_calls![0].function.name = 'web_search'
  const wc = model.compact(web)
  assert.match(wc[3]!.content, /pruned web_fetch output/)
  assert.match(wc[7]!.content, /pruned web_search output/)
})

test('the size estimate counts like Python (non-ASCII is escaped, separators have spaces)', () => {
  assert.equal(model.pyDumps({ a: 'é', b: [1, null, true] }), '{"a": "\\u00e9", "b": [1, null, true]}')
  assert.equal(model.pyDumps('😀'), '"\\ud83d\\ude00"')
})

test('event stream parsing equals Python: text, reasoning, split tool calls, noise lines', () => {
  const g = golden('parse_sse')
  const sse = (...chunks: unknown[]) => [...chunks.map((c) => 'data: ' + JSON.stringify(c)), 'data: [DONE]']
  const inputs: Record<string, string[]> = {
    plain_text: sse({ choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    reasoning_and_text: sse({ choices: [{ delta: { reasoning_content: 'hmm' } }] }, { choices: [{ delta: { reasoning: 'more' } }] }, { choices: [{ delta: { content: 'ok' } }] }),
    tool_calls_split: sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'read_file', arguments: '{"pa' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] }, { choices: [{ delta: { tool_calls: [{ index: 1, function: { name: 'run_bash', arguments: '{}' } }] } }] }),
    ignores_noise: ['', ': ka', 'event: x', 'data: [DONE]', 'data: {"choices": []}'],
    bytes_like_blank: sse(),
  }
  for (const [name, lines] of Object.entries(inputs)) {
    const events: unknown[] = []
    const [msg, usage] = model.parseSse(lines, (e) => events.push(e))
    assert.deepEqual({ msg, usage, events }, g[name], name)
  }
  assert.throws(() => model.parseSse(['data: {oops'], () => {}), SyntaxError)
})

const flaky = (fails: number, kind: ConstructorParameters<typeof HarnessError>[0] = 'upstream_5xx', streamFirst = false) => {
  const calls: Message[][] = []
  const fn = async (messages: Message[], emit: model.Emit): Promise<[Message, model.Usage]> => {
    calls.push(messages)
    if (calls.length <= fails) {
      if (streamFirst) emit({ t: 'text', d: 'par' })
      throw new HarnessError(kind)
    }
    return [{ role: 'assistant', content: 'ok' }, { prompt_tokens: 1 }]
  }
  return { fn, calls }
}

test('transient failures retry with backoff and tell the page to drop the half reply', async () => {
  const { fn, calls } = flaky(2, 'upstream_5xx', true)
  const evs: any[] = []
  const waits: number[] = []
  const [msg] = await model.callModel(convoPy(1, 5), (e) => evs.push(e), fn, { sleep: async (s) => void waits.push(s) })
  assert.deepEqual([msg.content, calls.length, waits], ['ok', 3, [2, 6]])
  assert.deepEqual(evs.filter((e) => e.t === 'retrying').map((e) => [e.attempt, e.in, e.reset]), [[1, 2, true], [2, 6, true]])
})

test('gives up after the retries setting; non-transient kinds are never retried', async () => {
  settings.save({ retries: 1 })
  const f = flaky(99)
  const waits: number[] = []
  await assert.rejects(model.callModel(convoPy(1, 5), () => {}, f.fn, { sleep: async (s) => void waits.push(s) }), (e: any) => e.kind === 'upstream_5xx')
  assert.deepEqual([f.calls.length, waits], [2, [2]])
  for (const kind of ['upstream_4xx', 'upstream_timeout', 'upstream_auth'] as const) {
    const g = flaky(99, kind)
    const w: number[] = []
    await assert.rejects(model.callModel(convoPy(1, 5), () => {}, g.fn, { sleep: async (s) => void w.push(s) }))
    assert.deepEqual([g.calls.length, w], [1, []], kind)
  }
})

test('context overflow shrinks once then succeeds; one that cannot shrink is reported', async () => {
  settings.save({ compact_at: 200000 }) // nothing is shrunk on the first try
  const f = flaky(1, 'context_overflow')
  const evs: any[] = []
  const [msg] = await model.callModel(convoPy(10), (e) => evs.push(e), f.fn)
  assert.equal(msg.content, 'ok')
  assert.ok(model.estTokens(f.calls[1]) < model.estTokens(f.calls[0]))
  assert.deepEqual(evs.map((e) => e.t), ['retrying'])
  const g = flaky(99, 'context_overflow')
  await assert.rejects(model.callModel(convoPy(1, 5), () => {}, g.fn), (e: any) => e.kind === 'context_overflow')
  assert.equal(g.calls.length, 1)
  void writeFileSync
})
