import { expect, test } from 'bun:test'
import { Checkpoints, checkpointDependencies } from './checkpoints.ts'
import { VmRecord } from './state.ts'
import type { firecrackerClient } from './firecracker-api.ts'

function rig(failure = '') {
  const record = VmRecord.parse({ id: 'vm-test', name: 'test', vcpus: 2, memMib: 4096, diskGib: 16,
    slot: 0, token: 'test', image: 'test', kernel: 'test', createdAt: '', startedAt: null, bootMs: null, lastError: null })
  const events: string[] = []
  let saved = structuredClone(record)
  const step = (event: string) => { events.push(event); if (failure === event) throw new Error('injected ' + event) }
  const api: ReturnType<typeof firecrackerClient> = async (_operation, body) => { step((body as { state: string }).state); return undefined as never }
  const deps: typeof checkpointDependencies = {
    ...checkpointDependencies,
    firecracker: { ...checkpointDependencies.firecracker, isRunning: async () => true, api: () => api },
    guestClient: () => ({ exec: async () => { step('sync'); return { exitCode: 0 } } }) as never,
    zfs: { ...checkpointDependencies.zfs,
      snapshot: async () => { step('snapshot') }, syncPool: async () => { step('pool-sync') },
      destroy: async () => { step('destroy'); return '' }, rollback: async () => { step('rollback') }, volumeSizeGib: async () => 20 },
    writeRecord: async (next) => {
      saved = structuredClone(next)
      // Includes an error *after* rename: the published record must remain valid.
      step('commit')
    },
  }
  return { record, events, get saved() { return saved }, manager: new Checkpoints(deps) }
}

test('agent rollback point is synced and published before the VM is thawed', async () => {
  const r = rig()
  const point = await r.manager.create(r.record, 'Before Codex', 'codex', 'auto')
  expect(r.events).toEqual(['sync', 'Paused', 'snapshot', 'pool-sync', 'commit', 'Resumed'])
  expect(r.saved.runCheckpoints).toEqual([point])
  expect(point.mode).toBe('auto')
})

for (const failure of ['Paused', 'snapshot', 'pool-sync', 'commit']) {
  test(`checkpoint failure at ${failure} always thaws the VM`, async () => {
    const r = rig(failure)
    await expect(r.manager.create(r.record, 'Before Claude')).rejects.toThrow('injected')
    expect(r.events.at(-1)).toBe('Resumed')
    if (failure === 'pool-sync') expect(r.events).toContain('destroy')
    if (failure === 'commit') {
      expect(r.saved.runCheckpoints).toHaveLength(1)
      expect(r.events).not.toContain('destroy')
    }
  })
}

test('rollback drops newer points and reads the actual disk size', async () => {
  const r = rig()
  const first = await r.manager.create(r.record, 'First')
  await r.manager.create(r.record, 'Second')
  await r.manager.restore(r.record, first.id)
  expect(r.record.runCheckpoints).toEqual([first])
  expect(r.record.diskGib).toBe(20)
  expect(r.record.paused).toBe(false)
})
