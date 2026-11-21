import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as model from './model.ts'
import * as settings from './settings.ts'
import { freshEnv } from './test-helpers.ts'

let server: http.Server
let seen: Array<{ url: string; auth: string | undefined; body: any }> = []
let handler: (req: http.IncomingMessage, res: http.ServerResponse, body: any) => void = () => {}

server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    seen.push({ url: req.url!, auth: req.headers.authorization, body })
    handler(req, res, body)
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`
after(() => server.close())
beforeEach(() => {
  freshEnv()
  seen = []
  process.env.BASE_URL = base // a trailing slash is tolerated
  process.env.API_KEY = 'gateway-key'
})

const sse = (res: http.ServerResponse, chunks: unknown[], opts: { split?: boolean } = {}) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const all = chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n'
  if (opts.split) for (let i = 0; i < all.length; i += 7) res.write(all.slice(i, i + 7)) // chunk borders fall inside lines and inside UTF-8
  else res.write(all)
  res.end()
}

test('a streamed call: request body, auth header, deltas emitted as they come, final message and usage', async () => {
  handler = (_q, res) => sse(res, [{ choices: [{ delta: { reasoning_content: 'hm' } }] }, { choices: [{ delta: { content: 'Héllo ' } }] }, { choices: [{ delta: { content: 'wörld' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }], { split: true })
  settings.save({ model: 'm/x', temperature: 0.3, max_tokens: 500 })
  const evs: any[] = []
  const [msg, usage] = await model.chat([{ role: 'user', content: 'hi' }], (e) => evs.push(e), null, 100, 'high')
  assert.deepEqual([msg.content, usage], ['Héllo wörld', { prompt_tokens: 7, completion_tokens: 3 }])
  assert.deepEqual(evs.map((e) => [e.t, e.d]), [['think', 'hm'], ['text', 'Héllo '], ['text', 'wörld']])
  const r = seen[0]!
  assert.deepEqual([r.url, r.auth], ['/v1/chat/completions', 'Bearer gateway-key'])
  assert.deepEqual([r.body.model, r.body.stream, r.body.stream_options, r.body.temperature, r.body.max_tokens, r.body.reasoning_effort], ['m/x', true, { include_usage: true }, 0.3, 100, 'high']) // the caller's cap wins
  assert.ok(Array.isArray(r.body.tools) && r.body.tools.length === 8) // null = all tools
})

test('no tools key when the caller has none; medium effort sends nothing; unset temperature is not sent', async () => {
  handler = (_q, res) => sse(res, [{ choices: [{ delta: { content: 'x' } }] }])
  await model.chat([{ role: 'user', content: 'hi' }], () => {}, [], null, 'medium')
  const b = seen[0]!.body
  assert.deepEqual(['tools' in b, 'reasoning_effort' in b, 'temperature' in b, 'max_tokens' in b], [false, false, false, false])
})

test('backend HTTP errors become typed failures; the body is read to recognise a context overflow', async () => {
  const cases: Array<[number, string, string, string]> = [[500, 'boom', 'upstream_5xx', 'http_500'], [401, '{}', 'upstream_auth', 'http_401'], [400, '{"error":{"message":"Context size exceeded: n_ctx 4096"}}', 'context_overflow', 'http_400'], [429, 'slow', 'upstream_5xx', 'http_429'], [400, 'bad', 'upstream_4xx', 'http_400']]
  for (const [status, body, kind, code] of cases) {
    handler = (_q, res) => (res.writeHead(status), res.end(body))
    await assert.rejects(model.chat([{ role: 'user', content: 'hi' }], () => {}), (e: any) => e.kind === kind && e.code === code, `${status} ${body}`)
  }
})

test('a refused connection is upstream_down; a garbled stream is upstream_bad_stream; a cut-off stream is upstream_down', async () => {
  const probe = http.createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const closed = (probe.address() as AddressInfo).port // a port nothing listens on (port 1 is blocked by fetch itself)
  await new Promise((r) => probe.close(r))
  process.env.BASE_URL = `http://127.0.0.1:${closed}/v1`
  await assert.rejects(model.chat([{ role: 'user', content: 'hi' }], () => {}), (e: any) => e.kind === 'upstream_down' && e.code === 'refused')
  process.env.BASE_URL = base
  handler = (_q, res) => (res.writeHead(200), res.end('data: {not json}\n\n'))
  await assert.rejects(model.chat([{ role: 'user', content: 'hi' }], () => {}), (e: any) => e.kind === 'upstream_bad_stream')
  handler = (_q, res) => {
    res.writeHead(200, { 'Content-Length': '1000' })
    res.write('data: {"choices":[{"delta":{"content":"par"}}]}\n\n')
    setTimeout(() => res.destroy(), 20)
  }
  await assert.rejects(model.chat([{ role: 'user', content: 'hi' }], () => {}), (e: any) => ['upstream_down', 'upstream_bad_stream'].includes(e.kind))
})
