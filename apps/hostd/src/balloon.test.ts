import { expect, test } from 'bun:test'
import { BalloonPolicy, Balloons, MemoryController, balloonDependencies } from './balloon.ts'
import { parseMemoryUsage } from './firecracker.ts'
import type { BalloonStats } from './generated/firecracker.ts'

const limit = 16_384
const stats = (assigned: number, available: number, target = assigned): BalloonStats => ({
  target_mib: limit - target, actual_mib: limit - assigned,
  target_pages: (limit - target) * 256, actual_pages: (limit - assigned) * 256,
  available_memory: available * 1024 ** 2,
})

test('pressure grows memory promptly, and OOM-deflated pages are acknowledged', () => {
  const policy = new BalloonPolicy()
  expect(policy.target('a', limit, stats(4096, 300))).toBeGreaterThanOrEqual(6144)
  expect(policy.target('b', limit, stats(6144, 500, 4096))).toBeGreaterThanOrEqual(7168)
  expect(policy.target('c', limit, stats(limit, 100))).toBeNull()
  expect(policy.target('small', 4096, { ...stats(limit, 0), actual_mib: 0, target_mib: 0 })).toBeNull()
})

test('reclamation waits for sustained slack and shrinks gradually, never below 4 GiB', () => {
  let now = 0
  const policy = new BalloonPolicy(() => now, 30_000)
  expect(policy.target('a', limit, stats(8192, 7000))).toBeNull()
  now = 29_999
  expect(policy.target('a', limit, stats(8192, 7000))).toBeNull()
  now = 30_000
  expect(policy.target('a', limit, stats(8192, 7000))).toBe(7168)
  // A new request cannot outrun the asynchronous driver.
  expect(policy.target('a', limit, stats(8192, 7000, 7168))).toBeNull()
  expect(policy.target('a', limit, stats(7168, 6000))).toBe(6144)
  expect(policy.target('a', limit, stats(4096, 3000))).toBeNull()
})

test('pressure cancels a pending reclaim and missing/invalid stats cannot reclaim memory', () => {
  let now = 0
  const policy = new BalloonPolicy(() => now, 30_000)
  policy.target('a', limit, stats(8192, 7000))
  now = 29_000
  expect(policy.target('a', limit, stats(8192, 100))).toBeGreaterThan(8192)
  now = 31_000
  expect(policy.target('a', limit, stats(8192, 7000))).toBeNull()
  expect(policy.target('bad', limit, { ...stats(8192, 7000), available_memory: undefined })).toBeNull()
  expect(policy.target('bad', limit, { ...stats(8192, 7000), actual_mib: -1 })).toBeNull()
  expect(policy.target('bad', limit, { ...stats(8192, 7000), available_memory: NaN })).toBeNull()
  now = 70_000
  policy.forget('a')
  expect(policy.target('a', limit, stats(8192, 7000))).toBeNull()
})

test('a stats read patches only the balloon and publishes target, actual and host RSS separately', async () => {
  const requests: unknown[] = []
  const deps: typeof balloonDependencies = {
    api: () => (async (operation: string, body: unknown) => {
      requests.push([operation, body])
      return operation === 'GET /balloon/statistics' ? stats(4096, 300) : undefined
    }) as ReturnType<typeof balloonDependencies.api>,
    memoryUsage: async () => ({ residentMib: 3600, proportionalMib: 3590 }),
  }
  const balloons = new Balloons(deps)
  await balloons.balance({ id: 'a', memMib: limit, balloonEnabled: false })
  expect(requests).toEqual([])
  await balloons.balance({ id: 'a', memMib: limit, balloonEnabled: true })
  expect(requests[1]).toEqual(['PATCH /balloon', { amount_mib: 10_240 }])
  expect(balloons.get('a')).toMatchObject({ targetMib: 6144, actualMib: 4096, limitMib: limit, residentMib: 3600 })
  balloons.forget('a')
  expect(balloons.get('a')).toBeNull()
})

test('the memory controller never starts overlapping passes', async () => {
  let release!: () => void, passes = 0
  const pending = new Promise<void>((resolve) => { release = resolve })
  const controller = new MemoryController(async () => { passes++; await pending })
  const first = controller.tick()
  await controller.tick()
  expect(passes).toBe(1)
  release(); await first
  await controller.tick()
  expect(passes).toBe(2)
})

test('host RAM measurements distinguish RSS/PSS and unavailable process data', () => {
  expect(parseMemoryUsage('Rss: 4194304 kB\nPss: 3145728 kB\n')).toEqual({ residentMib: 4096, proportionalMib: 3072 })
  expect(parseMemoryUsage('')).toEqual({ residentMib: null, proportionalMib: null })
})
