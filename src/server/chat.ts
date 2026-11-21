/** Running the model for a request: a session run (admin or signed-in user) and the stateless public chat. */
import * as agent from '../core/agent.ts'
import * as attach from '../core/attach.ts'
import { MODES, dbPath, sessionWs, type Mode } from '../core/auth.ts'
import * as db from '../core/db.ts'
import * as errors from '../core/errors.ts'
import { HarnessError } from '../core/errors.ts'
import * as model from '../core/model.ts'
import * as settings from '../core/settings.ts'
import { clientIp, json, logError, MAX_BODY } from './http.ts'
import { ClientGone, keepaliveSeconds, openSse } from './sse.ts'
import { activeKey, deps, shared, smartTitle, workspace } from './state.ts'

const badEffort = () => new HarnessError('bad_request', 'effort must be one of: ' + Object.keys(model.EFFORT).join(', '))

/** A session run for a caller with storage: admin (the original DB) or a signed-in user (their own DB). */
export async function runSession(req: Request, body: Record<string, any>, mode: Mode, address: string | null, stream: boolean, rid: string): Promise<Response> {
  const rule = MODES[mode]
  let goal = body.goal
  const session = body.session
  const retry = Boolean(body.retry)
  const effort = body.effort
  if (effort !== undefined && effort !== null && !(effort in model.EFFORT)) throw badEffort()
  const atts = body.attachments
  if (atts && !address) throw new HarnessError('bad_request', 'Attachments need a signed-in account.')
  if (atts && !goal) goal = 'Please look at the attached file.'
  if (!goal && !session) throw new HarnessError('bad_request', 'goal or session required')
  if (session !== undefined && session !== null && (typeof session === 'boolean' || !Number.isInteger(session))) throw new HarnessError('bad_request', 'session must be a number')
  if (goal !== undefined && goal !== null && (typeof goal !== 'string' || goal.length > MAX_BODY)) throw new HarnessError('bad_request', 'goal must be text')
  const processed = attach.process_(atts, Boolean(settings.get('vision'))) // validated before anything is created
  const path = address ? dbPath(address) : undefined // undefined = the original (admin) DB
  if (session) {
    // answer 404 as plain HTTP, before an event stream is opened
    const conn = db.connect(path)
    try {
      if (!db.sessionExists(conn, session)) throw new HarnessError('not_found', `no such session: ${session}`)
    } finally {
      conn.close()
    }
  }
  const { queue, active } = shared()
  const sse = stream ? openSse() : null
  const emit: model.Emit = sse ? sse.emit : () => {}
  let sid: number | null = null
  let reply = ''

  const go = async () => {
    await queue.slot(
      {
        prio: rule.prio,
        tick: keepaliveSeconds(),
        onWait: (ahead) => {
          if (sse && !sse.alive()) throw new ClientGone()
          emit({ t: 'queued', pos: ahead })
        },
      },
      async () => {
        const conn = db.connect(path)
        try {
          const [s, messages] = agent.start(conn, goal ?? null, session ?? null, { retry, allow: rule.tools, content: attach.content(goal ?? '', processed.docText, processed.images), effort: effort ?? null })
          sid = s
          emit({ t: 'session', id: s })
          const runWs = address ? sessionWs(workspace(), address, s) : workspace()
          attach.save(runWs, [...processed.images, ...processed.saves])
          active.add(activeKey(address, s))
          try {
            reply = await agent.runAgent(conn, s, messages, runWs, { allow: rule.tools, emit, chat: deps.chat, effort: db.getSession(conn, s)!.effort })
          } finally {
            active.delete(activeKey(address, s))
          }
          emit({ t: 'done' })
        } finally {
          conn.close()
        }
      },
    )
    if (address && !session && reply && !reply.startsWith('[stopped')) void smartTitle(address, sid!, deps.chat) // first answer of a new chat: name it
  }

  if (!sse) {
    await go()
    return json({ session: sid, reply })
  }
  // The run is detached from the request: the browser leaving must not stop it (a started run always finishes and saves every step).
  void go()
    .catch((e) => {
      if (e instanceof ClientGone) return
      const err = errors.classify(e)
      if (err.kind === 'internal') console.error(e)
      logError(rid, sid, err)
      sse.emit(err.event(rid))
    })
    .finally(() => sse.close())
  return sse.response
}

/** Visitors: chat only, history kept by the page, rate limited, short line, capped reply. */
export async function publicChat(req: Request, body: Record<string, any>, rid: string): Promise<Response> {
  const msgs = body.messages
  const cap = settings.get<number>('public_max_chars')
  if (!Array.isArray(msgs) || msgs.length < 1 || msgs.length > 200) throw new HarnessError('bad_request', 'messages must be a list of 1 to 200 items.')
  const clean: Array<{ role: string; content: string }> = []
  for (const m of msgs) {
    if (!m || typeof m !== 'object' || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) throw new HarnessError('bad_request', 'Each message needs a role (user or assistant) and text.')
    clean.push({ role: m.role, content: m.content })
  }
  if (clean[clean.length - 1]!.role !== 'user') throw new HarnessError('bad_request', 'The last message must come from the user.')
  const effort = body.effort
  if (effort !== undefined && effort !== null && !(effort in model.EFFORT)) throw badEffort()
  if ([...clean[clean.length - 1]!.content].length > cap) throw new HarnessError('bad_request', 'That message is too long.')
  const { queue, publicHits } = shared()
  if (!publicHits.allow(clientIp(req), settings.get<number>('public_rpm'), 60)) throw new HarnessError('rate_limited')
  const [kept, dropped] = agent.trimHistory(clean, cap)
  const sse = openSse()
  void (async () => {
    if (dropped) sse.emit({ t: 'trimmed', dropped })
    await queue.slot(
      {
        prio: MODES.public.prio,
        tick: keepaliveSeconds(),
        limit: settings.get<number>('max_queue_public'),
        onWait: (ahead) => {
          if (!sse.alive()) throw new ClientGone()
          sse.emit({ t: 'queued', pos: ahead })
        },
      },
      async () => {
        await agent.runPublic(kept, sse.emit, { chat: deps.chat, effort: effort ?? null })
        sse.emit({ t: 'done' })
      },
    )
  })()
    .catch((e) => {
      if (e instanceof ClientGone) return
      const err = errors.classify(e)
      if (err.kind === 'internal') console.error(e)
      logError(rid, null, err)
      sse.emit(err.event(rid))
    })
    .finally(() => sse.close())
  return sse.response
}
