import { describe, expect, test } from 'bun:test'
import { WarmPool, fits, parsePoolSpecs, type PoolHost, type PoolSpec, type Pooled } from './warm-pool.ts'

describe('warm pool sizes', () => {
  test('one of the default size, with the default disk, unless told otherwise', () => {
    expect(parsePoolSpecs(undefined)).toEqual([{ vcpus: 6, memMib: 16_384, diskGib: 32, count: 1 }])
    expect(parsePoolSpecs('off')).toEqual([])
    expect(parsePoolSpecs('0')).toEqual([])
  })

  test('presets and custom sizes, with a disk and a count each', () => {
    expect(parsePoolSpecs('large:1, 2x2:8, small@64:2')).toEqual([
      { vcpus: 6, memMib: 16_384, diskGib: 32, count: 1 },
      { vcpus: 2, memMib: 2_048, diskGib: 32, count: 8 },
      { vcpus: 2, memMib: 4_096, diskGib: 64, count: 2 },
    ])
    expect(parsePoolSpecs('medium:0')).toEqual([])
  })

  test('a size no VM can have is refused, as is anything unreadable', () => {
    expect(() => parsePoolSpecs('32x2:1')).toThrow()
    expect(() => parsePoolSpecs('2x1:1')).toThrow()
    expect(() => parsePoolSpecs('huge:1')).toThrow()
    expect(() => parsePoolSpecs('large')).toThrow()
  })

  test('a pooled VM fits a create of its vCPUs and memory, a disk at least its own, and open egress', () => {
    const vm = { vcpus: 6, memMib: 16_384, diskGib: 32 }
    expect(fits(vm, {})).toBe(true)
    expect(fits(vm, { size: 'large', diskGib: 64 })).toBe(true)
    expect(fits(vm, { diskGib: 16 })).toBe(false)
    expect(fits(vm, { size: 'medium' })).toBe(false)
    expect(fits(vm, { vcpus: 6, memMib: 8_192 })).toBe(false)
    expect(fits(vm, { egress: { mode: 'allowlist', allow: ['github.com'] } })).toBe(false)
  })
})

// A host whose boots wait until released, so a test can see them in flight.
function fakeHost({ image = 'img-2', freeMib = 200_000, pooled = [] as Pooled[] } = {}) {
  const booted: PoolSpec[] = []
  const discarded: string[] = []
  let inFlight = 0, maxInFlight = 0, failNext = false
  const host: PoolHost = {
    pooled: async () => pooled,
    image: async () => image,
    memFreeMib: async () => freeMib,
    boot: async (spec) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      await Bun.sleep(5)
      inFlight--
      if (failNext) { failNext = false; throw new Error('boot failed') }
      booted.push(spec)
    },
    discard: async (id) => { discarded.push(id) },
  }
  return { host, booted, discarded, maxInFlight: () => maxInFlight, failNextBoot: () => { failNext = true } }
}
const vm = (id: string, state: Pooled['state'], over: Partial<Pooled> = {}): Pooled =>
  ({ id, vcpus: 2, memMib: 2_048, diskGib: 32, image: 'img-2', state, ...over })

describe('warm pool', () => {
  const twoBy2 = { vcpus: 2, memMib: 2_048, diskGib: 32, count: 4 }

  test('tops each size up to its count, booting the missing ones side by side', async () => {
    const h = fakeHost({ pooled: [vm('a', 'ready'), vm('b', 'booting')] })
    await new WarmPool(h.host, [twoBy2], () => {}).fill()
    expect(h.booted).toHaveLength(2)
    expect(h.maxInFlight()).toBe(2)
    expect(h.discarded).toEqual([])
  })

  test('replaces VMs from an older image, of a size no longer wanted, or that went down', async () => {
    const h = fakeHost({ pooled: [vm('old', 'ready', { image: 'img-1' }), vm('dead', 'dead'), vm('big', 'ready', { memMib: 4_096 }), vm('ok', 'ready')] })
    await new WarmPool(h.host, [twoBy2], () => {}).fill()
    expect(h.discarded.sort()).toEqual(['big', 'dead', 'old'])
    expect(h.booted).toHaveLength(3)
  })

  test('never takes the last of the memory a create of that size would need', async () => {
    const h = fakeHost({ freeMib: 7_000 })
    await new WarmPool(h.host, [twoBy2], () => {}).fill()
    // 7000 MiB free: two boots leave 2904, enough for a create; a third wouldn't.
    expect(h.booted).toHaveLength(2)
  })

  test('boots nothing before there is an image', async () => {
    const h = fakeHost({ image: null as unknown as string })
    await new WarmPool(h.host, [twoBy2], () => {}).fill()
    expect(h.booted).toEqual([])
  })

  test('after a failed boot, waits a minute before trying again', async () => {
    const h = fakeHost()
    let now = 0
    const logs: string[] = []
    const pool = new WarmPool(h.host, [{ ...twoBy2, count: 1 }], (line) => logs.push(line), () => now)
    h.failNextBoot()
    await pool.fill()
    expect(logs).toEqual(['warm pool: boot failed'])
    await pool.fill()
    expect(h.booted).toHaveLength(0)
    now = 61_000
    await pool.fill()
    expect(h.booted).toHaveLength(1)
  })

  test('says how many of each size are ready and booting', async () => {
    const h = fakeHost({ pooled: [vm('a', 'ready'), vm('b', 'ready'), vm('c', 'booting'), vm('d', 'ready', { image: 'img-1' })] })
    expect(await new WarmPool(h.host, [twoBy2], () => {}).status()).toEqual([{ vcpus: 2, memMib: 2_048, diskGib: 32, want: 4, ready: 2, booting: 1 }])
  })
})
