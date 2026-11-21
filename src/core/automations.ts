/**
 * Scheduled prompts. A job = name + prompt + schedule (plain data), stored in its owner's own DB. One scheduler timer wakes
 * every 30 s and runs what is due through the normal run queue, so a job never jumps ahead of a live chat for the model.
 * The outcome is a saved chat in the owner's list plus `last_status`. A job runs at most once per due time: next_run is moved
 * forward BEFORE it runs, so a crash can't make it loop. Port of legacy/automations.py.
 */
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dbPath } from './auth.ts'
import * as db from './db.ts'
import { HarnessError } from './errors.ts'
import * as settings from './settings.ts'

const KINDS = ['interval', 'daily'] // the schedule kinds; a new kind = a branch in nextRun() and cleanSchedule()
const AT = /^([01]\d|2[0-3]):[0-5]\d$/
const NAME_MAX = 60
const PROMPT_MAX = 2000
const EVERY_MAX = 10080 // minutes (one week)
export const TICK = 30 // seconds

const bad = (msg: string) => new HarnessError('bad_request', msg)

export type Schedule = { kind: 'interval'; every_min: number } | { kind: 'daily'; at: string }

// ---- time zones (HARNESS_TZ), daylight saving follows the zone -------------------------------------------------------------------
function zone(): string {
  const name = process.env.HARNESS_TZ || 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return name
  } catch {
    return 'UTC' // an unknown zone, or an image without a tz database, falls back instead of crashing
  }
}

interface Wall {
  y: number
  m: number
  d: number
  h: number
  mi: number
}

function wallOf(epochMs: number, tz: string): Wall & { s: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(epochMs))
  const v = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  return { y: v('year'), m: v('month'), d: v('day'), h: v('hour'), mi: v('minute'), s: v('second') }
}

/** The zone's UTC offset in ms at an instant. */
function offsetAt(epochMs: number, tz: string): number {
  const w = wallOf(Math.floor(epochMs / 1000) * 1000, tz)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(epochMs / 1000) * 1000
}

/**
 * Epoch ms of a wall-clock time in a zone, with Python's datetime rules (fold=0): a time that does not exist (spring forward)
 * uses the offset from before the change; a time that happens twice (fall back) is the first one.
 */
function wallToEpoch(w: Wall, tz: string): number {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi)
  const before = offsetAt(guess - 86_400_000, tz)
  const after = offsetAt(guess + 86_400_000, tz)
  if (before === after) return guess - before
  const c1 = guess - before
  const c2 = guess - after
  if (offsetAt(c1, tz) === before) return c1
  return offsetAt(c2, tz) === after ? c2 : c1
}

export function cleanSchedule(s: unknown): Schedule {
  const o = s as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || !KINDS.includes(o.kind as string)) throw bad("schedule.kind must be 'interval' or 'daily'.")
  if (o.kind === 'interval') {
    const n = o.every_min
    const low = settings.get<number>('min_interval_min')
    if (typeof n !== 'number' || !Number.isInteger(n) || n < low || n > EVERY_MAX) throw bad(`Repeat every ${low} to ${EVERY_MAX} minutes.`)
    return { kind: 'interval', every_min: n }
  }
  if (typeof o.at !== 'string' || !AT.test(o.at)) throw bad('Daily time must look like 08:30.')
  return { kind: 'daily', at: o.at }
}

/** Epoch seconds of the next run after `now`. Daily times are wall-clock in HARNESS_TZ (daylight saving follows the zone). */
export function nextRun(s: Schedule, now: number): number {
  if (s.kind === 'interval') return now + s.every_min * 60
  const tz = zone()
  const [h, mi] = s.at.split(':').map(Number) as [number, number]
  const local = wallOf(now * 1000, tz)
  let at = wallToEpoch({ y: local.y, m: local.m, d: local.d, h, mi }, tz) / 1000
  if (at <= now) {
    const t = new Date(Date.UTC(local.y, local.m - 1, local.d + 1))
    at = wallToEpoch({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h, mi }, tz) / 1000
  }
  return at
}

// ---- storage (the owner's own DB) -----------------------------------------------------------------------------------------------
export interface Automation {
  id: number
  name: string
  prompt: string
  schedule: Schedule
  enabled: boolean
  nextRun: number | null
  lastRun: number | null
  lastStatus: string | null
  lastSession: number | null
}

const COLS = 'id, name, prompt, schedule, enabled, next_run, last_run, last_status, last_session'
type Row = [number, string, string, string, number, number | null, number | null, string | null, number | null]
const row = (r: Row): Automation => ({ id: r[0], name: r[1], prompt: r[2], schedule: JSON.parse(r[3]), enabled: Boolean(r[4]), nextRun: r[5], lastRun: r[6], lastStatus: r[7], lastSession: r[8] })

export const listing = (conn: db.Conn): Automation[] => (conn.prepare(`SELECT ${COLS} FROM automations ORDER BY id`).raw().all() as Row[]).map(row)

export function get(conn: db.Conn, aid: number): Automation {
  const r = conn.prepare(`SELECT ${COLS} FROM automations WHERE id=?`).raw().get(aid) as Row | undefined
  if (!r) throw new HarnessError('not_found')
  return row(r)
}

function text(body: Record<string, unknown>, key: string, limit: number): string {
  const v = body[key]
  if (typeof v !== 'string' || !v.trim() || v.trim().length > limit) throw bad(`${key[0]!.toUpperCase()}${key.slice(1)} must be 1 to ${limit} characters.`)
  return v.trim()
}

