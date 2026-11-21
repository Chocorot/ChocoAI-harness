/**
 * Typed failures. ONE table (KINDS) says how every failure looks to the user and to the model; fromUpstream() and
 * classify() map exceptions onto it. A new failure type is a new row here, no other code changes.
 * Port of legacy/errors.py (the golden test compares the table and the mappings with the Python output).
 */

export const NOTE_PREFIX = '[run failed: ' // marks the note saved in a session so the model knows its last reply failed

export interface KindRow {
  /** HTTP status for non-stream replies. */
  status: number
  /** The UI offers a Retry button. */
  retryable: boolean
  /** The harness itself retries. */
  auto: boolean
  /** Plain words for the user. */
  msg: string
  /** What the model is told so it can react. */
  hint: string
}

export const KINDS = {
  upstream_down: { status: 502, retryable: true, auto: true, msg: "The AI model server can't be reached right now.", hint: 'The model backend was unreachable. Nothing was lost; the user can retry.' },
  upstream_timeout: { status: 504, retryable: true, auto: false, msg: 'The model took too long to answer.', hint: 'The model backend timed out. Try a shorter or simpler step.' },
  upstream_5xx: { status: 502, retryable: true, auto: true, msg: 'The model server hit an error.', hint: 'The model backend returned a server error.' },
  upstream_4xx: { status: 502, retryable: false, auto: false, msg: 'The model server rejected the request.', hint: 'The model backend rejected the request as invalid.' },
  upstream_auth: { status: 502, retryable: false, auto: false, msg: 'The model server refused our credentials. The admin needs to fix the key.', hint: 'The model backend refused the harness credentials.' },
  upstream_bad_stream: { status: 502, retryable: true, auto: true, msg: "The model's reply was cut off or garbled.", hint: 'The model reply stream broke before it finished.' },
  context_overflow: { status: 413, retryable: false, auto: false, msg: 'This conversation is too long for the model. Start a new chat.', hint: 'The conversation exceeded the model context window even after shrinking old tool output.' },
  busy: { status: 503, retryable: true, auto: false, msg: 'The AI is busy with other requests. Try again in a moment.', hint: 'The run queue was full.' },
  rate_limited: { status: 429, retryable: true, auto: false, msg: 'Too many requests. Wait a moment and try again.', hint: 'The caller was rate limited.' },
  login_unavailable: { status: 503, retryable: true, auto: false, msg: 'Sign-in is unavailable right now. Try again shortly.', hint: '' },
  forbidden: { status: 403, retryable: false, auto: false, msg: "You don't have access to that.", hint: '' },
  bad_request: { status: 400, retryable: false, auto: false, msg: 'That request was not valid.', hint: '' },
  not_found: { status: 404, retryable: false, auto: false, msg: 'Not found.', hint: '' },
  auth: { status: 401, retryable: false, auto: false, msg: 'unauthorized', hint: '' },
  internal: { status: 500, retryable: true, auto: false, msg: 'Something broke inside the harness.', hint: 'An internal error stopped the run.' },
} as const satisfies Record<string, KindRow>

export type Kind = keyof typeof KINDS

export const BACKOFF = [2, 6, 15] // seconds before auto-retry 1, 2, 3...

// LM Studio / llama.cpp wording for a prompt that does not fit the window
export const OVERFLOW = /context (length|window|size|overflow)|n_ctx|too many tokens|maximum context|exceeds? the (available )?context|tokens to keep/i

/** A tool failed in a way the model can act on. tools.run turns it into `error[code]: message. hint`. */
export class ToolError extends Error {
  code: string
  hint: string
  constructor(code: string, message: string, hint = '') {
    super(message)
    this.name = 'ToolError'
    this.code = code
    this.hint = hint
  }
}

export class HarnessError extends Error {
  kind: Kind
  code: string
  detail: string
  status: number
  retryable: boolean
  auto: boolean
  hint: string

  constructor(kind: Kind, message?: string, opts: { code?: string; detail?: unknown } = {}) {
    const row: KindRow = KINDS[kind]
    super(message || row.msg)
    this.name = 'HarnessError'
    this.kind = kind
    this.code = opts.code ?? kind
    this.detail = opts.detail === undefined ? '' : String(opts.detail)
    this.status = row.status
    this.retryable = row.retryable
    this.auto = row.auto
    this.hint = row.hint
  }

  /** Text saved into the session so the model's next turn knows what happened. */
  note(): string {
    return `${NOTE_PREFIX}${this.kind}/${this.code}] ${this.message} ${this.hint}`.trim()
  }

  event(rid: string | null = null) {
    // `d` duplicates `msg` for older pages that only read `d`
    return { t: 'error', kind: this.kind, code: this.code, msg: this.message, d: this.message, retryable: this.retryable, detail: this.detail.slice(0, 300), rid, note: this.note() }
  }

  body(rid: string | null = null) {
    return { error: this.message, kind: this.kind, code: this.code, retryable: this.retryable, rid }
  }
}

/** The model backend answered with an HTTP error (thrown by model.ts with the bounded body text). */
export class UpstreamHttp extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`HTTP ${status}`)
    this.name = 'UpstreamHttp'
    this.status = status
    this.body = body
  }
}

/** The backend's own explanation (LM Studio puts the reason in the HTTP body). Bounded; never throws. */
function explain(raw: string): string {
  try {
    const err = (JSON.parse(raw) as { error?: unknown }).error
    if (err && typeof err === 'object') return String((err as { message?: unknown }).message ?? raw)
    return String(err || raw)
  } catch {
    return raw
  }
}

export function classify(e: unknown): HarnessError {
  if (e instanceof HarnessError) return e
  const name = e instanceof Error ? e.constructor.name : typeof e
  const text = e instanceof Error ? e.message : String(e)
  return new HarnessError('internal', undefined, { code: name, detail: `${name}: ${text}` })
}

/** Map an exception raised while talking to the model backend onto a HarnessError. */
export function fromUpstream(e: unknown): HarnessError {
  if (e instanceof HarnessError) return e
  if (e instanceof UpstreamHttp) {
    const body = explain(e.body.slice(0, 2000))
    const s = e.status
    const kind: Kind = s === 401 || s === 403 ? 'upstream_auth' : OVERFLOW.test(body) ? 'context_overflow' : s >= 500 || s === 429 ? 'upstream_5xx' : 'upstream_4xx'
    return new HarnessError(kind, undefined, { code: `http_${s}`, detail: body })
  }
  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return new HarnessError('upstream_timeout', undefined, { code: 'timeout', detail: e.message })
    if (e instanceof SyntaxError) return new HarnessError('upstream_bad_stream', undefined, { code: 'bad_json', detail: e.message })
    // fetch() wraps the socket error: TypeError("fetch failed", { cause: Error & { code } })
    const cause = (e as { cause?: { code?: string; message?: string } }).cause
    const code = cause?.code ?? (e as { code?: string }).code
    if (code === 'ECONNREFUSED') return new HarnessError('upstream_down', undefined, { code: 'refused', detail: e.message })
    if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || code === 'ETIMEDOUT') return new HarnessError('upstream_timeout', undefined, { code: 'timeout', detail: e.message })
    if (code || e instanceof TypeError) return new HarnessError('upstream_down', undefined, { code: (code ?? 'typeerror').toLowerCase(), detail: `${e.message}${cause?.message ? ': ' + cause.message : ''}` })
  }
  return classify(e)
}
