import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKOFF, classify, fromUpstream, HarnessError, KINDS, NOTE_PREFIX, UpstreamHttp } from './errors.ts'
import { golden } from './test-helpers.ts'

const g = golden('errors')

test('the failure table equals the Python one (one deliberate change: the sign-in message no longer mentions the mail server)', () => {
  const expected = { ...g.kinds, login_unavailable: { ...g.kinds.login_unavailable, msg: 'Sign-in is unavailable right now. Try again shortly.' } }
  assert.deepEqual(JSON.parse(JSON.stringify(KINDS)), expected)
  assert.deepEqual([...BACKOFF], g.backoff)
  assert.equal(NOTE_PREFIX, g.prefix)
})

test('backend HTTP errors map to the same kind and code as Python, incl. context overflow wording', () => {
  for (const c of g.upstream_http) {
    const e = fromUpstream(new UpstreamHttp(c.status, c.body))
    assert.deepEqual([e.kind, e.code, e.detail], [c.kind, c.code, c.detail], JSON.stringify(c))
  }
})

test('note, event and body have the Python shapes', () => {
  const e = new HarnessError('busy')
  assert.equal(e.note(), g.note)
  assert.deepEqual(e.event('abcd1234'), g.event)
  assert.deepEqual(e.body('abcd1234'), g.body)
  assert.deepEqual(new HarnessError('upstream_5xx', undefined, { code: 'http_502', detail: 'd'.repeat(400) }).event('r1'), g.event_custom)
})

test('network failures map like the Python ones: refused, timeout, bad JSON, anything else is internal', () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
  assert.deepEqual([fromUpstream(refused).kind, fromUpstream(refused).code], ['upstream_down', 'refused'])
  const dns = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) })
  assert.deepEqual([fromUpstream(dns).kind, fromUpstream(dns).code], ['upstream_down', 'enotfound'])
  assert.equal(fromUpstream(Object.assign(new Error('x'), { name: 'TimeoutError' })).kind, 'upstream_timeout')
  assert.equal(fromUpstream(new SyntaxError('Unexpected token')).kind, 'upstream_bad_stream')
  const odd = fromUpstream(new RangeError('boom'))
  assert.deepEqual([odd.kind, odd.code], ['internal', 'RangeError'])
  assert.equal(classify('a string').kind, 'internal')
})
