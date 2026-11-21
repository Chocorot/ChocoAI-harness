/**
 * Things that live as long as the server process: the run queue, throttles, which runs are executing, the scheduler.
 * Kept on globalThis so every route handler (and the instrumentation hook) shares ONE instance, however Next bundles them.
 */
import { resolve } from 'node:path'
import * as agent from '../core/agent.ts'
import * as attach from '../core/attach.ts'
import { MODES, Throttle, dbPath, sessionWs } from '../core/auth.ts'
import { Scheduler } from '../core/automations.ts'
import * as db from '../core/db.ts'
import * as errors from '../core/errors.ts'
import * as model from '../core/model.ts'
import { RunQueue } from '../core/runq.ts'
import * as settings from '../core/settings.ts'

export const VERSION = '1.0.0'

/** Tests replace the model (the real one needs a backend). Chats, titles and scheduled runs all use it. */
export const deps = { chat: model.chat as model.ChatFn }

interface Shared {
  queue: RunQueue
  publicHits: Throttle
  /** `${address}#${session id}` of runs that are executing now, so a page that came back can tell. */
  active: Set<string>
  scheduler: Scheduler
}

const g = globalThis as unknown as { __harness?: Shared }

/** Where session workspaces live. */
export const workspace = (): string => resolve(/*turbopackIgnore: true*/ process.env.HARNESS_WORKSPACE ?? 'workspace')
export const activeKey = (address: string | null, sid: number): string => `${address ?? ''}#${sid}`

const plain = (m: db.Message): string => (Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? '').join('') : m.content ?? '')

export function shared(): Shared {
  if (g.__harness) return g.__harness
  const queue = new RunQueue(() => settings.get<number>('max_queue')) // one agent run at a time: the local model serves one stream
  const active = new Set<string>()

  /** One scheduled run as `owner`: a new saved chat titled with the job's name. Unattended jobs read web pages, so they never
   * get the shell, even when the owner has it. Returns [status text, session id]. */
  const runAutomation = async (owner: string, name: string, prompt: string): Promise<[string, number | null]> => {
    const mode = MODES['user'] // jobs never get the shell, whatever the owner's mode
    const allow = mode.tools.filter((t) => t !== 'run_bash')
    const conn = db.connect(dbPath(owner))
    let sid: number | null = null
    try {
      await queue.slot({ prio: mode.prio + 0.5 }, async () => {
        const [s, messages] = agent.start(conn, prompt, null, { allow, title: '⏰ ' + name })
        sid = s
        active.add(activeKey(owner, s))
        try {
          await agent.runAgent(conn, s, messages, sessionWs(workspace(), owner, s), { maxTurns: null, allow, chat: deps.chat })
        } finally {
          active.delete(activeKey(owner, s))
        }
      })
      return ['ok', sid]
    } catch (e) {
      if (e instanceof errors.HarnessError) return [`${e.kind}: ${e.message}`, sid]
      throw e
    } finally {
      conn.close()
    }
  }

  g.__harness = { queue, publicHits: new Throttle(), active, scheduler: new Scheduler(runAutomation) }
  return g.__harness
}

/** Ask the model for a short title after the first answer of a new chat. Queued behind live chats; a title is a nicety,
 * so any failure just leaves the automatic one. */
export async function smartTitle(address: string, sid: number, chat: model.ChatFn = deps.chat): Promise<void> {
  if (!settings.get('smart_titles')) return
  const conn = db.connect(dbPath(address))
  try {
    const info = db.getSession(conn, sid)
    if (!info || info.titleState !== 0) return
    const msgs = db.load(conn, sid).filter((m) => (m.role === 'user' || m.role === 'assistant') && !plain(m).startsWith(errors.NOTE_PREFIX))
    const firstUser = plain(msgs.find((m) => m.role === 'user') ?? {})
    const firstAi = plain(msgs.find((m) => m.role === 'assistant' && plain(m).trim()) ?? {})
    if (!firstUser || !firstAi) return
    const ask = [
      { role: 'system', content: 'You write very short titles for chat conversations.' },
      { role: 'user', content: `Write a title of at most 6 words for this conversation. Reply with only the title: no quotes, no full stop.\n\nUser: ${[...firstUser].slice(0, 400).join('')}\nAssistant: ${[...firstAi].slice(0, 400).join('')}` },
    ]
    const [msg] = await shared().queue.slot({ prio: MODES.user.prio + 0.5, limit: 2 }, () => chat(ask, () => {}, [], 60, 'low'))
    const title = agent.cleanTitle(msg.content || '')
    if (title && title.toLowerCase() !== info.title.toLowerCase()) db.rename(conn, sid, title, 1)
  } catch {
    // leave the automatic title
  } finally {
    conn.close()
  }
}

export { attach }
