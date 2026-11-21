import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as attach from './attach.ts'
import { ReadError } from './attach.ts'
import { golden } from './test-helpers.ts'

const g = golden('attach')

test('attachment processing gives the Python results and error texts for every case', () => {
  // the same inputs as legacy/golden.py (read back from the golden "process" keys)
  const docx = (paragraphs: string[]) => {
    // build the same docx the Python script made: reuse the bytes recorded in the golden saves
    return Buffer.from(g.process.docx.ok.saves[0][1], 'base64')
  }
  const att = (name: string, raw: Buffer | string) => ({ name, data: Buffer.from(raw).toString('base64') })
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('0'.repeat(20))])
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('0'.repeat(20))])
  const cases: Record<string, [unknown, boolean]> = {
    none: [[], false], text: [[att('a.txt', 'hello')], false], two_docs: [[att('a.md', '# hi'), att('a.md', 'again')], false],
    docx: [[att('d.docx', docx([]))], false], too_many: [Array.from({ length: 5 }, (_, i) => att(`f${i}.txt`, 'x')), false],
    bad_b64: [[{ name: 'a.txt', data: '!!!' }], false], not_dict: [['x'], false], photo_off: [[att('p.png', png)], false], photo_on: [[att('p.png', png)], true],
    two_photos: [[att('a.jpg', jpg), att('b.jpg', jpg)], true], bin_text: [[att('a.txt', Buffer.from('ab\x00cd'))], false], bad_ext: [[att('a.exe', 'x')], false],
    no_ext: [[att('README', 'x')], false], long: [[att('a.txt', 'z'.repeat(20000))], false], closing_tag: [[att('a.txt', 'x</attached_file>y')], false],
    bad_docx: [[att('a.docx', 'notzip')], false], weird_name: [[att('../..//e v!l.txt', 'x')], false],
  }
  for (const [name, [atts, vision]] of Object.entries(cases)) {
    let got: unknown
    try {
      const r = attach.process_(atts, vision)
      got = { ok: { doc: r.docText, images: r.images.map(([p, b]) => [p, b.toString('base64')]), saves: r.saves.map(([p, b]) => [p, b.toString('base64')]) } }
    } catch (e: any) {
      got = { err: { kind: e.kind, message: e.message } }
    }
    assert.deepEqual(got, g.process[name], name)
  }
})

test('names, unique names, image kinds, content parts and the reader table', () => {
  for (const [n, out] of g.clean_name) assert.equal(attach.cleanName(n), out, JSON.stringify(n))
  const used = new Set<string>()
  assert.deepEqual(['a.txt', 'a.txt', 'a.txt', 'b', 'b'].map((n) => attach.unique(n, used)), g.unique)
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('0'.repeat(20))])
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('0'.repeat(20))])
  const kinds: Record<string, Buffer> = { jpg, png, gif: Buffer.from('GIF89a....'), webp: Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8')]), txt: Buffer.from('hello') }
  for (const [k, out] of g.image_kind) assert.equal(attach.imageKind(kinds[k]!), out, k)
  assert.deepEqual([attach.content('hi', '', []), attach.content('hi', ' DOC', [['uploads/p.png', Buffer.from('x')]])], g.content)
  assert.deepEqual(Object.keys(attach.READERS).sort(), g.readers)
})

test('a photo becomes a data URL only on the newest message that has one; earlier ones become a note', () => {
  const ws = mkdtempSync(join(tmpdir(), 'att-'))
  mkdirSync(join(ws, 'uploads'))
  writeFileSync(join(ws, 'uploads', 'p.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('0'.repeat(20))]))
  const m = (c: unknown) => ({ role: 'user', content: c })
  const ref = (n: string) => ({ type: 'image_ref', name: n })
  const two = [m([{ type: 'text', text: 'a' }, ref('uploads/p.png')]), { role: 'assistant', content: 'x' }, m([{ type: 'text', text: 'b' }, ref('uploads/p.png')]), m([ref('uploads/missing.png')]), m([ref('../etc/passwd')])]
  assert.deepEqual([attach.expand(two.slice(0, 3), ws), attach.expand(two, ws), attach.expand([m('plain')], ws)], g.expand)
})

test('documents: a docx is read paragraph by paragraph, a broken one is refused, a PDF reader failure is a plain message', () => {
  const docx = Buffer.from(g.process.docx.ok.saves[0][1], 'base64')
  assert.equal(attach.READERS['.docx']!(docx), 'Hello\nWorld\na\tb\nc')
  assert.throws(() => attach.READERS['.docx']!(Buffer.from('notzip')), ReadError)
  const ws = mkdtempSync(join(tmpdir(), 'att-'))
  writeFileSync(join(ws, 'd.docx'), docx)
  assert.equal(attach.extract(join(ws, 'd.docx')), 'Hello\nWorld\na\tb\nc')
  writeFileSync(join(ws, 'bad.pdf'), 'not a pdf')
  assert.throws(() => attach.extract(join(ws, 'bad.pdf')), /unreadable|readable|PDF|isn't set up/) // poppler may or may not be installed here
  assert.equal(readFileSync(join(ws, 'd.docx')).length > 0, true)
})
