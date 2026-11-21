/**
 * Talking to the model backend: one streamed call, parsing its event stream, shrinking old history, retry with backoff.
 * Port of legacy/harness.py (`est_tokens`, `compact`, `parse_sse`, `chat`, `call_model`).
 */
import type { Message } from './db.ts'
import { BACKOFF, classify, fromUpstream, UpstreamHttp } from './errors.ts'
import * as settings from './settings.ts'
import * as tools from './tools.ts'

export type Emit = (ev: Record<string, any>) => void
export type Usage = { prompt_tokens?: number | null; completion_tokens?: number | null }
export type ChatFn = (messages: Message[], emit: Emit, schemas?: unknown[] | null, maxTokens?: number | null, effort?: string | null) => Promise<[Message, Usage]>

/** Results old enough to be re-fetched are replaced by a stub when compacting. */
const BULKY = new Set(['read_file', 'web_fetch', 'web_search'])

/** Thinking effort, chosen per chat. `param` is sent to the backend as `reasoning_effort` (null = backend default); `hint` is a
 * sentence added to the system prompt, which works even on models that ignore the parameter. */
export const EFFORT: Record<string, { label: string; desc: string; param: string | null; hint: string }> = {
  low: { label: 'Low', desc: 'Quick answers, little reasoning', param: 'low', hint: 'Reasoning effort: low. Answer directly and briefly; do not deliberate at length.' },
  medium: { label: 'Medium', desc: 'Balanced (default)', param: null, hint: '' },
  high: { label: 'High', desc: 'Thinks longer, checks its work', param: 'high', hint: 'Reasoning effort: high. Think the problem through carefully and check your work before answering.' },
}

