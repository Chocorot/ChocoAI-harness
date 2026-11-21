import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HarnessError } from './errors.ts'
import { RunQueue } from './runq.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('priority then arrival, and the line is bounded (port of the Python test)', async () => {
  const q = new RunQueue(() => 2)
  const order: string[] = []
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  const job = (name: string, prio: number) => q.slot({ prio, tick: 0.05 }, async () => { order.push(name); await gate })
  const first = job('a', 1)
  while (!q.busy()) await sleep(5)
  const waiters = [job('low', 2)]
  await sleep(100)
  waiters.push(job('hi', 0))
  await sleep(100)
  await assert.rejects(q.slot({ prio: 1 }, async () => {}), (e: unknown) => e instanceof HarnessError && e.kind === 'busy') // 2 already waiting, limit is 2
  open()
  await Promise.all([first, ...waiters])
  assert.deepEqual(order, ['a', 'hi', 'low']) // the priority 0 waiter jumped the line
  await q.slot({}, async () => {}) // idle again: never refuses
  assert.equal(q.busy(), false)
})

test('onWait fires at once, reports runs ahead, and may throw to leave the line cleanly', async () => {
  const q = new RunQueue(() => 8)
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  const holder = q.slot({}, () => gate)
  while (!q.busy()) await sleep(5)
  const seen: number[] = []
  await assert.rejects(q.slot({ onWait: (n) => { seen.push(n); throw new Error('left') } }, async () => assert.fail('must not run')), /left/)
  assert.deepEqual(seen, [1])
  assert.equal(q.waitingCount(), 0)
  open()
  await holder
})

test('an idle queue never refuses, even with limit 0; a failing job releases the slot', async () => {
  const q = new RunQueue(() => 0)
  await assert.rejects(q.slot({}, async () => { throw new Error('boom') }), /boom/)
  assert.equal(q.busy(), false)
  assert.equal(await q.slot({}, async () => 'ok'), 'ok')
})
