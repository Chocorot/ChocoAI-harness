/**
 * SQLite persistence: sessions, messages, token usage, tool audit log. One file, no services.
 * Same tables and columns as legacy/db.py: the Python app and this one can open the same file (compatibility contract).
 */
import Database from 'better-sqlite3'
import type { HarnessError } from './errors.ts'

export type Conn = Database.Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, goal TEXT, created REAL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, session INTEGER, json TEXT);
CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY, session INTEGER, turn INTEGER,
  prompt_tokens INTEGER, completion_tokens INTEGER, est_tokens INTEGER);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts REAL, session INTEGER,
  tool TEXT, args TEXT, result TEXT);
CREATE TABLE IF NOT EXISTS errors(id INTEGER PRIMARY KEY, ts REAL, rid TEXT, session INTEGER,
  kind TEXT, code TEXT, message TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS revocations(key TEXT PRIMARY KEY, at REAL, until REAL);
CREATE TABLE IF NOT EXISTS seen_logout_jti(jti TEXT PRIMARY KEY, until REAL);
CREATE TABLE IF NOT EXISTS automations(id INTEGER PRIMARY KEY, owner TEXT, name TEXT, prompt TEXT, schedule TEXT,
  enabled INTEGER DEFAULT 1, next_run REAL, last_run REAL, last_status TEXT, last_session INTEGER, created REAL);
CREATE INDEX IF NOT EXISTS msg_session ON messages(session);
`
// title: shown in the chat list (NULL = use `goal`). title_state: 0 = made from the first message, 1 = written by the model,
// 2 = named by the user or a job (never overwritten). effort: the chat's thinking level.
const SESSION_COLUMNS: Array<[string, string]> = [['title', 'TEXT'], ['title_state', 'INTEGER DEFAULT 0'], ['effort', 'TEXT']]
const ERROR_KEEP = 200 // the errors table is a ring: only the newest rows are kept

export function connect(path?: string): Conn {
  const db = new Database(path ?? process.env.HARNESS_DB ?? 'harness.db')
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const have = new Set((db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((r) => r.name))
  for (const [col, ddl] of SESSION_COLUMNS) if (!have.has(col)) db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${ddl}`) // older databases get a column once
  return db
}

const now = () => Date.now() / 1000

export function newSession(db: Conn, goal: string | null, title: string | null = null, state = 0, effort: string | null = null): number {
  const r = db.prepare('INSERT INTO sessions(goal, created, title, title_state, effort) VALUES(?,?,?,?,?)').run(goal, now(), title, state, effort)
  return Number(r.lastInsertRowid)
}

export interface SessionInfo {
  title: string
  titleState: number
  effort: string | null
}

export function getSession(db: Conn, sid: number): SessionInfo | null {
  const r = db.prepare('SELECT COALESCE(title, goal) t, COALESCE(title_state, 0) s, effort e FROM sessions WHERE id=?').get(sid) as { t: string | null; s: number; e: string | null } | undefined
  return r ? { title: r.t || '', titleState: r.s, effort: r.e } : null
}

export const setEffort = (db: Conn, sid: number, effort: string): void => void db.prepare('UPDATE sessions SET effort=? WHERE id=?').run(effort, sid)

/** Set a title. A model-written title (state 1) only lands while the title is still the automatic one (state 0). */
export function rename(db: Conn, sid: number, title: string, state: number): boolean {
  const r = db.prepare('UPDATE sessions SET title=?, title_state=? WHERE id=?' + (state === 1 ? ' AND COALESCE(title_state,0)=0' : '')).run(title, state, sid)
  return r.changes > 0
}

export const sessionExists = (db: Conn, sid: number): boolean => db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sid) !== undefined

export type Message = Record<string, any>

export const load = (db: Conn, sid: number): Message[] => (db.prepare('SELECT json FROM messages WHERE session=? ORDER BY id').all(sid) as Array<{ json: string }>).map((r) => JSON.parse(r.json))

export const saveMsg = (db: Conn, sid: number, msg: Message): void => void db.prepare('INSERT INTO messages(session, json) VALUES(?,?)').run(sid, JSON.stringify(msg))

/** Delete the newest message of a session (used to remove a failure note before a retry). */
export const dropLast = (db: Conn, sid: number): void => void db.prepare('DELETE FROM messages WHERE id=(SELECT MAX(id) FROM messages WHERE session=?)').run(sid)

export function logError(db: Conn, rid: string, sid: number | null, err: HarnessError): void {
  db.prepare('INSERT INTO errors(ts, rid, session, kind, code, message, detail) VALUES(?,?,?,?,?,?,?)').run(now(), rid, sid, err.kind, err.code, err.message, err.detail.slice(0, 500))
  db.prepare('DELETE FROM errors WHERE id <= (SELECT MAX(id) FROM errors) - ?').run(ERROR_KEEP)
}

