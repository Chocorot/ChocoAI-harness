/** fetch + JSON for the harness API. Errors carry the server's message (the page shows it as is). */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status })
  return data as T
}

export type Me = {
  mode: string
  address: string | null
  capabilities: {
    login: boolean
    /** Where name, password and devices are managed: the SSO. Null without one. */
    accountUrl?: string | null
    /** A visitor who may already be signed in at the SSO: the page checks once, quietly. */
    silentLogin?: boolean
    tools: string[]
    shell: boolean
    history: 'user' | 'client'
    effort?: { default: string; levels: Array<{ id: string; label: string; desc: string }> }
    automations?: boolean
    timezone?: string
    attachments?: { image: boolean; documents: string[] }
  }
}
export type SessionRow = { id: number; title: string | null; goal?: string | null; created: number; titleState?: number }
export const chatTitle = (s: SessionRow) => (s.title || s.goal || 'Chat').split('\n')[0]!.slice(0, 80)

/** Browser storage that never throws (private windows, blocked storage). */
export const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } },
}

// Attachments on the page: shrink a photo, read a file as base64. The server limits (core/attach.ts) are the real ones;
// these only stop the page from sending what would be refused.
export const MAX_FILES = 4
export const MAX_DOC_BYTES = 3_000_000
export const MAX_TOTAL_B64 = 8_500_000
export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`)
export const extOf = (name: string) => (/\.[^./\\]+$/.exec(name) || [''])[0].toLowerCase()

/** Downscale to at most `max` px on the long side and re-encode as JPEG (also fixes phone-photo rotation). */
export async function shrinkImage(file: File, max = 1280, quality = 0.82): Promise<Blob> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * k)
  c.height = Math.round(bmp.height * k)
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, c.width, c.height) // transparent PNGs get a white background
  g.drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close?.()
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', quality))
}
export const toBase64 = (blob: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result).split(',')[1]!)
    r.onerror = () => rej(r.error)
    r.readAsDataURL(blob)
  })