/** Python's json.dumps(value): ", " and ": " separators, non-ASCII escaped. The size estimate (and so when history is compacted) must not change. */
export function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  if (Array.isArray(v)) return '[' + v.map(pyDumps).join(', ') + ']'
  return '{' + Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pyDumps(k)}: ${pyDumps(x)}`).join(', ') + '}'
}

// shortcut: chars/4 heuristic, ~20% off for code/CJK; upgrade to backend usage counts if it matters
export const estTokens = (messages: unknown): number => Math.floor(pyDumps(messages).length / 4)

const cpLen = (s: string): number => (s.length < 2 ? s.length : [...s].length)
const cpSlice = (s: string, n: number): string => (s.length <= n ? s : [...s].slice(0, n).join(''))

/** Shrink old tool traffic; keep system, original goal and the last `keepTurns` turns intact.
 * `limit`/`keep` override the settings (used to shrink harder after a context overflow). */
export function compact(messages: Message[], limit?: number | null, keep?: number | null): Message[] {
  if (estTokens(messages) <= (limit || settings.get<number>('compact_at'))) return messages
  const keepTurns = keep || settings.get<number>('keep_turns')
  const turns = messages.flatMap((m, i) => (m.role === 'assistant' ? [i] : []))
  if (turns.length <= keepTurns) return messages
  const cut = turns[turns.length - keepTurns]! // a turn = assistant msg + its tool results, so cutting here never orphans a tool msg
  const names = new Map<string, string>()
  for (const m of messages.slice(0, cut)) for (const tc of m.tool_calls ?? []) names.set(tc.id, tc.function.name)
  const out = messages.slice(0, 2)
  for (let m of messages.slice(2, cut)) {
    if (m.role === 'tool') {
      let c: string = m.content
      const name = names.get(m.tool_call_id)
      if (name !== undefined && BULKY.has(name)) c = `[pruned ${name} output, ${cpLen(c)} chars]`
      else if (cpLen(c) > 200) c = cpSlice(c, 200) + `... [truncated, ${cpLen(c)} chars]`
      m = { ...m, content: c }
    } else if (m.tool_calls?.length) {
      // write_file content / big edits dominate otherwise
      m = { ...m, tool_calls: m.tool_calls.map((tc: any) => (cpLen(tc.function.arguments) <= 300 ? tc : { ...tc, function: { ...tc.function, arguments: pyDumps({ _pruned: `${cpLen(tc.function.arguments)} chars` }) } })) }
    }
    out.push(m)
  }
  return [...out, ...messages.slice(cut)]
}

/**
 * Consumes the backend's server-sent-event lines one at a time; emits text/think deltas as they arrive, buffers tool_call deltas.
 * Thinking is shown via emit only, never stored in history (it would eat the 16K window).
 */
export class SseParser {
  private text: string[] = []
  private calls = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>()
  private usage: Usage = {}
  private emit: Emit

  constructor(emit: Emit) {
    this.emit = emit
  }

  feed(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') return
    const chunk = JSON.parse(line.slice(5)) // a garbled line throws SyntaxError -> upstream_bad_stream
    this.usage = chunk.usage || this.usage
    for (const ch of chunk.choices ?? []) {
      const d = ch.delta ?? {}
      // shortcut: only the separate reasoning_content field; inline <think> tags are not split out
      const think = d.reasoning_content || d.reasoning
      if (think) this.emit({ t: 'think', d: think })
      if (d.content) {
        this.text.push(d.content)
        this.emit({ t: 'text', d: d.content })
      }
      for (const tc of d.tool_calls ?? []) {
        const idx: number = tc.index ?? 0
        const c = this.calls.get(idx) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } }
        this.calls.set(idx, c)
        c.id = tc.id || c.id
        const f = tc.function ?? {}
        c.function.name = f.name || c.function.name
        c.function.arguments += f.arguments || ''
      }
    }
  }

  result(): [Message, Usage] {
    const msg: Message = { role: 'assistant', content: this.text.join('') || null }
    if (this.calls.size) {
      msg.tool_calls = [...this.calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
      msg.tool_calls.forEach((c: { id: string }, i: number) => (c.id = c.id || `call_${i}`))
    }
    return [msg, this.usage]
  }
}

export function parseSse(lines: Iterable<string>, emit: Emit): [Message, Usage] {
  const p = new SseParser(emit)
  for (const l of lines) p.feed(l)
  return p.result()
}

const IDLE_MS = 600_000 // the backend may be silent this long (a long prefill or a model load) before we give up on it

/** One streamed model call. `schemas` = the tools this caller may use (null/undefined = all; empty = none, key omitted). */
export const chat: ChatFn = async (messages, emit, schemas, maxTokens, effort) => {
  const list = schemas === null || schemas === undefined ? tools.SCHEMAS : schemas
  const body: Record<string, unknown> = { model: settings.get('model'), messages, stream: true, stream_options: { include_usage: true } }
  if (list.length) body.tools = list
  for (const k of ['temperature', 'max_tokens']) if (settings.get(k) !== null) body[k] = settings.get(k)
  const e = effort ? EFFORT[effort] : undefined
  if (e?.param) body.reasoning_effort = e.param
  if (maxTokens) body.max_tokens = Math.min(maxTokens, (body.max_tokens as number | undefined) ?? maxTokens) // a caller-specific cap (public visitors) wins over the saved value
  const url = (process.env.BASE_URL ?? 'http://localhost:1235/v1').replace(/\/+$/, '') + '/chat/completions'
  const ctl = new AbortController()
  let timer = setTimeout(() => ctl.abort(Object.assign(new Error('the model backend was silent for too long'), { name: 'TimeoutError' })), IDLE_MS)
  const touch = () => {
    clearTimeout(timer)
    timer = setTimeout(() => ctl.abort(Object.assign(new Error('the model backend was silent for too long'), { name: 'TimeoutError' })), IDLE_MS)
  }
  try {
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (process.env.API_KEY ?? 'lm-studio') }, signal: ctl.signal })
    if (!res.ok) throw new UpstreamHttp(res.status, (await res.text().catch(() => '')).slice(0, 2000))
    const parser = new SseParser(emit)
    const decoder = new TextDecoder()
    let rest = ''
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      touch()
      rest += decoder.decode(chunk, { stream: true })
      const lines = rest.split('\n')
      rest = lines.pop()!
      for (const l of lines) parser.feed(l)
    }
    rest += decoder.decode()
    if (rest) parser.feed(rest)
    return parser.result()
  } catch (err) {
    // a timeout we raised ourselves arrives as the abort reason
    throw fromUpstream(ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : err)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One model call with recovery. Transient failures are retried (settings `retries`, backoff in errors.BACKOFF); a context
 * overflow is retried once with the history shrunk harder. Returns [message, usage, what was sent]. Throws HarnessError.
 * `retrying.reset` tells the page to discard a half-streamed reply before the retry. `prep` turns the compacted messages into
 * what the backend gets (photos become data URLs); `sent` stays the small form.
 */
export async function callModel(
  messages: Message[],
  emit: Emit,
  chatFn: (messages: Message[], emit: Emit) => Promise<[Message, Usage]>,
  opts: { sleep?: (s: number) => Promise<void>; prep?: (m: Message[]) => Message[] } = {},
): Promise<[Message, Usage, Message[]]> {
  const sleep = opts.sleep ?? ((s: number) => new Promise<void>((r) => setTimeout(r, s * 1000)))
  const prep = opts.prep ?? ((m: Message[]) => m)
  let sent = compact(messages)
  let shrunk = false
  let attempt = 0
  for (;;) {
    let streamed = false
    const spy: Emit = (ev) => {
      if (ev.t === 'text' || ev.t === 'think') streamed = true
      emit(ev)
    }
    try {
      const [msg, usage] = await chatFn(prep(sent), spy)
      return [msg, usage, sent]
    } catch (e) {
      const err = classify(e) // chat() already turned backend failures into HarnessError
      if (err.kind === 'context_overflow' && !shrunk) {
        shrunk = true
        const smaller = compact(messages, 1, Math.max(1, Math.floor(settings.get<number>('keep_turns') / 2)))
        if (estTokens(smaller) < estTokens(sent)) {
          sent = smaller
          emit({ t: 'retrying', attempt, in: 0, kind: err.kind, msg: 'Shrinking the history to fit.', reset: streamed })
          continue
        }
      } else if (err.auto && attempt < settings.get<number>('retries')) {
        const wait = BACKOFF[Math.min(attempt, BACKOFF.length - 1)]!
        attempt++
        emit({ t: 'retrying', attempt, in: wait, kind: err.kind, msg: err.message, reset: streamed })
        await sleep(wait)
        continue
      }
      throw err
    }
  }
}

