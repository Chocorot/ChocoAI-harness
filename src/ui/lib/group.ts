/** Saved chats grouped by when they started, for the sidebar. `created` is epoch seconds; the input order (newest first) is kept inside a group. */
export type Bucket = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older'
const ORDER: Bucket[] = ['Today', 'Yesterday', 'Previous 7 days', 'Older']

const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

export function bucketOf(createdSeconds: number, now: Date = new Date()): Bucket {
  const days = Math.round((dayStart(now) - dayStart(new Date(createdSeconds * 1000))) / 86_400_000)
  if (days <= 0) return 'Today' // a clock that is a little behind counts as today
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'Previous 7 days'
  return 'Older'
}

export function groupChats<T extends { created: number }>(rows: T[], now: Date = new Date()): Array<{ label: Bucket; rows: T[] }> {
  const by = new Map<Bucket, T[]>()
  for (const r of rows) {
    const b = bucketOf(r.created, now)
    by.set(b, [...(by.get(b) ?? []), r])
  }
  return ORDER.filter((b) => by.has(b)).map((label) => ({ label, rows: by.get(label)! }))
}
