/**
 * Attachments of one chat message: a photo for the model to look at, documents turned into text.
 * Limits are the constants below. The model backend only ever gets an image on the newest message that has one (expand).
 * Port of legacy/attach.py.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { unzipSync } from 'fflate'
import { HarnessError, ToolError } from './errors.ts'

export const MAX_FILES = 4 // per message, photo included
export const MAX_IMAGE_BYTES = 2_500_000
export const MAX_DOC_BYTES = 3_000_000
export const DOC_CHARS = 12_000 // text kept per document (the model window is 16K tokens)
export const TOTAL_CHARS = 24_000 // across all documents of one message
const XML_LIMIT = 20_000_000 // largest word/document.xml we unpack (zip bombs)
const WRAP_TAG = 'attached_file'
export const IMAGE_MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }
const TEXT_EXT = '.txt .md .csv .tsv .json .xml .yaml .yml .toml .ini .log .html .css .js .ts .py .sh .sql .c .h .cpp .java .go .rs .rb .php'.split(' ')

const bad = (msg: string) => new HarnessError('bad_request', msg)

/** A reader failure with a plain reason for the user (Python's ValueError). */
export class ReadError extends Error {}

export function imageKind(raw: Buffer): 'jpg' | 'png' | 'gif' | 'webp' | null {
  if (raw.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg'
  if (raw.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (raw.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif'
  if (raw.subarray(0, 4).toString('latin1') === 'RIFF' && raw.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return null
}

// ---- readers: bytes -> text (they throw ReadError with a plain reason) -------------------------------------------------------
function readText(raw: Buffer): string {
  if (raw.subarray(0, 4096).includes(0)) throw new ReadError("that doesn't look like a text file")
  return raw.toString('utf8')
}

const xmlUnescape = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] ?? m
  })

function readDocx(raw: Buffer): string {
  let xml: string
  try {
    const files = unzipSync(new Uint8Array(raw), { filter: (f) => f.name === 'word/document.xml' })
    const doc = files['word/document.xml']
    if (!doc) throw new Error('missing')
    if (doc.length > XML_LIMIT) throw new ReadError('that document is too large to read')
    xml = Buffer.from(doc).toString('utf8')
    if (!/<w:document[\s>]/.test(xml)) throw new Error('not wordprocessingml')
  } catch (e) {
    if (e instanceof ReadError) throw e
    throw new ReadError("that isn't a readable .docx file")
  }
  // shortcut: paragraphs are found with a pattern, not a full XML parser (the document.xml of a real .docx is regular enough)
  const paras: string[] = []
  for (const p of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    let text = ''
    for (const t of p[1]!.matchAll(/<w:t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:t>)|<w:tab\s*\/>|<w:br(?:\s[^>]*)?\/>/g)) {
      if (t[0].startsWith('<w:tab')) text += '\t'
      else if (t[0].startsWith('<w:br')) text += '\n'
      else text += xmlUnescape(t[1] ?? '')
    }
    paras.push(text)
  }
  return paras.join('\n')
}

