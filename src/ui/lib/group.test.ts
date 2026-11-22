import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bucketOf, groupChats } from './group.ts'

const NOW = new Date(2026, 10, 22, 15, 30) // 22 Nov 2026, 15:30 local
const at = (daysAgo: number, hour = 9) => new Date(2026, 10, 22 - daysAgo, hour).getTime() / 1000

test('bucketOf: calendar days, not 24-hour windows', () => {
  assert.equal(bucketOf(at(0, 0), NOW), 'Today')
  assert.equal(bucketOf(at(1, 23), NOW), 'Yesterday') // 23:00 yesterday is 16 hours ago but still yesterday
  assert.equal(bucketOf(at(2), NOW), 'Previous 7 days')
  assert.equal(bucketOf(at(6), NOW), 'Previous 7 days')
  assert.equal(bucketOf(at(7), NOW), 'Older')
  assert.equal(bucketOf(at(90), NOW), 'Older')
  assert.equal(bucketOf(NOW.getTime() / 1000 + 3600, NOW), 'Today') // a slightly fast clock is not "the future"
})

test('groupChats keeps the order inside a group, orders the groups, and skips empty ones', () => {
  const rows = [{ id: 1, created: at(0) }, { id: 2, created: at(0, 8) }, { id: 3, created: at(3) }, { id: 4, created: at(30) }]
  assert.deepEqual(groupChats(rows, NOW).map((g) => [g.label, g.rows.map((r) => r.id)]), [['Today', [1, 2]], ['Previous 7 days', [3]], ['Older', [4]]])
  assert.deepEqual(groupChats([], NOW), [])
})
