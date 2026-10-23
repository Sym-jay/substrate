import { expect, test } from 'bun:test'
import { ExternalActivity } from './activity.ts'

test('SSH/preview traffic resets only its VM idle time, preserving guest events and uptime fields', () => {
  let now = 1000
  const activity = new ExternalActivity(() => now)
  const report = { bootId: 'same-boot', idleMs: 600_000, events: [] }
  expect(activity.report('vm-a', report)).toBe(report)
  activity.touch('vm-a')
  now += 5000
  expect(activity.report('vm-a', report)).toEqual({ ...report, idleMs: 5000 })
  expect(activity.report('vm-b', report)).toBe(report)
  expect(activity.report('vm-a', null)).toBeNull()
  expect(report.idleMs).toBe(600_000)
  activity.forget('vm-a')
  expect(activity.report('vm-a', report)).toBe(report)
})