export function listErrors(db: Conn, limit = 50) {
  return db.prepare('SELECT ts, rid, session, kind, code, message, detail FROM errors ORDER BY id DESC LIMIT ?').all(limit)
}

export function deleteSession(db: Conn, sid: number): void {
  for (const table of ['messages', 'usage', 'audit']) db.prepare(`DELETE FROM ${table} WHERE session=?`).run(sid)
  db.prepare('DELETE FROM sessions WHERE id=?').run(sid)
}

export const logUsage = (db: Conn, sid: number, turn: number, prompt: number | null, completion: number | null, est: number): void =>
  void db.prepare('INSERT INTO usage(session, turn, prompt_tokens, completion_tokens, est_tokens) VALUES(?,?,?,?,?)').run(sid, turn, prompt, completion, est)

export const logTool = (db: Conn, sid: number, tool: string, args: unknown, result: unknown): void =>
  void db.prepare('INSERT INTO audit(ts, session, tool, args, result) VALUES(?,?,?,?,?)').run(now(), sid, tool, JSON.stringify(args).slice(0, 2000), String(result).slice(0, 500))

/** Totals for the manifest. Token counts are what the backend reported (0 when it reported none). */
export function stats(db: Conn) {
  const q = (sql: string) => Object.values(db.prepare(sql).get() as Record<string, number>)[0]!
  return {
    sessions: q('SELECT COUNT(*) FROM sessions'),
    turns: q('SELECT COUNT(*) FROM usage'),
    promptTokens: q('SELECT COALESCE(SUM(prompt_tokens),0) FROM usage'),
    completionTokens: q('SELECT COALESCE(SUM(completion_tokens),0) FROM usage'),
    toolCalls: q('SELECT COUNT(*) FROM audit'),
    errors: q('SELECT COUNT(*) FROM errors'),
  }
}

export function listSessions(db: Conn, limit = 50) {
  const rows = db
    .prepare(
      'SELECT s.id, s.goal, s.created, COALESCE(s.title, s.goal), COALESCE(s.title_state, 0), s.effort,' +
        ' (SELECT COUNT(*) FROM usage u WHERE u.session=s.id),' +
        ' (SELECT COALESCE(SUM(COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)),0) FROM usage u WHERE u.session=s.id),' +
        ' (SELECT COUNT(*) FROM audit a WHERE a.session=s.id)' +
        ' FROM sessions s ORDER BY s.id DESC LIMIT ?',
    )
    .raw()
    .all(limit) as Array<[number, string | null, number, string | null, number, string | null, number, number, number]>
  return rows.map((r) => ({ id: r[0], goal: (r[1] ?? '').slice(0, 200), created: r[2], title: (r[3] ?? '').slice(0, 200), titleState: r[4], effort: r[5], turns: r[6], tokens: r[7], toolCalls: r[8] }))
}

// ---- sign-ins the SSO ended (back-channel logout, src/server/backchannel.ts). Lives in the original harness.db. ----------------------
/** Remember that `key` (`sid:<sid>` or `sub:<sub>`) was logged out. Rows are kept until a session that old would have expired anyway. */
export function revoke(db: Conn, key: string, until: number, at = now()): void {
  db.prepare('DELETE FROM revocations WHERE until < ?').run(now())
  db.prepare('INSERT INTO revocations(key, at, until) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET at=MAX(at, excluded.at), until=MAX(until, excluded.until)').run(key, at, until)
}

/** True when this sign-in was ended: its sid was revoked, or its user was revoked after the session started. */
export function isRevoked(db: Conn, s: { sid?: string; sub?: string; iat?: number }): boolean {
  if (s.sid && db.prepare('SELECT 1 FROM revocations WHERE key=? AND until >= ?').get(`sid:${s.sid}`, now())) return true
  if (s.sub) {
    const r = db.prepare('SELECT at FROM revocations WHERE key=? AND until >= ?').get(`sub:${s.sub}`, now()) as { at: number } | undefined
    if (r && (s.iat === undefined || s.iat <= r.at)) return true
  }
  return false
}

/** True when this logout token's jti was already used (a replay); otherwise records it. */
export function seenLogoutJti(db: Conn, jti: string, until: number): boolean {
  db.prepare('DELETE FROM seen_logout_jti WHERE until < ?').run(now())
  return db.prepare('INSERT OR IGNORE INTO seen_logout_jti(jti, until) VALUES(?,?)').run(jti, until).changes === 0
}