/** Text layer via poppler's pdftotext (an apt package in the image). Scanned PDFs have no text layer: no OCR. */
function readPdf(raw: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-'))
  try {
    const f = join(dir, 'in.pdf')
    writeFileSync(f, raw)
    const r = spawnSync('pdftotext', ['-layout', '-q', f, '-'], { timeout: 30_000, maxBuffer: 50_000_000 })
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw new ReadError("reading PDFs isn't set up on this server")
    if (r.error) throw new ReadError('that PDF took too long to read')
    const text = r.stdout.toString('utf8')
    if (r.status !== 0 && !text.trim()) throw new ReadError("that isn't a readable PDF")
    if (!text.trim()) throw new ReadError("that PDF has no text layer (is it a scan?), so I can't read it")
    return text
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Extension -> reader: a new type is a row. Tests may swap a reader (the PDF one needs poppler). */
export const READERS: Record<string, (raw: Buffer) => string> = { ...Object.fromEntries(TEXT_EXT.map((e) => [e, readText])), '.docx': readDocx, '.pdf': readPdf }

/** Text of a stored document (used by read_file for .pdf/.docx so a long document can be read page by page). */
export function extract(path: string): string {
  const reader = READERS[extname(path).toLowerCase()]
  try {
    return reader!(readFileSync(path))
  } catch (e) {
    if (e instanceof ReadError) throw new ToolError('unreadable', e.message, '')
    throw e
  }
}

// ---- one message's attachments ---------------------------------------------------------------------------------------------
/** Code points, like Python's len() and slicing (matters only for emoji and the like). */
const cpLen = (s: string): number => (s.length < 2 ? s.length : [...s].length)
const cpSlice = (s: string, n: number): string => (s.length <= n ? s : [...s].slice(0, n).join(''))

function stem(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 || i === name.length - 1 ? name : name.slice(0, i)
}
const suffix = (name: string): string => {
  const i = name.lastIndexOf('.')
  return i <= 0 || i === name.length - 1 ? '' : name.slice(i)
}

export function cleanName(name: unknown): string {
  const s = String(name).replaceAll('\\', '/').replace(/\/+$/, '')
  const base = s.slice(s.lastIndexOf('/') + 1).replace(/[^\p{L}\p{N}_.\- ]/gu, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80)
  return base || 'file'
}

export function unique(name: string, used: Set<string>): string {
  const i = name.lastIndexOf('.')
  const [st, dot, ext] = i >= 0 ? [name.slice(0, i), '.', name.slice(i + 1)] : [name, '', '']
  let n = 1
  let out = name
  while (used.has(out)) {
    n++
    out = `${st}-${n}${dot}${ext}`
  }
  used.add(out)
  return out
}

export interface Processed {
  docText: string
  /** [stored path, bytes] */
  images: Array<[string, Buffer]>
  /** Every original, so the model's file tools can open them from the session directory. */
  saves: Array<[string, Buffer]>
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/

/** Validate and read the attachments. Throws HarnessError(bad_request). */
export function process_(atts: unknown, vision: boolean): Processed {
  if (!atts || (Array.isArray(atts) && atts.length === 0)) return { docText: '', images: [], saves: [] }
  if (!Array.isArray(atts) || atts.length > MAX_FILES) throw bad(`At most ${MAX_FILES} attachments per message.`)
  const used = new Set<string>()
  const docs: string[] = []
  const images: Array<[string, Buffer]> = []
  const saves: Array<[string, Buffer]> = []
  let left = TOTAL_CHARS
  for (const a of atts) {
    if (!a || typeof a !== 'object' || typeof a.name !== 'string' || typeof a.data !== 'string') throw bad('An attachment was not valid.')
    if (a.data.length % 4 !== 0 || !B64.test(a.data)) throw bad('An attachment was not valid.')
    const raw = Buffer.from(a.data, 'base64')
    let name = cleanName(a.name)
    const kind = imageKind(raw)
    if (kind) {
      if (!vision) throw bad("This assistant can't look at photos yet.")
      if (images.length) throw bad('One photo per message, please.')
      if (raw.length > MAX_IMAGE_BYTES) throw bad('That photo is too large.')
      images.push([`uploads/${unique(stem(name) + '.' + kind, used)}`, raw]) // named by what the bytes are, not by the claimed extension
      continue
    }
    name = unique(name, used)
    const ext = suffix(name).toLowerCase()
    if (!(ext in READERS)) throw bad(`I can't read ${ext || 'that kind of'} files. I can read: photos, ${Object.keys(READERS).sort().join(', ')}.`)
    if (raw.length > MAX_DOC_BYTES) throw bad(`${name} is too large.`)
    let text: string
    try {
      text = READERS[ext]!(raw).trim()
    } catch (e) {
      if (e instanceof ReadError) throw bad(`${name}: ${e.message}.`)
      throw e
    }
    const keep = cpSlice(text, Math.min(DOC_CHARS, left))
    left -= cpLen(keep)
    const note = keep.length === text.length ? '' : ` (truncated: ${cpLen(keep)} of ${cpLen(text)} characters; the whole file is saved as uploads/${name} and can be read in parts)`
    docs.push(`\n\n<${WRAP_TAG} name="${name}"${note}>\n${keep.replaceAll(`</${WRAP_TAG}>`, '')}\n</${WRAP_TAG}>`)
    saves.push([`uploads/${name}`, raw])
  }
  return { docText: docs.join(''), images, saves }
}

export function save(ws: string, files: Array<[string, Buffer]>): void {
  for (const [rel, raw] of files) {
    const p = join(ws, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, raw)
  }
}

/** The user message: plain text, or a list of parts when there is a photo (image_ref is ours, expand() makes it real). */
export function content(text: string, docText: string, images: Array<[string, Buffer]>) {
  const full = text + docText
  return images.length ? [{ type: 'text', text: full }, ...images.map(([n]) => ({ type: 'image_ref', name: n }))] : full
}

const STORED = /^uploads\/\w[\w.-]{0,99}$/

/** Messages as the model backend should get them: an image_ref becomes an image_url data URL on the newest message that
 * has one; older ones become a short note, so one photo is not re-sent with every turn. */
export function expand(messages: Array<Record<string, any>>, ws: string): Array<Record<string, any>> {
  let last = -1
  messages.forEach((m, i) => {
    if (Array.isArray(m.content)) last = i
  })
  if (last < 0) return messages
  return messages.map((m, i) => {
    if (!Array.isArray(m.content)) return m
    const parts = m.content.map((p: Record<string, any>) => {
      if (p.type !== 'image_ref') return p
      if (i !== last) return { type: 'text', text: '[an earlier photo is not shown]' }
      const f = STORED.test(String(p.name)) ? join(ws, p.name) : null
      let isFile = false
      try {
        isFile = f !== null && statSync(f).isFile()
      } catch {
        isFile = false
      }
      if (!isFile) return { type: 'text', text: '[the photo is no longer available]' }
      const mime = IMAGE_MIME[extname(f!).slice(1).toLowerCase()] ?? 'image/jpeg'
      return { type: 'image_url', image_url: { url: `data:${mime};base64,${readFileSync(f!).toString('base64')}` } }
    })
    return { ...m, content: parts }
  })
}

export { basename as _basename }
