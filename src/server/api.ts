/**
 * Every HTTP endpoint of the harness as plain `(Request) => Response` functions. The route files under src/app only wire URLs
 * to these, so the whole API can be tested without starting Next. Same endpoints, bodies and errors as the Python server
 * (docs/auth-and-modes.md, chat-streaming.md, chats.md, automations.md).
 */
import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as attach from '../core/attach.ts'
import { MODES, dbPath, sessionWs, type Mode } from '../core/auth.ts'
import * as automations from '../core/automations.ts'
import * as db from '../core/db.ts'
import * as errors from '../core/errors.ts'
import { HarnessError } from '../core/errors.ts'
import * as model from '../core/model.ts'
import * as settings from '../core/settings.ts'
import { publicChat, runSession } from './chat.ts'
import { ATTACH_BODY, bearerOk, guarded, json, MAX_BODY, needUser, readJson, sameOrigin, who } from './http.ts'
import { manifest } from './manifest.ts'
import { SESSION_COOKIE } from './session.ts'
import { ssoConfig } from './sso.ts'
import { activeKey, shared, workspace } from './state.ts'

/** Run `fn` against the signed-in caller's own DB file (another user's rows are not even reachable). */
async function withUserDb<T>(req: Request, fn: (conn: db.Conn, address: string) => T): Promise<T> {
  const address = await needUser(req)
  const conn = db.connect(dbPath(address))
  try {
    return fn(conn, address)
  } finally {
    conn.close()
  }
}

const ok = () => json({ ok: true })

// ---- identity ---------------------------------------------------------------------------------------------------------------
export const me = (req: Request) =>
  guarded(async () => {
    const { mode, address } = await who(req)
    const rule = MODES[mode]
    const user = rule.store === 'user'
    return json({
      mode,
      address,
      capabilities: {
        login: ssoConfig() !== null,
        tools: rule.tools,
        shell: rule.tools.includes('run_bash'),
        history: rule.store,
        effort: { default: 'medium', levels: Object.entries(model.EFFORT).map(([id, v]) => ({ id, label: v.label, desc: v.desc })) },
        automations: user && settings.get<number>('max_automations') > 0,
        timezone: process.env.HARNESS_TZ || 'UTC',
        attachments: { image: user && Boolean(settings.get('vision')), documents: user ? Object.keys(attach.READERS).sort() : [] },
      },
    })
  })

