import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, current, defaultOf, FIELDS, get, manifest, save, validate } from './settings.ts'
import { golden } from './test-helpers.ts'

const g = golden('settings')
const dir = mkdtempSync(join(tmpdir(), 'settings-'))
process.env.HARNESS_SETTINGS = join(dir, 'settings.json')
delete process.env.MODEL

afterEach(() => writeFileSync(process.env.HARNESS_SETTINGS!, '{}'))

test('the field table equals the Python one', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(FIELDS)), g.fields)
})

test('validation of every field type gives the Python error text', () => {
  const by = Object.fromEntries(FIELDS.map((f) => [f.key, f]))
  for (const c of g.checks) {
    const value = c.nan ? Number.NaN : c.value
    // Python tells a float from an int (1.5 vs 1); JSON in JS cannot: only compare cases where both agree
    assert.equal(check(by[c.key], value), c.err, `${c.key} ${JSON.stringify(c.value)}`)
  }
})

test('validate: all or nothing, null resets, unknown keys refused', () => {
  for (const [input, expected] of g.validate) assert.deepEqual(validate(input), expected, JSON.stringify(input))
})

test('defaults and manifest equal the Python ones', () => {
  assert.deepEqual(current(), g.current)
  assert.deepEqual(JSON.parse(JSON.stringify(manifest())), g.manifest.map((m: Record<string, unknown>) => (m.key === 'base_url' ? { ...m, value: process.env.BASE_URL ?? 'http://localhost:1235/v1' } : m)))
})

test('save writes the file atomically, keeps a .bak, applies at once, and a bad hand-edited value is ignored', () => {
  assert.deepEqual(save({ max_turns: 7, temperature: 0.2 })[1], null)
  assert.equal(get('max_turns'), 7)
  assert.equal(get('temperature'), 0.2)
  assert.deepEqual(save({ max_turns: 9 })[1], null)
  assert.equal(JSON.parse(readFileSync(process.env.HARNESS_SETTINGS + '.bak', 'utf8')).max_turns, 7)
  assert.deepEqual(save({ max_turns: null })[1], null)
  assert.equal(get('max_turns'), defaultOf('max_turns'))
  assert.match(save({ max_turns: 0 })[1]!, /max_turns must be between 1 and 100/)
  writeFileSync(process.env.HARNESS_SETTINGS!, JSON.stringify({ max_turns: 'oops', vision: true, nope: 1 }))
  assert.equal(get('max_turns'), 15)
  assert.equal(get('vision'), true)
  writeFileSync(process.env.HARNESS_SETTINGS!, 'not json')
  assert.equal(get('max_turns'), 15)
})

test('the MODEL environment variable supplies the default', () => {
  process.env.MODEL = 'other/model'
  assert.equal(get('model'), 'other/model')
  delete process.env.MODEL
})
