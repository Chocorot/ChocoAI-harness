/**
 * The agent: one run of a session (act, look, think again, until the model answers without a tool), the plan and helper tools,
 * budgets, failure notes, titles, and the start/resume of a session. Port of the agent part of legacy/harness.py.
 */
import * as attach from './attach.ts'
import * as db from './db.ts'
import type { Message } from './db.ts'
import * as errors from './errors.ts'
import { HarnessError } from './errors.ts'
import * as model from './model.ts'
import type { ChatFn, Emit } from './model.ts'
import * as settings from './settings.ts'
import * as tools from './tools.ts'
import { splitlines } from './web.ts'

export const DEFAULT_EFFORT = 'medium'
export const HELPER_PROMPT = ' You are a helper working on one subtask for another agent. Do only that task, then finish with a short summary (under 150 words) of what you found or did.'

// ---- prompts, titles, plan, public history ------------------------------------------------------------------------------------
/** The saved system prompt, one hint per tool this caller may use (allow=null: none), and the chat's effort hint. */
export function systemText(allow: string[] | null = null, effort?: string | null): string {
  return [settings.get<string>('system_prompt'), allow !== null ? tools.promptsFor(allow) : '', (effort && model.EFFORT[effort]?.hint) || ''].filter(Boolean).join(' ')
}

