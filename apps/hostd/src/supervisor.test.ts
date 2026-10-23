import type { PoolStatus, Vm } from '@substrate/protocol'
import { describe, expect, test } from 'bun:test'
import type { Alert } from './notify.ts'
import { Supervisor } from './supervisor.ts'

const MIN = 60_000

function setup() {
  let now = Date.parse('2026-10-23T10:00:00Z')
  const vm = { id: 'vm-abc', name: 'demo' } as Vm
  let down = true
  let bootFails = false
  let pool: PoolStatus = { health: 'ONLINE', sizeGib: 49, usedPct: 20 }
  const recovered: string[] = []
  const alerts: Alert[] = []
  const supervisor = new Supervisor({
    vms: {
      crashed: async () => (down ? [vm] : []),
      recover: async (id) => {
        recovered.push(id)
        if (bootFails) throw new Error('boot failed')
        down = false
        return vm
      },
    },
    pool: async () => pool,
    notify: async (alert) => void alerts.push(alert),
    now: () => now,
  })
  return {
    supervisor, recovered, alerts,
    advance: (ms: number) => (now += ms),
    crash: () => (down = true),
    failBoots: () => (bootFails = true),
    setPool: (next: Partial<PoolStatus>) => (pool = { ...pool, ...next }),
  }
}

const settle = () => Bun.sleep(0)

describe('crashed VMs', () => {
  test('come back, with an alert', async () => {
    const t = setup()
    await t.supervisor.tick()
    await settle()
    expect(t.recovered).toEqual(['vm-abc'])
    expect(t.alerts).toMatchObject([{ title: 'demo was restarted' }])
  })

  test('are left stopped after going down 3 times in 30 minutes', async () => {
    const t = setup()
    t.failBoots()
    for (let i = 0; i < 5; i++) {
      await t.supervisor.tick()
      t.advance(MIN)
    }
    await settle()
    expect(t.recovered).toHaveLength(3)
    expect(t.alerts).toMatchObject([{ title: 'demo keeps going down', priority: 'high' }])
    // Half an hour on, it gets another chance.
    t.advance(30 * MIN)
    await t.supervisor.tick()
    expect(t.recovered).toHaveLength(4)
  })
})

describe('the storage pool', () => {
  test('warns at 80% and 90% full, once each until it drops back', async () => {
    const t = setup()
    const check = async (usedPct: number) => {
      t.setPool({ usedPct })
      t.advance(MIN)
      await t.supervisor.tick()
      await settle()
    }
    await check(50)
    await check(81)
    await check(85)
    await check(92)
    await check(95)
    await check(78)
    await check(82)
    await check(60)
    await check(83)
    const pool = t.alerts.filter((a) => a.vm === null).map((a) => [a.title, a.priority])
    expect(pool).toEqual([
      ['Host storage 81% full', 'default'],
      ['Host storage 92% full', 'high'],
      ['Host storage 83% full', 'default'],
    ])
  })

  test('says when it stops being healthy', async () => {
    const t = setup()
    t.setPool({ health: 'DEGRADED' })
    await t.supervisor.tick()
    t.advance(MIN)
    await t.supervisor.tick()
    await settle()
    expect(t.alerts.filter((a) => a.vm === null)).toMatchObject([{ title: 'Host storage is DEGRADED', priority: 'high' }])
  })
})
