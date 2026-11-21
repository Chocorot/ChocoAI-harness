/** Server-sent events: a Response whose body we write to, with the keepalive comment and "has the client left" tracking. */
import type { Emit } from '../core/model.ts'

/** The browser left while its run was still waiting in line: drop it quietly. */
export class ClientGone extends Error {}

/** Seconds between keepalive pings; keeps proxies (Cloudflare) from cutting a stream that is silent during a long prefill. */
export const keepaliveSeconds = (): number => Number(process.env.HARNESS_KEEPALIVE) || 10

export interface Sse {
  response: Response
  emit: Emit
  alive: () => boolean
  close: () => void
}

export function openSse(): Sse {
  const enc = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let alive = true
  let timer: ReturnType<typeof setInterval> | null = null
  const write = (s: string) => {
    if (!alive) return
    try {
      controller.enqueue(enc.encode(s))
    } catch {
      alive = false // the client left; a running run finishes anyway so the history stays consistent
    }
  }
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    cancel() {
      alive = false
      if (timer) clearInterval(timer)
    },
  })
  timer = setInterval(() => write(': ka\n\n'), keepaliveSeconds() * 1000) // an SSE comment: ignored by the page, resets proxy idle timers
  timer.unref()
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' },
    }),
    emit: (ev) => write('data: ' + JSON.stringify(ev) + '\n\n'),
    alive: () => alive,
    close: () => {
      if (timer) clearInterval(timer)
      if (alive) {
        alive = false
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    },
  }
}
