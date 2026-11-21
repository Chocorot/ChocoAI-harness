import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseUserContent, replay, splitEvents, splitThink, TurnModel } from './turn.ts'

test('splitEvents keeps the unfinished tail and skips keepalives and garbage', () => {
  const { events, rest } = splitEvents(': ka\n\ndata: {"t":"text","d":"hi"}\n\ndata: {oops\n\ndata: {"t":"do')
  assert.deepEqual(events, [{ t: 'text', d: 'hi' }])
  assert.equal(rest, 'data: {"t":"do')
})

test('splitThink handles a tag cut in half, open and closed', () => {
  assert.deepEqual(splitThink('<thi'), { think: '', answer: '' })
  assert.deepEqual(splitThink('<think>abc'), { think: 'abc', answer: '' })
  assert.deepEqual(splitThink('<think>abc</think>\n\nHello'), { think: 'abc', answer: 'Hello' })
  assert.deepEqual(splitThink('plain'), { think: '', answer: 'plain' })
})

test('live turn: thinking then text then a tool with its result; answerText drops reasoning', () => {
  const t = new TurnModel()
  assert.equal(t.status?.text, 'Thinking…')
  t.event({ t: 'think', d: 'hmm' })
  assert.equal(t.status, null)
  t.event({ t: 'text', d: 'Hello ' })
  t.event({ t: 'text', d: 'there' })
  t.event({ t: 'tool', id: 'c1', name: 'web_search', args: { query: 'x' } })
  t.event({ t: 'result', id: 'c1', d: 'found', ok: true })
  assert.deepEqual(t.parts.map((p) => p.k), ['think', 'text', 'tool'])
  const tool = t.parts[2] as any
  assert.equal(tool.state, 'ok')
  assert.equal(tool.res, 'found')
  assert.equal(t.answerText(), 'Hello there')
  t.end()
  assert.equal(t.live, false)
  assert.notEqual((t.parts[0] as any).ms, null)
})

test('update_plan call is hidden, its plan event shows one checklist that updates in place', () => {
  const t = new TurnModel()
  t.event({ t: 'tool', id: 'p', name: 'update_plan', args: { steps: ['a'] } })
  t.event({ t: 'result', id: 'p', d: 'ok', ok: true })
  t.event({ t: 'plan', steps: [{ text: 'a', status: 'doing' }, 'b'] })
  t.event({ t: 'plan', steps: [{ text: 'a', status: 'done' }, { text: 'b', status: 'bogus' }] })
  const plans = t.parts.filter((p) => p.k === 'plan') as any[]
  assert.equal(plans.length, 1)
  assert.deepEqual(plans[0].steps.map((s: any) => s.status), ['done', 'todo'])
  assert.equal(t.parts.some((p) => p.k === 'tool'), false)
})

test('delegate: helper tools and notes nest inside the delegate card', () => {
  const t = new TurnModel()
  t.event({ t: 'tool', id: 'd1', name: 'delegate', args: { task: 'look' } })
  t.event({ t: 'tool', sub: 'd1', id: 's1', name: 'web_fetch', args: { url: 'https://x.y' } })
  t.event({ t: 'result', sub: 'd1', id: 's1', d: 'page', ok: true })
  t.event({ t: 'text', sub: 'd1', d: 'note' })
  const card = t.parts[0] as any
  assert.equal(t.parts.length, 1)
  assert.equal(card.sub.length, 1)
  assert.equal(card.sub[0].state, 'ok')
  assert.equal(card.note, 'note')
})

test('retrying with reset drops the half-streamed reply and sets a countdown status', () => {
  const t = new TurnModel()
  t.event({ t: 'text', d: 'half' })
  t.event({ t: 'retrying', attempt: 1, in: 5, msg: 'Busy.', reset: true })
  assert.equal(t.parts.length, 0)
  assert.equal(t.status?.countdown?.from, 5)
  t.event({ t: 'text', d: 'again' })
  assert.equal(t.status, null)
  assert.equal(t.answerText(), 'again')
})

test('a failed tool result and an error event are kept as parts', () => {
  const t = new TurnModel()
  t.event({ t: 'tool', id: 'c', name: 'run_bash', args: { command: 'x' } })
  t.event({ t: 'result', id: 'c', d: 'error: nope', ok: false })
  t.event({ t: 'error', kind: 'upstream_down', msg: 'Down.', retryable: true, rid: 'abc' })
  assert.equal((t.parts[0] as any).state, 'fail')
  const e = t.parts[1] as any
  assert.equal(e.retryable, true)
  assert.equal(e.rid, 'abc')
})

test('parseUserContent pulls document wrappers and photo refs out of a saved message', () => {
  const c = [
    { type: 'text', text: 'read this\n<attached_file name="a.txt" type="text">\nbody\n</attached_file>' },
    { type: 'image_ref', name: 'uploads/p.jpg' },
  ]
  assert.deepEqual(parseUserContent(c), { text: 'read this', files: ['a.txt'], images: ['p.jpg'] })
  assert.deepEqual(parseUserContent('plain'), { text: 'plain', files: [], images: [] })
})

test('replay: one user bubble, one turn with text, tool, result; failed-run notes become notices', () => {
  const items = replay(
    [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'let me look', tool_calls: [{ id: 't1', function: { name: 'web_search', arguments: '{"query":"q"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'results' },
      { role: 'assistant', content: 'done' },
      { role: 'assistant', content: '[run failed: upstream_down] Down.', note: true },
    ],
    7,
  )
  assert.deepEqual(items.map((i) => i.kind), ['user', 'turn'])
  const turn = (items[1] as any).turn as TurnModel
  assert.deepEqual(turn.parts.map((p) => p.k), ['text', 'tool', 'text', 'notice'])
  assert.equal(turn.live, false)
  assert.equal(turn.answerText(), 'let me look\n\ndone')
  assert.match((turn.parts[3] as any).msg, /A previous reply failed: Down\./)
})
