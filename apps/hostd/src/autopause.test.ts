import type { AgentEvent, GuestActivity, Vm } from '@substrate/protocol'
import { describe, expect, test } from 'bun:test'
import { AutoPause } from './autopause.ts'
import type { Alert } from './notify.ts'
import type { GuestClient } from './guest.ts'

const MIN = 60_000
const T0 = Date.parse('2026-10-23T10:00:00Z')

// One running VM whose guest reports whatever `activity` holds.
function setup(vmFields: Partial<Vm> = {}) {
  let now = T0
  const vm: Vm = {
    id: 'vm-abc', name: 'demo', vcpus: 2, memMib: 4096, diskGib: 32, state: 'running', image: 'img',
    guestIp: '172.30.0.2', createdAt: '', startedAt: null, bootMs: null, lastError: null,
    awakeSince: new Date(T0).toISOString(), autoPauseMinutes: 10, ...vmFields,
  }
  let activity: GuestActivity | null = { bootId: 'boot-1', idleMs: 0, events: [] }
  const alerts: Alert[] = []
  const paused: string[] = []
  const auto = new AutoPause({
    vms: {
      list: async () => [vm],
      guest: async () => ({ activity: async () => activity }) as unknown as GuestClient,
      pause: async (id) => {
        paused.push(id)
        vm.state = 'paused'
        return vm
      },
    },
    notify: async (alert) => void alerts.push(alert),
    quietMs: 2 * MIN,
    now: () => now,
  })
  return {
    vm, alerts, paused, auto,
    advance: (ms: number) => (now += ms),
    report: (next: GuestActivity | null) => (activity = next),
  }
}

const event = (seq: number, fields: Partial<AgentEvent> = {}): AgentEvent => ({
  seq, at: '', agent: 'claude', kind: 'stop', message: null, inputIdleMs: 10 * MIN, ...fields,
})
const settle = () => Bun.sleep(0)

describe('auto-pause', () => {
  test('pauses a VM idle for its limit, then says so quietly', async () => {
    const t = setup()
    t.advance(10 * MIN)
    t.report({ bootId: 'boot-1', idleMs: 9 * MIN, events: [] })
    await t.auto.tick()
    expect(t.paused).toEqual([])
    t.report({ bootId: 'boot-1', idleMs: 10 * MIN, events: [] })
    await t.auto.tick()
    await settle()
    expect(t.paused).toEqual(['vm-abc'])
    expect(t.alerts).toMatchObject([{ title: 'demo paused', priority: 'low' }])
  })

  test('gives a freshly resumed VM a full idle period', async () => {
    const t = setup({ awakeSince: new Date(T0 + 30 * MIN).toISOString() })
    t.advance(35 * MIN)
    // The guest's idle time can include the time it spent paused.
    t.report({ bootId: 'boot-1', idleMs: 35 * MIN, events: [] })
    await t.auto.tick()
    expect(t.paused).toEqual([])
    t.advance(5 * MIN)
    await t.auto.tick()
    await settle()
    expect(t.paused).toEqual(['vm-abc'])
  })

  test('leaves alone a VM with auto-pause off, or an image without activity', async () => {
    const off = setup({ autoPauseMinutes: null })
    off.advance(60 * MIN)
    off.report({ bootId: 'boot-1', idleMs: 60 * MIN, events: [] })
    await off.auto.tick()
    const old = setup()
    old.advance(60 * MIN)
    old.report(null)
    await old.auto.tick()
    await settle()
    expect([...off.paused, ...old.paused]).toEqual([])
  })

  test('forwards each new agent event once, skipping what happened before hostd started', async () => {
    const t = setup({ autoPauseMinutes: null })
    t.report({ bootId: 'boot-1', idleMs: 0, events: [event(1)] })
    await t.auto.tick()
    expect(t.alerts).toEqual([])
    t.report({ bootId: 'boot-1', idleMs: 0, events: [event(1), event(2), event(3, { kind: 'attention', message: 'Claude needs your permission to use Bash' })] })
    await t.auto.tick()
    await t.auto.tick()
    expect(t.alerts).toMatchObject([
      { title: 'Claude Code finished', message: 'demo is ready for your next prompt.', priority: 'default' },
      { title: 'Claude Code needs you', message: 'demo: Claude needs your permission to use Bash', priority: 'high' },
    ])
  })

  test('stays quiet while someone is typing, and for prompts being submitted', async () => {
    const t = setup({ autoPauseMinutes: null })
    await t.auto.tick()
    t.report({ bootId: 'boot-1', idleMs: 0, events: [event(1, { inputIdleMs: 30_000 }), event(2, { kind: 'start' })] })
    await t.auto.tick()
    expect(t.alerts).toEqual([])
    // Nobody has typed at all: an agent started without a terminal.
    t.report({ bootId: 'boot-1', idleMs: 0, events: [event(3, { inputIdleMs: null })] })
    await t.auto.tick()
    expect(t.alerts).toHaveLength(1)
  })

  test('starts over when guestd restarts', async () => {
    const t = setup({ autoPauseMinutes: null })
    t.report({ bootId: 'boot-1', idleMs: 0, events: [event(1), event(2), event(3)] })
    await t.auto.tick()
    t.report({ bootId: 'boot-2', idleMs: 0, events: [event(1, { agent: 'codex' })] })
    await t.auto.tick()
    expect(t.alerts).toMatchObject([{ title: 'Codex finished' }])
  })
})
