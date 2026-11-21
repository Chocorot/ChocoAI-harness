/**
 * Runtime settings. ONE table (FIELDS) drives validation, storage and the /manage manifest, so a new setting is one
 * row here and appears in the dashboard with no dashboard change. Overrides live in a JSON file next to the DB and are
 * re-read on every call: an edit applies from the next run, no restart.
 * Port of legacy/settings.py (same file format, same fields, same texts).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SYSTEM_PROMPT =
  "You are an agent working in a workspace directory. Complete the user's goal with the tools you are given. Rules: " +
  'read only the line ranges you need; ' +
  'prefer edit_file (exact unique old_text) over rewriting files; ' +
  'check your work; ' +
  'keep replies short; ' +
  'when done, reply with a brief summary and call no tools.'

export const PUBLIC_PROMPT =
  'You are a friendly, concise assistant on a public website. You cannot browse the web, run code or use tools. ' +
  'If asked to, say so briefly. Do not claim to remember earlier visits.'

export type FieldType = 'string' | 'text' | 'int' | 'float' | 'bool'
export interface Field {
  key: string
  label: string
  type: FieldType
  default: string | number | boolean | null
  /** An environment variable that supplies the default when set. */
  env?: string
  /** The default is "not sent to the backend". A null value resets a field to its default. */
  optional?: boolean
  min?: number
  max?: number
  help: string
}

export const FIELDS: Field[] = [
  { key: 'system_prompt', label: 'System prompt', type: 'text', default: SYSTEM_PROMPT, min: 1, max: 8000, help: 'Sent first in every run. Keep it short: the backend window is 16K tokens. Applies from the next run, also to resumed sessions.' },
  { key: 'model', label: 'Model', type: 'string', default: 'qwen/qwen3.6-35b-a3b', env: 'MODEL', min: 1, max: 200, help: 'Model id sent to the backend.' },
  { key: 'max_turns', label: 'Max turns per run', type: 'int', default: 15, min: 1, max: 100, help: 'Model calls before a run is stopped (a stopped session can be continued).' },
  { key: 'compact_at', label: 'Compact above (est. tokens)', type: 'int', default: 11000, min: 1000, max: 200000, help: 'Older tool traffic is shrunk above this estimate. Keep it below the backend window minus room for the reply.' },
  { key: 'keep_turns', label: 'Turns kept intact', type: 'int', default: 4, min: 1, max: 50, help: 'The last N turns are never shrunk by compaction.' },
  { key: 'max_seconds', label: 'Max seconds per run', type: 'int', default: 900, min: 1, max: 7200, help: 'Wall-clock budget of one run (including helpers). The run stops with a notice when it is used up.' },
  { key: 'max_run_tokens', label: 'Max tokens per run', type: 'int', default: 200000, min: 1000, max: 5000000, help: 'Prompt + reply tokens added up over every model call of a run (prompts are re-sent each turn).' },
  { key: 'delegate_turns', label: 'Max turns of a helper', type: 'int', default: 8, min: 1, max: 50, help: 'Model calls a delegated subtask may use before it must report back.' },
  { key: 'smart_titles', label: 'Model-written chat titles', type: 'bool', default: true, help: 'After the first answer of a new chat, ask the model for a short title (a few seconds of model time, queued behind live chats). Off = the title stays the first words of the first message.' },
  { key: 'max_automations', label: 'Max automations per user', type: 'int', default: 5, min: 0, max: 50, help: 'Scheduled prompts one signed-in user may keep. 0 switches creating new ones off.' },
  { key: 'min_interval_min', label: 'Shortest automation interval (minutes)', type: 'int', default: 15, min: 1, max: 1440, help: "A repeating automation can't run more often than this (each run occupies the one model)." },
  { key: 'retries', label: 'Auto-retries on model errors', type: 'int', default: 2, min: 0, max: 5, help: 'How often a run silently retries when the model server is down, errors or garbles a reply (waits 2s, 6s, 15s).' },
  { key: 'max_queue', label: 'Max runs waiting in line', type: 'int', default: 8, min: 0, max: 100, help: "One run executes at a time. More waiting than this gets a 'busy' answer." },
  { key: 'public_prompt', label: 'Public chat prompt', type: 'text', default: PUBLIC_PROMPT, min: 1, max: 4000, help: 'System prompt for visitors who are not signed in (chat only, no tools).' },
  { key: 'public_rpm', label: 'Public requests per minute (per IP)', type: 'int', default: 6, min: 1, max: 600, help: "Visitors above this get a 'too many requests' answer." },
  { key: 'max_queue_public', label: 'Public visitors allowed to wait', type: 'int', default: 2, min: 0, max: 100, help: 'Public visitors are refused (busy) when this many are already waiting, so signed-in users still get in.' },
  { key: 'public_max_chars', label: 'Public history size (characters)', type: 'int', default: 24000, min: 500, max: 200000, help: 'Older messages of a public chat are dropped above this size. The window is 16K tokens.' },
  { key: 'public_max_tokens', label: 'Public max reply tokens', type: 'int', default: 1024, min: 16, max: 32768, help: "Caps the length of a public reply so one visitor can't hold the model for minutes." },
  { key: 'vision', label: 'Photo input (vision)', type: 'bool', default: false, help: 'Let signed-in users attach a photo. Turn on only when the model on the backend can look at images (a vision model); otherwise it answers nonsense or errors.' },
  { key: 'temperature', label: 'Temperature', type: 'float', default: null, optional: true, min: 0, max: 2, help: 'Empty = backend default.' },
  { key: 'max_tokens', label: 'Max reply tokens', type: 'int', default: null, optional: true, min: 16, max: 131072, help: 'Empty = backend default.' },
]
const BY_KEY: Record<string, Field> = Object.fromEntries(FIELDS.map((f) => [f.key, f]))

