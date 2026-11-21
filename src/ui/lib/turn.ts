/**
 * One assistant turn as plain data, fed by streamed events (docs/chat-streaming.md) or by a saved chat (replay).
 * No React and no DOM in here: the components only draw what this model holds, and node --test can drive it.
 * Port of legacy/web/js/turn.js + sse.js + attach.js (parseUserContent).
 */

export type Ev = Record<string, any>

// ---- reading the event stream -------------------------------------------------------------------------------------------------
/** Complete `data:` events in `buf`, plus the unfinished tail. Lines starting with ":" (keepalive) and garbled lines are skipped. */
export function splitEvents(buf: string): { events: Ev[]; rest: string } {
  const parts = buf.split('\n\n')
  const rest = parts.pop()!
  const events: Ev[] = []
  for (const part of parts) {
    for (const line of part.split('\n')) {
      if (!line.startsWith('data:')) continue
      try {
        events.push(JSON.parse(line.slice(5)))
      } catch {
        /* a garbled line is skipped, the stream goes on */
      }
    }
  }
  return { events, rest }
}

export async function* readEvents(res: Response): AsyncGenerator<Ev> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const { events, rest } = splitEvents(buf)
    buf = rest
    yield* events
  }
}

/** Some models put their reasoning inline as <think>...</think>. Recomputed from the full text each time, so a half-streamed tag is fine. */
export function splitThink(raw: string): { think: string; answer: string } {
  const t = raw.trimStart()
  if (!t.startsWith('<think>')) return '<think>'.startsWith(t) && t.length < 7 && t.length > 0 ? { think: '', answer: '' } : { think: '', answer: raw }
  const end = t.indexOf('</think>')
  return end < 0 ? { think: t.slice(7), answer: '' } : { think: t.slice(7, end), answer: t.slice(end + 8).trimStart() }
}

// ---- what a tool looks like: one row per tool, a new tool needs no code elsewhere ----------------------------------------------------
export const TOOL_UI: Record<string, { icon: string; label: string; arg: string | null; hidden?: boolean }> = {
  read_file: { icon: 'file', label: 'Reading file', arg: 'path' },
  edit_file: { icon: 'file', label: 'Editing file', arg: 'path' },
  write_file: { icon: 'file', label: 'Writing file', arg: 'path' },
  run_bash: { icon: 'terminal', label: 'Running command', arg: 'command' },
  web_fetch: { icon: 'globe', label: 'Reading page', arg: 'url' },
  web_search: { icon: 'search', label: 'Searching the web', arg: 'query' },
  delegate: { icon: 'users', label: 'Helper', arg: 'task' },
  update_plan: { icon: 'list', label: 'Plan', arg: null, hidden: true }, // shown as the plan checklist instead
}
export const ERROR_ICON: Record<string, string> = {
  busy: 'clock', rate_limited: 'clock', upstream_down: 'cloudoff', upstream_timeout: 'clock', auth: 'lock', forbidden: 'lock', login_unavailable: 'lock', context_overflow: 'layers',
}
export const toolUi = (name: string) => TOOL_UI[name] ?? { icon: 'wrench', label: name, arg: null }