export function create(conn: db.Conn, owner: string, body: Record<string, unknown>, now: number): Automation {
  const name = text(body, 'name', NAME_MAX)
  const prompt = text(body, 'prompt', PROMPT_MAX)
  const sched = cleanSchedule(body.schedule)
  const cap = settings.get<number>('max_automations')
  if ((conn.prepare('SELECT COUNT(*) FROM automations').pluck().get() as number) >= cap) throw bad(`You can have at most ${cap} automations. Delete one first.`)
  const r = conn.prepare('INSERT INTO automations(owner, name, prompt, schedule, enabled, next_run, created) VALUES(?,?,?,?,1,?,?)').run(owner, name, prompt, JSON.stringify(sched), nextRun(sched, now), now)
  return get(conn, Number(r.lastInsertRowid))
}

export function update(conn: db.Conn, aid: number, body: Record<string, unknown>, now: number): Automation {
  const cur = get(conn, aid)
  if (!body || typeof body !== 'object' || Object.keys(body).length === 0) throw bad('Nothing to change.')
  const name = 'name' in body ? text(body, 'name', NAME_MAX) : cur.name
  const prompt = 'prompt' in body ? text(body, 'prompt', PROMPT_MAX) : cur.prompt
  const sched = 'schedule' in body ? cleanSchedule(body.schedule) : cur.schedule
  if ('enabled' in body && typeof body.enabled !== 'boolean') throw bad('enabled must be true or false.')
  const enabled = 'enabled' in body ? (body.enabled as boolean) : cur.enabled
  const changed = JSON.stringify(sched) !== JSON.stringify(cur.schedule)
  const nxt = changed || (enabled && !cur.enabled) ? nextRun(sched, now) : cur.nextRun
  conn.prepare('UPDATE automations SET name=?, prompt=?, schedule=?, enabled=?, next_run=? WHERE id=?').run(name, prompt, JSON.stringify(sched), enabled ? 1 : 0, nxt, aid)
  return get(conn, aid)
}

export function remove(conn: db.Conn, aid: number): void {
  get(conn, aid)
  conn.prepare('DELETE FROM automations WHERE id=?').run(aid)
}

/** Every user's DB file: <dir of HARNESS_DB>/users/<uid>/harness.db */
export function userDbs(): string[] {
  const base = join(dirname(process.env.HARNESS_DB ?? 'harness.db') || '.', 'users')
  if (!existsSync(base)) return []
  return readdirSync(base).sort().map((d) => join(base, d, 'harness.db')).filter((p) => existsSync(p))
}

/** `runJob(owner, name, prompt)` does the actual run and returns [status text, session id]. */
export type RunJob = (owner: string, name: string, prompt: string) => Promise<[string, number | null]>

export class Scheduler {
  private runJob: RunJob
  private running = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(runJob: RunJob) {
    this.runJob = runJob
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      // a slow tick (a job is a model run) must not overlap the next one
      if (this.ticking) return
      this.ticking = true
      this.tick()
        .catch((e) => console.log(JSON.stringify({ scheduler_error: `${(e as Error).name}: ${(e as Error).message}` })))
        .finally(() => (this.ticking = false))
    }, TICK * 1000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Run every job that is due, one after another. Returns how many ran. */
  async tick(now: number = Date.now() / 1000): Promise<number> {
    let ran = 0
    for (const path of userDbs()) {
      const conn = db.connect(path)
      try {
        const due = conn.prepare('SELECT id, schedule FROM automations WHERE enabled=1 AND next_run IS NOT NULL AND next_run<=?').raw().all(now) as Array<[number, string]>
        for (const [aid, sched] of due) {
          if (!this.claim(path, aid)) continue
          conn.prepare('UPDATE automations SET next_run=? WHERE id=?').run(nextRun(JSON.parse(sched), now), aid) // before it runs
          await this.fire(conn, path, aid)
          ran++
        }
      } finally {
        conn.close()
      }
    }
    return ran
  }

  private claim(path: string, aid: number): boolean {
    const key = `${path}#${aid}`
    if (this.running.has(key)) return false
    this.running.add(key)
    return true
  }

  private async fire(conn: db.Conn, path: string, aid: number): Promise<void> {
    try {
      const job = get(conn, aid)
      const owner = conn.prepare('SELECT owner FROM automations WHERE id=?').pluck().get(aid) as string
      let status: string
      let sid: number | null
      try {
        ;[status, sid] = await this.runJob(owner, job.name, job.prompt)
      } catch (e) {
        status = e instanceof HarnessError ? `${e.kind}: ${e.message}` : `internal: ${(e as Error)?.constructor?.name ?? 'Error'}`
        sid = null
      }
      conn.prepare('UPDATE automations SET last_run=?, last_status=?, last_session=? WHERE id=?').run(Date.now() / 1000, status.slice(0, 300), sid, aid)
    } finally {
      this.running.delete(`${path}#${aid}`)
    }
  }

  /** Start a job now in the background without moving its schedule. False when it is already running. */
  runNow(owner: string, aid: number): boolean {
    const path = dbPath(owner)
    const conn = db.connect(path)
    try {
      get(conn, aid) // not_found for somebody else's or a missing id
    } finally {
      conn.close()
    }
    if (!this.claim(path, aid)) return false
    void (async () => {
      const c = db.connect(path)
      try {
        await this.fire(c, path, aid)
      } finally {
        c.close()
      }
    })()
    return true
  }
}
