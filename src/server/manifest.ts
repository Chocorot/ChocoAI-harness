/** Self-description for the dashboard: what this harness is, its settings (from settings.FIELDS) and totals. Same shape as the Python one. */
import * as db from '../core/db.ts'
import * as settings from '../core/settings.ts'
import { shared, VERSION } from './state.ts'

export function manifest() {
  const conn = db.connect()
  let stats
  try {
    stats = db.stats(conn)
  } finally {
    conn.close()
  }
  return {
    kind: 'choco-harness',
    name: 'ChocoAI harness',
    version: VERSION,
    status: shared().queue.busy() ? 'busy' : 'idle',
    backend: { baseUrl: process.env.BASE_URL ?? 'http://localhost:1235/v1', model: settings.get('model') },
    settings: settings.manifest(),
    stats,
  }
}
