// Tests only.
import { readFileSync } from 'node:fs'

/** What the PYTHON harness produced for a fixed list of inputs (legacy/golden.py writes test/golden/*.json). */
export function golden<T = any>(name: string): T {
  // Python writes NaN for float('nan'); strict JSON has no NaN, so read it as null.
  return JSON.parse(readFileSync(new URL(`../../test/golden/${name}.json`, import.meta.url), 'utf8').replaceAll(': NaN', ': null'))
}

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from './db.ts'
import type { Emit } from './model.ts'

/** Fresh settings file + data directory for a test (settings and per-user DBs read these from the environment on every call). */
export function freshEnv(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-test-'))
  process.env.HARNESS_SETTINGS = join(dir, 'settings.json')
  process.env.HARNESS_DB = join(dir, 'harness.db')
  writeFileSync(process.env.HARNESS_SETTINGS, '{}')
  return dir
}

/** The conversation legacy/golden.py builds: `turns` assistant+tool pairs with tool results of size `big` on even turns. */
export function convo(turns: number, big: number): Message[] {
  const m: Message[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'goal' }]
  for (let i = 0; i < turns; i++) {
    const n = ['read_file', 'run_bash', 'web_fetch', 'write_file'][i % 4]!
    const args = pyDumpsForTest({ path: 'a.txt', content: 'x'.repeat(n === 'write_file' ? 400 : 10) })
    m.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: n, arguments: args } }] })
    m.push({ role: 'tool', tool_call_id: `c${i}`, content: i % 2 === 0 ? 'y'.repeat(big) : 'short result' })
  }
  m.push({ role: 'assistant', content: 'done' })
  return m
}
const pyDumpsForTest = (o: Record<string, string>) => '{' + Object.entries(o).map(([k, v]) => `"${k}": "${v}"`).join(', ') + '}'

/** Stands in for model.chat: records every call, replays scripted replies (text or a full message). */
export class FakeModel {
  replies: Array<string | Message>
  calls: Array<{ messages: Message[]; schemas: unknown; maxTokens: unknown; effort: unknown }> = []
  constructor(...replies: Array<string | Message>) {
    this.replies = replies
  }
  fn = async (messages: Message[], emit: Emit, schemas?: unknown, maxTokens?: unknown, effort?: unknown): Promise<[Message, Record<string, number>]> => {
    this.calls.push({ messages: [...messages], schemas, maxTokens, effort }) // copy: the loop keeps appending
    const r = this.replies.length ? this.replies.shift()! : 'ok'
    if (typeof r !== 'string') return [r, {}]
    emit({ t: 'text', d: r })
    return [{ role: 'assistant', content: r }, {}]
  }
}

export const call = (name: string, args: unknown, id = 'c1'): Message => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })

/** The simple conversation the Python tests use: `n` pairs of assistant tool call (run_bash on even turns, read_file on odd) and a result of `size` chars. */
export function convoPy(n: number, size = 6000): Message[] {
  const m: Message[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'goal' }]
  for (let i = 0; i < n; i++) {
    m.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: i % 2 ? 'read_file' : 'run_bash', arguments: '{}' } }] })
    m.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x'.repeat(size) })
  }
  return m
}