export const logout = (req: Request) =>
  guarded(async () => {
    sameOrigin(req)
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
    return json({ ok: true }, 200, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}` })
  })

export const health = () => json({ ok: true })

// ---- saved chats --------------------------------------------------------------------------------------------------------------
export const sessionsList = (req: Request) => guarded(async () => json({ sessions: await withUserDb(req, (conn) => db.listSessions(conn, 100)) }))

const sidOf = (raw: string): number => {
  if (!/^\d+$/.test(raw)) throw new HarnessError('not_found')
  return Number(raw)
}

export const sessionGet = (req: Request, rawId: string) =>
  guarded(async () => {
    const sid = sidOf(rawId)
    const address = await needUser(req)
    const conn = db.connect(dbPath(address))
    try {
      if (!db.sessionExists(conn, sid)) throw new HarnessError('not_found')
      const messages = db
        .load(conn, sid)
        .filter((m) => m.role !== 'system')
        .map((m) => (typeof m.content === 'string' && m.content.startsWith(errors.NOTE_PREFIX) ? { ...m, note: true } : m))
      const info = db.getSession(conn, sid)!
      return json({ id: sid, running: shared().active.has(activeKey(address, sid)), title: info.title, effort: info.effort || 'medium', messages })
    } finally {
      conn.close()
    }
  })

/** Rename a chat and/or set its thinking effort. A name typed here is never replaced by an automatic one. */
export const sessionPatch = (req: Request, rawId: string) =>
  guarded(async () => {
    const sid = sidOf(rawId)
    sameOrigin(req)
    await needUser(req)
    const body = await readJson(req)
    let { title } = body
    const { effort } = body
    if ((title === undefined || title === null) && (effort === undefined || effort === null)) throw new HarnessError('bad_request', 'Nothing to change.')
    if (title !== undefined && title !== null) {
      title = typeof title === 'string' ? title.split(/\s+/).filter(Boolean).join(' ') : ''
      if (![...title].length || [...title].length > 80) throw new HarnessError('bad_request', 'A title needs 1 to 80 characters.')
    }
    if (effort !== undefined && effort !== null && !(effort in model.EFFORT)) throw new HarnessError('bad_request', 'effort must be one of: ' + Object.keys(model.EFFORT).join(', '))
    return json(
      await withUserDb(req, (conn) => {
        if (!db.sessionExists(conn, sid)) throw new HarnessError('not_found')
        if (title !== undefined && title !== null) db.rename(conn, sid, title, 2)
        if (effort !== undefined && effort !== null) db.setEffort(conn, sid, effort)
        return { id: sid, ...db.getSession(conn, sid)! }
      }),
    )
  })

export const sessionDelete = (req: Request, rawId: string) =>
  guarded(async () => {
    sameOrigin(req)
    const sid = sidOf(rawId)
    const address = await needUser(req)
    await withUserDb(req, (conn) => {
      if (!db.sessionExists(conn, sid)) throw new HarnessError('not_found')
      db.deleteSession(conn, sid)
    })
    rmSync(sessionWs(workspace(), address, sid, false), { recursive: true, force: true })
    return ok()
  })

/** A file the owner attached to one of their own chats (photo thumbnails in the page, document downloads). */
export const uploadGet = (req: Request, rawId: string, name: string) =>
  guarded(async () => {
    const sid = sidOf(rawId)
    if (!/^\w[\w.-]{0,99}$/.test(name)) throw new HarnessError('not_found')
    const address = await needUser(req)
    await withUserDb(req, (conn) => {
      if (!db.sessionExists(conn, sid)) throw new HarnessError('not_found')
    })
    const f = join(sessionWs(workspace(), address, sid, false), 'uploads', name)
    try {
      if (!statSync(f).isFile()) throw new Error('not a file')
    } catch {
      throw new HarnessError('not_found')
    }
    const kind = attach.IMAGE_MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()]
    return new Response(readFileSync(f), {
      status: 200,
      headers: {
        'Content-Type': kind ?? 'application/octet-stream',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'same-origin',
        'X-Frame-Options': 'DENY',
        ...(kind ? {} : { 'Content-Disposition': `attachment; filename="${name}"` }),
      },
    })
  })

// ---- running the model ---------------------------------------------------------------------------------------------------------
export const chat = (req: Request) =>
  guarded(async (rid) => {
    sameOrigin(req)
    const w = await who(req)
    const body = await readJson(req, w.address ? ATTACH_BODY : MAX_BODY)
    if (w.mode === 'public') return publicChat(req, body, rid)
    return runSession(req, body, w.mode, w.address, body.stream !== false, rid)
  })

/** Admin only (bearer HARNESS_TOKEN). No token set = the endpoint does not exist (404): it runs shell commands. */
export const task = (req: Request) =>
  guarded(async (rid) => {
    const token = process.env.HARNESS_TOKEN
    if (!token) throw new HarnessError('not_found')
    if (!bearerOk(req, token)) throw new HarnessError('auth')
    const body = await readJson(req)
    return runSession(req, body, 'admin' as Mode, null, Boolean(body.stream), rid)
  })

// ---- automations (the caller's own scheduled prompts) -----------------------------------------------------------------------------
export const automationsApi = (req: Request, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', rawId?: string, run = false) =>
  guarded(async () => {
    if (method !== 'GET') sameOrigin(req)
    const address = await needUser(req)
    const aid = rawId === undefined ? null : sidOf(rawId)
    const conn = db.connect(dbPath(address))
    try {
      const now = Date.now() / 1000
      if (aid === null) {
        if (method === 'GET') return json({ automations: automations.listing(conn) })
        if (method === 'POST') return json(automations.create(conn, address, await readJson(req), now))
        throw new HarnessError('not_found')
      }
      if (method === 'PATCH' && !run) return json(automations.update(conn, aid, await readJson(req), now))
      if (method === 'DELETE' && !run) {
        automations.remove(conn, aid)
        return ok()
      }
      if (method === 'POST' && run) {
        automations.get(conn, aid)
        if (!shared().scheduler.runNow(address, aid)) throw new HarnessError('bad_request', 'That automation is already running.')
        return ok()
      }
      throw new HarnessError('not_found')
    } finally {
      conn.close()
    }
  })

// ---- admin API for the dashboard (via the node agent): its own token, independent of /task. No token set = no API. ---------------------------
export const manage = (req: Request, what: 'manifest' | 'sessions' | 'errors' | 'settings') =>
  guarded(async () => {
    const token = process.env.HARNESS_ADMIN_TOKEN
    if (!token) return json({ error: 'not found' }, 404)
    if (!bearerOk(req, token)) return json({ error: 'unauthorized' }, 401)
    const method = req.method
    if (what === 'manifest' && method === 'GET') return json(manifest())
    if ((what === 'sessions' || what === 'errors') && method === 'GET') {
      const raw = new URL(req.url).searchParams.get('limit') ?? '50'
      if (!/^-?\d+$/.test(raw)) return json({ error: 'limit must be a number' }, 400)
      const limit = Math.max(1, Math.min(200, Number(raw)))
      const conn = db.connect()
      try {
        return json(what === 'errors' ? { errors: db.listErrors(conn, limit) } : { sessions: db.listSessions(conn, limit) })
      } finally {
        conn.close()
      }
    }
    if (what === 'settings' && method === 'PUT') {
      let body: unknown
      try {
        body = JSON.parse(await req.text())
      } catch {
        return json({ error: 'body must be JSON' }, 400)
      }
      const [, err] = settings.save(body && typeof body === 'object' ? (body as { settings?: unknown }).settings : null)
      return err ? json({ error: err }, 400) : json(manifest())
    }
    return json({ error: 'not found' }, 404)
  })