export function argSummary(name: string, args: unknown): string {
  const ui = toolUi(name)
  const o = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const v = ui.arg ? o[ui.arg] : null
  const s = typeof v === 'string' ? v : (Object.values(o).find((x) => typeof x === 'string') as string | undefined) ?? ''
  return s.replace(/^https?:\/\//, '').replace(/\s+/g, ' ').slice(0, 90)
}

// ---- the model -------------------------------------------------------------------------------------------------------------------
export type PlanStep = { text: string; status: 'todo' | 'doing' | 'done' }
export type Part =
  | { k: 'think'; id: number; raw: string; t0: number; ms: number | null }
  | { k: 'text'; id: number; raw: string }
  | { k: 'tool'; id: number; key: string; name: string; args: unknown; state: 'running' | 'ok' | 'fail'; res: string | null; t0: number; ms: number | null; sub: Part[]; note: string }
  | { k: 'plan'; id: number; steps: PlanStep[] }
  | { k: 'notice'; id: number; kind: string; msg: string }
  | { k: 'error'; id: number; kind?: string; msg: string; rid?: string; retryable: boolean; note?: string }
export type Status = { text: string; icon: string; shimmer: boolean; countdown?: { from: number; at: number } } | null

const RES_MAX = 3000
let seq = 0

export const planSteps = (raw: unknown): PlanStep[] =>
  (Array.isArray(raw) ? raw : []).map((x) =>
    typeof x === 'string'
      ? { text: x, status: 'todo' as const }
      : { text: String(x?.text || ''), status: (['todo', 'doing', 'done'].includes(x?.status) ? x.status : 'todo') as PlanStep['status'] },
  )

export class TurnModel {
  parts: Part[] = []
  status: Status = null
  live: boolean
  /** the run ended with `done` (not an error, not a stop): only then the page offers Copy / Regenerate */
  finished = false
  /** bumped on every change; the page redraws when it differs from what it drew */
  version = 0
  private cur: Part | null = null
  private tools = new Map<string, Extract<Part, { k: 'tool' }>>()
  private hidden = new Set<string>()
  private sawContent = false

  constructor(live = true) {
    this.live = live
    if (live) this.status = { text: 'Thinking…', icon: 'sparkle', shimmer: true }
  }

  private touch() {
    this.version++
  }

  event(ev: Ev): void {
    if (ev.sub) return this.subEvent(ev)
    switch (ev.t) {
      case 'queued':
        return this.setStatus(`Waiting in line · ${ev.pos} ahead`, 'clock', false)
      case 'status':
        if (ev.phase === 'model' && !this.sawContent) this.setStatus(ev.turn > 1 ? `Thinking… step ${ev.turn}` : 'Thinking…', 'sparkle', true)
        return
      case 'think':
        return this.stream('think', ev.d)
      case 'text':
        return this.stream('text', ev.d)
      case 'tool':
        return this.tool(ev)
      case 'result':
        return this.result(ev)
      case 'plan':
        return this.plan(planSteps(ev.steps))
      case 'notice':
        return this.notice(ev)
      case 'retrying':
        return this.retrying(ev)
      case 'error':
        return this.error(ev)
    }
  }

  private content() {
    this.sawContent = true
    this.status = null
  }

  closeCur() {
    const p = this.cur
    this.cur = null
    if (p?.k === 'think' && p.ms === null) p.ms = Date.now() - p.t0
  }

  private stream(kind: 'think' | 'text', d: string) {
    this.content()
    if (this.cur?.k !== kind) {
      this.closeCur()
      this.cur = kind === 'think' ? { k: 'think', id: ++seq, raw: '', t0: Date.now(), ms: null } : { k: 'text', id: ++seq, raw: '' }
      this.parts.push(this.cur)
    }
    ;(this.cur as { raw: string }).raw += d
    this.touch()
  }

  private tool(ev: Ev) {
    const key = `${ev.sub || ''}:${ev.id}`
    if (TOOL_UI[ev.name]?.hidden) return void this.hidden.add(key)
    this.content()
    if (!ev.sub) this.closeCur()
    const part: Extract<Part, { k: 'tool' }> = { k: 'tool', id: ++seq, key, name: ev.name, args: ev.args, state: 'running', res: null, t0: Date.now(), ms: null, sub: [], note: '' }
    this.tools.set(key, part)
    const parent = ev.sub ? this.tools.get(`:${ev.sub}`) : undefined
    if (parent) parent.sub.push(part)
    else if (!ev.sub) this.parts.push(part)
    this.touch()
  }

  private result(ev: Ev) {
    const key = `${ev.sub || ''}:${ev.id}`
    const card = this.tools.get(key)
    if (!card) return void this.hidden.delete(key)
    card.state = ev.ok === false ? 'fail' : 'ok'
    card.res = String(ev.d ?? '').slice(0, RES_MAX)
    card.ms = Date.now() - card.t0
    this.touch()
  }

  /** Output of a delegated helper, shown inside its delegate card. */
  private subEvent(ev: Ev) {
    const card = this.tools.get(`:${ev.sub}`)
    if (!card) return
    if (ev.t === 'tool') this.tool(ev)
    else if (ev.t === 'result') this.result(ev)
    else if (ev.t === 'text') {
      card.note += ev.d
      this.touch()
    }
  }

  plan(steps: PlanStep[]) {
    this.content()
    this.closeCur()
    const have = this.parts.find((p) => p.k === 'plan')
    if (have) have.steps = steps
    else this.parts.push({ k: 'plan', id: ++seq, steps })
    this.touch()
  }

  setStatus(text: string, icon: string, shimmer: boolean, countdown?: { from: number; at: number }) {
    this.status = { text, icon, shimmer, countdown }
    this.touch()
  }

  private retrying(ev: Ev) {
    if (ev.reset && this.cur) {
      // a half-streamed reply is being redone: drop it
      this.parts.splice(this.parts.indexOf(this.cur), 1)
      this.cur = null
    }
    this.sawContent = false
    const left = Math.round(ev.in || 0)
    this.setStatus(ev.msg, 'refresh', false, { from: left, at: Date.now() })
  }

  notice(ev: Ev) {
    this.content()
    this.closeCur()
    this.parts.push({ k: 'notice', id: ++seq, kind: ev.kind, msg: ev.msg || 'Stopped.' })
    this.touch()
  }

  error(ev: Ev) {
    this.content()
    this.closeCur()
    this.parts.push({ k: 'error', id: ++seq, kind: ev.kind, msg: ev.msg || ev.d || 'Something went wrong.', rid: ev.rid, retryable: Boolean(ev.retryable), note: ev.note })
    this.touch()
  }

  /** "Try again" removes the error card it belongs to. */
  dropErrors() {
    this.parts = this.parts.filter((p) => p.k !== 'error')
    this.touch()
  }

  /** A line under the turn that is not an error (the visitor pressed Stop). */
  say(text: string) {
    this.parts.push({ k: 'notice', id: ++seq, kind: 'info', msg: text })
    this.touch()
  }

  end() {
    this.closeCur()
    this.status = null
    this.live = false
    this.touch()
  }

  /** The visible answer (reasoning left out): what Copy copies and what a visitor's history keeps. */
  answerText(): string {
    return this.parts
      .filter((p): p is Extract<Part, { k: 'text' }> => p.k === 'text')
      .map((p) => splitThink(p.raw).answer.trim())
      .filter(Boolean)
      .join('\n\n')
  }
}

// ---- saved chats -----------------------------------------------------------------------------------------------------------------
export type Att = { kind: 'image' | 'file'; name: string; url?: string; size?: number }
export type Item = { id: number; kind: 'user'; text: string; atts: Att[] } | { id: number; kind: 'turn'; turn: TurnModel }

// Documents are stored inside the text as <attached_file name="..."> blocks (what the model reads); the page shows chips instead.
const WRAP = /\n*<attached_file name="([^"]*)"[^>]*>\n[\s\S]*?\n<\/attached_file>/g
export function parseUserContent(content: unknown): { text: string; files: string[]; images: string[] } {
  const parts: Array<{ type?: string; text?: string; name?: string }> = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
  let text = ''
  const images: string[] = []
  for (const p of parts) {
    if (p.type === 'text') text += p.text ?? ''
    else if (p.type === 'image_ref') images.push(String(p.name).replace(/^uploads\//, ''))
  }
  const files: string[] = []
  text = text.replace(WRAP, (_, name) => (files.push(name), '')).trim()
  return { text, files, images }
}

const NOTE = /^\[run failed: [^\]]*\]\s*/
/** Saved messages (GET /api/sessions/:id) -> what the page shows. */
export function replay(list: any[], sid: number): Item[] {
  const items: Item[] = []
  let turn: TurnModel | null = null
  const cur = () => {
    if (!turn) {
      turn = new TurnModel(false)
      items.push({ id: ++seq, kind: 'turn', turn })
    }
    return turn
  }
  for (const m of list) {
    if (m.role === 'user') {
      turn = null
      const u = parseUserContent(m.content)
      const base = `/api/sessions/${sid}/uploads/`
      const atts: Att[] = [...u.images.map((n) => ({ kind: 'image' as const, name: n, url: base + encodeURIComponent(n) })), ...u.files.map((n) => ({ kind: 'file' as const, name: n, url: base + encodeURIComponent(n) }))]
      items.push({ id: ++seq, kind: 'user', text: u.text, atts })
    } else if (m.role === 'assistant') {
      if (m.note) {
        cur().notice({ kind: 'info', msg: 'A previous reply failed: ' + String(m.content).replace(NOTE, '') })
        continue
      }
      const t = cur()
      if (m.content) {
        t.event({ t: 'text', d: m.content })
        t.closeCur() // each saved message is its own text part
      }
      for (const tc of m.tool_calls ?? []) {
        let args: unknown
        try {
          args = JSON.parse(tc.function.arguments || '{}')
        } catch {
          args = tc.function.arguments
        }
        t.event({ t: 'tool', id: tc.id, name: tc.function.name, args })
        if (tc.function.name === 'update_plan' && (args as any)?.steps) t.plan(planSteps((args as any).steps))
      }
    } else if (m.role === 'tool') {
      cur().event({ t: 'result', id: m.tool_call_id, d: m.content, ok: !String(m.content).startsWith('error') })
    }
  }
  for (const it of items) if (it.kind === 'turn') it.turn.end()
  return items
}
