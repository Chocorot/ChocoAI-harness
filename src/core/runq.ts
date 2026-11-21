/**
 * Run queue: the local model serves one stream at a time, so runs go through here one by one. Waiters are ordered by
 * priority (lower first) then arrival. The line is bounded: past `limit` a new request is refused with `busy`.
 * Port of legacy/runq.py (threads became promises; `onWait` still fires at once and then every `tick` seconds).
 */
import { HarnessError } from './errors.ts'

interface Ticket {
  prio: number
  seq: number
  wake: () => void
}

export interface SlotOptions {
  prio?: number
  /** Called at once and then every `tick` seconds while waiting, with how many runs are ahead. It may throw to leave the line. */
  onWait?: (ahead: number) => void
  tick?: number
  /** Overrides the line length for this caller (public gets a shorter line). */
  limit?: number
}

export class RunQueue {
  private waiting: Ticket[] = []
  private running = false
  private seq = 0
  private limit: () => number

  /** `limit` is a function so a saved setting applies without a restart. */
  constructor(limit: () => number = () => 8) {
    this.limit = limit
  }

  busy(): boolean {
    return this.running
  }

  waitingCount(): number {
    return this.waiting.length
  }

  private head(): Ticket | undefined {
    return this.waiting.reduce<Ticket | undefined>((m, t) => (!m || t.prio < m.prio || (t.prio === m.prio && t.seq < m.seq) ? t : m), undefined)
  }

  private wakeAll(): void {
    for (const t of [...this.waiting]) t.wake()
  }

  /** Wait for the model, run `fn` while holding it, release. Throws `busy` when the line is full. */
  async slot<T>(opts: SlotOptions, fn: () => Promise<T>): Promise<T> {
    const { prio = 1, onWait, tick = 10, limit } = opts
    // an idle queue never refuses
    if ((this.running || this.waiting.length) && this.waiting.length >= (limit ?? this.limit())) throw new HarnessError('busy')
    let wake: () => void = () => {}
    const ticket: Ticket = { prio, seq: this.seq++, wake: () => wake() }
    this.waiting.push(ticket)
    try {
      for (;;) {
        if (!this.running && this.head() === ticket) {
          this.running = true
          break
        }
        const ahead = this.waiting.filter((t) => t.prio < prio || (t.prio === prio && t.seq < ticket.seq)).length + (this.running ? 1 : 0)
        onWait?.(ahead)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, tick * 1000)
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      }
    } finally {
      this.waiting = this.waiting.filter((t) => t !== ticket)
      this.wakeAll()
    }
    try {
      return await fn()
    } finally {
      this.running = false
      this.wakeAll()
    }
  }
}
