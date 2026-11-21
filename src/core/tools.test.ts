import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODES } from './auth.ts'
import * as tools from './tools.ts'
import { golden } from './test-helpers.ts'

const g = golden('tools')

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'tools-'))
  writeFileSync(join(ws, 'f.txt'), Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
  writeFileSync(join(ws, 'dup.txt'), 'aa aa')
  mkdirSync(join(ws, 'sub'))
  symlinkSync('/etc', join(ws, 'link'))
  const scrub = (s: string) => s.replaceAll(ws, '<WS>').replace('/private<WS>', '<WS>')
  const t = async (name: string, args: Record<string, unknown>, allow: string[] | null = null) => scrub(await tools.run(name, args, ws, allow))
  return { ws, t }
}

test('error shape, file tools and path confinement give the same text as Python', async () => {
  const { ws, t } = workspace()
  assert.deepEqual([tools.err('c', 'm'), tools.err('c', 'm', 'h')], g.err)
  const read = [
    await t('read_file', { path: 'f.txt' }), await t('read_file', { path: 'f.txt', start_line: 10, end_line: 12 }), await t('read_file', { path: 'f.txt', start_line: 1, end_line: 900 }),
    await t('read_file', { path: 'nope.txt' }), await t('read_file', { path: '../x' }), await t('read_file', { path: '/etc/hosts' }), await t('read_file', { path: 'link/hosts' }), await t('read_file', {}),
  ]
  assert.deepEqual(read, g.read)
  const edit = [
    await t('edit_file', { path: 'dup.txt', old_text: 'aa', new_text: 'b' }), await t('edit_file', { path: 'dup.txt', old_text: 'zz', new_text: 'b' }),
    await t('edit_file', { path: 'dup.txt', old_text: '', new_text: 'b' }), await t('edit_file', { path: 'dup.txt', old_text: 'aa aa', new_text: 'ok' }), readFileSync(join(ws, 'dup.txt'), 'utf8'),
  ]
  assert.deepEqual(edit, g.edit)
  const write = [await t('write_file', { path: 'new/x.txt', content: 'hello' }), readFileSync(join(ws, 'new', 'x.txt'), 'utf8'), await t('write_file', { path: '../out.txt', content: 'x' })]
  assert.deepEqual(write, g.write)
})

test('run_bash: output format, exit codes, stderr, timeout kills the command, cwd is the workspace', async () => {
  const { t } = workspace()
  assert.equal(await t('run_bash', { command: 'echo hi; echo err >&2; exit 3' }), g.bash[0])
  assert.equal(await t('run_bash', { command: 'sleep 3', timeout: 1 }), g.bash[1])
  assert.equal((await t('run_bash', { command: 'pwd' })).split('\n')[2], g.bash[2])
})

test('run_bash never sees the server secrets (the Python version leaked them)', async () => {
  const { ws } = workspace()
  Object.assign(process.env, { HARNESS_TOKEN: 'tok-secret', HARNESS_ADMIN_TOKEN: 'adm-secret', API_KEY: 'key-secret', SSO_CLIENT_SECRET: 'sso-secret', AUTH_SECRET: 'auth-secret' })
  const out = await tools.run('run_bash', { command: 'env; printenv | sort' }, ws)
  for (const s of ['tok-secret', 'adm-secret', 'key-secret', 'sso-secret', 'auth-secret', 'HARNESS_', 'API_KEY']) assert.ok(!out.includes(s), s)
  assert.ok(out.includes(`HOME=${ws}`))
})

test('a timed-out command takes its children with it', async () => {
  const { ws, t } = workspace()
  await t('run_bash', { command: '(sleep 30; echo late > late.txt) & sleep 30', timeout: 1 })
  await new Promise((r) => setTimeout(r, 300))
  assert.throws(() => readFileSync(join(ws, 'late.txt')))
})

test('forbidden tools, unknown tools, and web tool argument errors', async () => {
  const { t } = workspace()
  assert.deepEqual([await t('run_bash', { command: 'id' }, ['read_file']), await t('web_fetch', { url: 'x' }, ['read_file']), await t('nope', {})], g.forbidden)
  const web = [await t('web_fetch', { url: 'ftp://x' }), await t('web_fetch', { url: 'http://user:pw@x.com/' }), await t('web_fetch', { url: '' }), await t('web_search', { query: 'x' }), await t('web_search', { query: '' })]
  assert.deepEqual(web, g.web_args.slice(0, 5))
  assert.match(await t('read_file', { path: 'f.txt', start_line: 'a' }), /^error\[bad_args\]/) // the exact words of a Python TypeError cannot be reproduced
  assert.match(await t('web_fetch', { nope: 1 }), /^error\[bad_args\]: TypeError: fetch\(\) got an unexpected keyword argument 'nope'/)
})

test('one table drives schemas, prompts and permissions', () => {
  const ref = golden('effort_and_prompts')
  assert.deepEqual(JSON.parse(JSON.stringify(tools.SCHEMAS)), ref.tool_schemas)
  assert.deepEqual(tools.schemasFor(['web_fetch', 'read_file']).map((s) => s.function.name), ['read_file', 'web_fetch'])
  assert.equal(tools.promptsFor(['read_file']), '')
  assert.match(tools.promptsFor(['web_fetch']), /untrusted/)
  assert.match(tools.promptsFor(['update_plan', 'delegate']), /update_plan/)
  assert.match(tools.forbidden('run_bash', ['read_file'])!, /^error\[forbidden\]/)
  assert.equal(tools.forbidden('run_bash', null), null)
  assert.deepEqual(new Set(MODES.admin.tools), new Set(Object.keys(tools.TOOLS))) // every tool belongs to some mode
  for (const a of tools.AGENT) assert.ok(a in tools.TOOLS)
})