type Value = string | number | boolean | null

export function settingsPath(env: Record<string, string | undefined> = process.env): string {
  if (env.HARNESS_SETTINGS) return env.HARNESS_SETTINGS
  return join(dirname(env.HARNESS_DB ?? 'harness.db') || '.', 'settings.json')
}

export function defaultOf(key: string, env: Record<string, string | undefined> = process.env): Value {
  const f = BY_KEY[key]!
  const fromEnv = f.env ? env[f.env] : undefined
  return fromEnv ? fromEnv : f.default
}

/** Error text, or null when v is a valid value for field f. */
export function check(f: Field, v: unknown): string | null {
  if (f.type === 'string' || f.type === 'text') {
    if (typeof v !== 'string') return 'must be text'
    if (v.trim().length < f.min! || v.length > f.max!) return `must have ${f.min} to ${f.max} characters`
    return null
  }
  if (f.type === 'bool') return typeof v === 'boolean' ? null : 'must be true or false'
  if (typeof v !== 'number') return 'must be a number'
  if (f.type === 'int' && !Number.isInteger(v)) return 'must be a whole number'
  if (!Number.isFinite(v) || v < f.min! || v > f.max!) return `must be between ${f.min} and ${f.max}`
  return null
}

function readFile(path = settingsPath()): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The override when it is present and still valid, else the default (a hand-edited bad file can never break a run). */
export function get<T extends Value = Value>(key: string): T {
  const v = readFile()[key]
  return (v !== undefined && v !== null && check(BY_KEY[key]!, v) === null ? v : defaultOf(key)) as T
}

export function current(): Record<string, Value> {
  return Object.fromEntries(FIELDS.map((f) => [f.key, get(f.key)]))
}

/** [clean, null] or [null, error]. All or nothing. A null value means "reset to default". */
export function validate(updates: unknown): [Record<string, unknown>, null] | [null, string] {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates) || Object.keys(updates).length === 0) return [null, 'settings must be a non-empty object']
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(updates)) {
    const f = BY_KEY[key]
    if (!f) return [null, `unknown setting: ${key}`]
    if (value !== null) {
      const err = check(f, value)
      if (err) return [null, `${key} ${err}`]
    }
    clean[key] = value
  }
  return [clean, null]
}

/** Validate, merge into the file (atomic replace, previous file kept as .bak). Returns [current values, null] or [null, error]. */
export function save(updates: unknown): [Record<string, Value>, null] | [null, string] {
  const [clean, err] = validate(updates)
  if (err !== null) return [null, err]
  const stored = readFile()
  for (const [key, value] of Object.entries(clean!)) {
    if (value === null) delete stored[key]
    else stored[key] = value
  }
  const p = settingsPath()
  mkdirSync(dirname(p) || '.', { recursive: true })
  if (existsSync(/*turbopackIgnore: true*/ p)) copyFileSync(/*turbopackIgnore: true*/ p, p + '.bak')
  const tmp = join(dirname(p) || '.', `.settings-${process.pid}-${Date.now()}`)
  try {
    writeFileSync(tmp, JSON.stringify(stored, null, 2))
    renameSync(tmp, p)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      // nothing to clean up
    }
    throw e
  }
  return [current(), null]
}

/** The settings block of GET /manage/manifest (the contract is in choc-node-agent docs/ai-gateway.md). */
export function manifest(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = FIELDS.map((f) => {
    const row: Record<string, unknown> = { key: f.key, label: f.label, type: f.type, help: f.help }
    if (f.min !== undefined) row.min = f.min
    if (f.max !== undefined) row.max = f.max
    row.value = get(f.key)
    row.default = defaultOf(f.key)
    row.optional = Boolean(f.optional)
    return row
  })
  out.push({ key: 'base_url', label: 'Backend URL', type: 'readonly', value: process.env.BASE_URL ?? 'http://localhost:1235/v1', help: 'Set by the BASE_URL environment variable (restart to change).' })
  return out
}