/** An instant chat title from the first message: first line, markdown and links reduced, cut at a word. */
export function shortTitle(text: string, limit = 48): string {
  const lines = splitlines(text || '').map((x) => x.trim()).filter(Boolean)
  let t = lines.length ? lines[0]!.replace(/https?:\/\/([^\s/]+)\S*/g, '$1') : ''
  t = t.replace(/[#*_`>~|[\]]+/g, '').replace(/\s+/g, ' ').trim()
  if ([...t].length > limit) {
    const head = [...t].slice(0, limit).join('')
    t = (head.includes(' ') ? head.slice(0, head.lastIndexOf(' ')) : head).replace(/[,.;:-]+$/, '') + '…'
  }
  return t || 'New chat'
}

/** A model's title reply reduced to a plain title, or "" when it is unusable. */
export function cleanTitle(text: string, limit = 60): string {
  const first = splitlines(text || '').find((x) => x.trim()) ?? ''
  let t = first.replace(/^\s*(title|chat title)\s*[:-]\s*/i, '')
  t = t.replace(/[#*_`>~|[\]"“”]+/g, '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '')
  return [...t].length >= 2 ? [...t].slice(0, limit).join('').trimEnd() : ''
}

/** Clean the model's plan: up to 20 steps of {text, status}. Plain strings are accepted as todo steps. */
export function planSteps(raw: unknown): Array<{ text: string; status: string }> {
  const out: Array<{ text: string; status: string }> = []
  for (const x of Array.isArray(raw) ? raw : []) {
    const obj = x && typeof x === 'object' && !Array.isArray(x)
    const text = obj ? (x as any).text : x
    const status = obj ? (x as any).status : null
    if (typeof text === 'string' && text.trim()) out.push({ text: [...text.trim()].slice(0, 200).join(''), status: ['todo', 'doing', 'done'].includes(status) ? status : 'todo' })
  }
  return out.slice(0, 20)
}

/** Drop the oldest messages until the history fits. Returns [kept, dropped]. The last message always stays. */
export function trimHistory(history: Array<{ role: string; content: string }>, maxChars: number): [Array<{ role: string; content: string }>, number] {
  const size = (h: Array<{ content: string }>) => h.reduce((n, m) => n + [...m.content].length, 0)
  const kept = [...history]
  while (kept.length > 1 && size(kept) > maxChars) kept.shift()
  while (kept.length && kept[0]!.role !== 'user') kept.shift() // a window must start with the user
  return [kept, history.length - kept.length]
}

// ---- a run -------------------------------------------------------------------------------------------------------------------------
interface Store {
  msg(m: Message): void
  usage(turn: number, usage: model.Usage, est: number): void
  tool(name: string, args: unknown, result: string): void
}

/** Where a session run saves its messages, token usage and tool audit rows. */
class DbStore implements Store {
  conn: db.Conn
  sid: number
  constructor(conn: db.Conn, sid: number) {
    this.conn = conn
    this.sid = sid
  }
  msg(m: Message) {
    db.saveMsg(this.conn, this.sid, m)
  }
  usage(turn: number, usage: model.Usage, est: number) {
    db.logUsage(this.conn, this.sid, turn, usage.prompt_tokens ?? null, usage.completion_tokens ?? null, est)
  }
  tool(name: string, args: unknown, result: string) {
    db.logTool(this.conn, this.sid, name, args, result)
  }
}

/** A helper's (delegate) conversation is thrown away; only its tool calls are audited, in the parent's session. */
class HelperStore implements Store {
  parent: Store
  constructor(parent: Store) {
    this.parent = parent
  }
  msg() {}
  usage() {}
  tool(name: string, args: unknown, result: string) {
    this.parent.tool(name, args, result)
  }
}

/** Everything one agent loop needs. A helper gets a copy with fewer tools and its own chat function. */
interface Run {
  store: Store
  ws: string
  emit: Emit
  allow: string[] | null
  chat: (m: Message[], e: Emit) => Promise<[Message, model.Usage]>
  deadline: number
  depth: number
  chatFor: (names: string[] | null) => Run['chat']
  ws2?: never
}

type ToolFn = (run: Run, callId: string, args: Record<string, any>) => Promise<string> | string

function toolUpdatePlan(run: Run, _id: string, args: Record<string, any>): string {
  const steps = planSteps(args.steps)
  if (!steps.length) return tools.err('bad_args', 'steps must be a non-empty list', 'send [{"text": "...", "status": "todo"}]')
  run.emit({ t: 'plan', steps })
  return `ok: plan has ${steps.length} steps, ${steps.filter((x) => x.status === 'done').length} done`
}

/** Run a subtask in a fresh context. Only its final summary comes back, so the parent's window stays small. */
async function toolDelegate(run: Run, callId: string, args: Record<string, any>): Promise<string> {
  const task = args.task
  if (typeof task !== 'string' || !task.trim()) return tools.err('bad_args', 'task must be text', 'describe the subtask in a sentence or two')
  const names = run.allow === null ? Object.keys(tools.TOOLS) : run.allow
  const allow = names.filter((n) => !tools.AGENT.has(n)) // helpers can't plan or delegate further
  const sub: Run = { store: new HelperStore(run.store), ws: run.ws, emit: (ev) => run.emit({ ...ev, sub: callId }), allow, chat: run.chatFor(allow), deadline: run.deadline, depth: run.depth + 1, chatFor: run.chatFor }
  const messages: Message[] = [{ role: 'system', content: systemText(allow) + HELPER_PROMPT }, { role: 'user', content: task.trim() }]
  let out: string
  try {
    out = await agentLoop(sub, messages, settings.get<number>('delegate_turns'))
  } catch (e) {
    if (e instanceof HarnessError) return tools.err('delegate_failed', e.message, 'do the subtask yourself or try again')
    throw e
  }
  return [...out].slice(0, 3000).join('') || '(the helper returned nothing)'
}

const AGENT_TOOLS: Record<string, ToolFn> = { update_plan: toolUpdatePlan, delegate: toolDelegate } // tools that need the run, see tools.AGENT

async function callTool(run: Run, tc: any): Promise<Message> {
  const name: string = tc.function.name
  run.emit({ t: 'status', phase: 'tool', name })
  let args: any
  let result: string
  try {
    args = JSON.parse(tc.function.arguments || '{}')
    run.emit({ t: 'tool', id: tc.id, name, args })
    if (!args || typeof args !== 'object' || Array.isArray(args)) result = tools.err('bad_args', 'arguments must be a JSON object', '')
    else if (tools.forbidden(name, run.allow)) result = tools.forbidden(name, run.allow)!
    else if (name in AGENT_TOOLS) result = await AGENT_TOOLS[name]!(run, tc.id, args)
    else result = await tools.run(name, args, run.ws, run.allow)
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    args = tc.function.arguments
    result = tools.err('bad_args', `invalid JSON arguments: ${e.message}`, 'resend the call with valid JSON')
    run.emit({ t: 'tool', id: tc.id, name, args })
  }
  run.emit({ t: 'result', id: tc.id, d: [...String(result)].slice(0, 2000).join(''), ok: !String(result).startsWith('error') })
  run.store.tool(name, args, result)
  return { role: 'tool', tool_call_id: tc.id, content: String(result) }
}

/** Act, look at the result, think again, until the model answers without tool calls. Returns the final text, or
 * `[stopped: ...]` when a budget (turns, seconds, tokens) ran out; that also emits a `notice` event. */
async function agentLoop(run: Run, messages: Message[], maxTurns: number): Promise<string> {
  let spent = 0
  const stop = (reason: string, msg: string) => {
    run.emit({ t: 'notice', kind: 'budget', reason, msg })
    return `[stopped: ${reason}]`
  }
  for (let turn = 0; turn < maxTurns; turn++) {
    if (Date.now() / 1000 > run.deadline) return stop(`max_seconds=${settings.get('max_seconds')} reached`, "Stopped: the time limit for one run was reached. Say 'continue' to go on.")
    if (spent > settings.get<number>('max_run_tokens')) return stop(`max_run_tokens=${settings.get('max_run_tokens')} reached`, "Stopped: the token limit for one run was reached. Say 'continue' to go on.")
    run.emit({ t: 'status', phase: 'model', turn: turn + 1, max: maxTurns })
    const [msg, usage, sent] = await model.callModel(messages, run.emit, run.chat, { prep: (m) => attach.expand(m, run.ws) })
    spent += (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) || model.estTokens(sent)
    run.store.usage(turn, usage, model.estTokens(sent))
    messages.push(msg)
    run.store.msg(msg)
    if (!msg.tool_calls?.length) return msg.content || ''
    for (const tc of msg.tool_calls) {
      const tm = await callTool(run, tc)
      messages.push(tm)
      run.store.msg(tm)
    }
  }
  return stop(`max_turns=${maxTurns} reached`, `Stopped after ${maxTurns} steps. Say 'continue' to go on.`)
}

/** A crash between an assistant message with tool calls and its tool results leaves calls without results, which
 * the backend rejects on resume. Add a stub result for each missing one (in memory and in the DB). */
export function repairTail(conn: db.Conn, sid: number, messages: Message[]): void {
  let i = messages.length
  while (i && messages[i - 1]!.role === 'tool') i--
  if (!i || !messages[i - 1]!.tool_calls) return
  const done = new Set(messages.slice(i).map((m) => m.tool_call_id))
  for (const tc of messages[i - 1]!.tool_calls) {
    if (!done.has(tc.id)) {
      const m: Message = { role: 'tool', tool_call_id: tc.id, content: tools.err('interrupted', 'the run stopped before this tool finished', 'call it again if it is still needed') }
      messages.push(m)
      db.saveMsg(conn, sid, m)
    }
  }
}

export interface RunOptions {
  maxTurns?: number | null
  /** The model function; tests pass a fake. */
  chat?: ChatFn
  emit?: Emit
  /** Tool names this caller may use (null = all). Enforced in the schemas sent AND when a call comes back. */
  allow?: string[] | null
  effort?: string | null
}

/** One run of a session. Returns the final text. Any failure is saved into the session as a note (so the model's next turn
 * knows) and thrown as a HarnessError. */
export async function runAgent(conn: db.Conn, sid: number, messages: Message[], ws: string, opts: RunOptions = {}): Promise<string> {
  const { chat = model.chat, emit = () => {}, allow = null, effort = null } = opts
  const maxTurns = opts.maxTurns || settings.get<number>('max_turns') // an explicit value wins over the saved setting
  const chatFor = (names: string[] | null): Run['chat'] => {
    const schemas = names === null ? null : tools.schemasFor(names)
    return (m, e) => chat(m, e, schemas, null, effort)
  }
  const run: Run = { store: new DbStore(conn, sid), ws, emit, allow, chat: chatFor(allow), deadline: Date.now() / 1000 + settings.get<number>('max_seconds'), depth: 0, chatFor }
  try {
    return await agentLoop(run, messages, maxTurns)
  } catch (e) {
    const err = errors.classify(e)
    repairTail(conn, sid, messages) // keep the history valid before the note goes in
    const note: Message = { role: 'assistant', content: err.note() }
    messages.push(note)
    run.store.msg(note)
    throw err
  }
}

/** Stateless chat for visitors: nothing is stored here, the page keeps the history. No tools. A failure is thrown as a
 * HarnessError whose `note()` the page keeps in its history, like the saved note of a signed-in session. */
export async function runPublic(history: Array<{ role: string; content: string }>, emit: Emit, opts: { chat?: ChatFn; effort?: string | null } = {}): Promise<string> {
  const chat = opts.chat ?? model.chat
  const system = [settings.get<string>('public_prompt'), (opts.effort && model.EFFORT[opts.effort]?.hint) || ''].filter(Boolean).join(' ')
  const [msg] = await model.callModel([{ role: 'system', content: system }, ...history], emit, (m, e) => chat(m, e, [], settings.get<number>('public_max_tokens'), opts.effort))
  return msg.content || ''
}

/**
 * Create or resume a session, add the goal as a user message. Returns [sid, messages].
 * `retry` removes the failure note of the last run so the model simply continues where it stopped.
 * `title` names the chat for good (jobs); otherwise it starts as shortTitle(goal) and the model may improve it later.
 * `effort` is this chat's thinking level; null keeps the chat's saved one (new chats: medium).
 */
export function start(
  conn: db.Conn,
  goal: string | null,
  session: number | null,
  opts: { retry?: boolean; allow?: string[] | null; content?: unknown; title?: string | null; effort?: string | null } = {},
): [number, Message[]] {
  const { retry = false, allow = null, content, title = null } = opts
  let effort = opts.effort ?? null
  let sid: number
  let messages: Message[]
  if (session) {
    if (!db.sessionExists(conn, session)) throw new HarnessError('not_found', `no such session: ${session}`)
    sid = session
    messages = db.load(conn, sid)
    const last = messages[messages.length - 1]
    if (retry && last && last.role === 'assistant' && String(last.content ?? '').startsWith(errors.NOTE_PREFIX)) {
      messages.pop()
      db.dropLast(conn, sid)
    }
    repairTail(conn, sid, messages)
    const stored = db.getSession(conn, sid)!.effort
    effort = effort || stored || DEFAULT_EFFORT
    if (effort !== stored) db.setEffort(conn, sid, effort)
    if (messages.length && messages[0]!.role === 'system') messages[0] = { role: 'system', content: systemText(allow, effort) } // a saved prompt edit applies to resumed sessions too
  } else {
    effort = effort || DEFAULT_EFFORT
    sid = db.newSession(conn, goal, title || shortTitle(goal ?? ''), title ? 2 : 0, effort)
    messages = [{ role: 'system', content: systemText(allow, effort) }]
    db.saveMsg(conn, sid, messages[0]!)
  }
  if (goal) {
    messages.push({ role: 'user', content: content !== undefined ? content : goal })
    db.saveMsg(conn, sid, messages[messages.length - 1]!)
  }
  return [sid, messages]
}
