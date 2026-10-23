import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firecrackerClient } from './firecracker-api.ts'
import { Snapshots, snapshotDependencies } from './snapshots.ts'
import { VmRecord } from './state.ts'

const directories: string[] = []
afterAll(async () => { for (const dir of directories) await rm(dir, { recursive: true, force: true }) })

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), 'substrate-snapshot-test-'))
  directories.push(dir)
  const record = VmRecord.parse({
    id: 'vm-abc', name: 'demo', vcpus: 6, memMib: 16_384, diskGib: 32, slot: 0,
    token: 'guest-token', image: 'test', kernel: '/test/kernel', createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(), bootMs: 2_000, lastError: null,
  })
  let saved = structuredClone(record)
  let running = true
  let state = 'Running'
  let failure = ''
  let disk = 'disk-at-pause'
  let memory = 'memory-at-pause'
  const memories = new Map<string, string>()
  const disks = new Map<string, string>()
  const events: string[] = []
  const step = (name: string) => {
    events.push(name)
    if (failure === name) { failure = ''; throw new Error(`injected ${name} failure`) }
  }
  const api: ReturnType<typeof firecrackerClient> = async (operation, body) => {
    step(operation === 'PATCH /vm' ? `vm:${(body as { state: string }).state}` : operation)
    let result: unknown
    if (operation === 'GET /') result = { state, vmm_version: '1.17.0', app_name: 'Firecracker', id: 'test' }
    if (operation === 'PATCH /vm') state = (body as { state: string }).state === 'Paused' ? 'Paused' : 'Running'
    if (operation === 'PUT /snapshot/create') {
      const paths = body as { mem_file_path: string; snapshot_path: string }
      memories.set(paths.mem_file_path, memory)
      await Bun.write(paths.mem_file_path, memory)
      await Bun.write(paths.snapshot_path, 'state')
    }
    if (operation === 'PUT /snapshot/load') {
      expect(body).toHaveProperty('network_overrides', [{ iface_id: 'eth0', host_dev_name: `sbx${record.slot}` }])
      const path = (body as { mem_backend: { backend_path: string } }).mem_backend.backend_path
      memory = memories.get(path)!
      state = 'Paused'
    }
    return result as never
  }
  const dependencies: typeof snapshotDependencies = {
    ...snapshotDependencies,
    vmDir: () => dir,
    writeRecord: async (next) => { step('commit'); saved = structuredClone(next) },
    createTap: async () => { step('tap:create') },
    deleteTap: async () => { step('tap:delete') },
    firecracker: {
      ...snapshotDependencies.firecracker,
      api: () => api,
      isRunning: async () => running,
      kill: async () => { step('kill'); running = false },
      launchForRestore: async () => { step('launch'); running = true; state = 'Not started' },
      waitForApi: async () => ({ state: 'Not started', vmm_version: '1.17.0', app_name: 'Firecracker', id: 'test' }),
    },
    zfs: {
      ...snapshotDependencies.zfs,
      snapshot: async (name) => { step('disk:snapshot'); disks.set(name, disk) },
      syncPool: async () => { step('disk:sync') },
      rollback: async (name) => { step('disk:rollback'); disk = disks.get(name)! },
      datasetExists: async (name) => disks.has(name),
      snapshots: async (dataset) => [...disks.keys()].filter((name) => name.startsWith(`${dataset}@`)),
      destroy: async (name) => { step('disk:destroy'); disks.delete(name); return '' },
    },
    waitForGuest: async () => { step('guest:ready'); return { ok: true, vmId: record.id, version: 'test', uptimeMs: 500 } },
  }
  return {
    record, events, dependencies, snapshots: new Snapshots(dependencies),
    get saved() { return structuredClone(saved) },
    get running() { return running },
    get state() { return state },
    get memory() { return memory },
    get disk() { return disk },
    fail: (step: string) => { failure = step },
    change: () => { memory = 'memory-after-resume'; disk = 'disk-after-resume' },
  }
}

describe('snapshot lifecycle', () => {
  test('publishes matching memory and disk before releasing the VM', async () => {
    const r = await rig()
    await r.snapshots.pause(r.record)
    expect(r.events).toEqual(['GET /', 'vm:Paused', 'PUT /snapshot/create', 'disk:snapshot', 'disk:sync', 'commit', 'kill', 'tap:delete'])
    expect(r.saved.paused).toBe(true)
    expect(r.running).toBe(false)
    const checkpoint = r.saved.checkpoint!
    await r.snapshots.resume(r.record)
    expect(r.memory).toBe('memory-at-pause')
    expect(r.disk).toBe('disk-at-pause')
    expect(r.saved.paused).toBe(false)
    expect(r.saved.checkpoint).toEqual(checkpoint)
    expect(r.saved.resumeMs).toBeNumber()
    expect(r.events.indexOf('PUT /mmds')).toBeLessThan(r.events.lastIndexOf('vm:Resumed'))
  })

  test('a new manager restores after a host restart using only the durable record', async () => {
    const r = await rig()
    await r.snapshots.pause(r.record)
    const recovered = VmRecord.parse(r.saved)
    const manager = new Snapshots(r.dependencies)
    await manager.reconcile(recovered)
    await manager.resume(recovered)
    expect(r.saved.paused).toBe(false)
    expect(r.running).toBe(true)
    expect(r.memory).toBe('memory-at-pause')
  })

  test('a later pause never overwrites the memory file of the running restore', async () => {
    const r = await rig()
    await r.snapshots.pause(r.record)
    const first = r.snapshots.paths(r.record, r.record.checkpoint!)
    await r.snapshots.resume(r.record)
    r.change()
    await r.snapshots.pause(r.record)
    const second = r.snapshots.paths(r.record, r.record.checkpoint!)
    expect(first.memory).not.toBe(second.memory)
    expect(await Bun.file(second.memory).text()).toBe('memory-after-resume')
    expect(await Bun.file(first.memory).exists()).toBe(false)
    expect(r.events.lastIndexOf('kill')).toBeLessThan(r.events.lastIndexOf('disk:destroy'))
  })

  for (const failedStep of ['PUT /snapshot/create', 'disk:snapshot', 'disk:sync', 'commit']) {
    test(`a failed ${failedStep} returns the original live VM to service`, async () => {
      const r = await rig()
      r.fail(failedStep)
      await expect(r.snapshots.pause(r.record)).rejects.toThrow('injected')
      expect(r.running).toBe(true)
      expect(r.state).toBe('Running')
      expect(r.saved.paused).toBe(false)
      expect(r.saved.checkpoint).toBeNull()
      expect(r.events).not.toContain('kill')
    })
  }

  test('failure after checkpoint commit keeps a resumable checkpoint', async () => {
    const r = await rig()
    r.fail('kill')
    await expect(r.snapshots.pause(r.record)).rejects.toThrow('injected')
    expect(r.saved.paused).toBe(true)
    await r.snapshots.reconcile(r.saved)
    expect(r.running).toBe(false)
    await r.snapshots.resume(r.record)
    expect(r.memory).toBe('memory-at-pause')
  })

  test('a full disk during snapshot creation can thaw without another manifest write', async () => {
    const r = await rig()
    const snapshots = new Snapshots({ ...r.dependencies, writeRecord: async () => { throw new Error('disk full') } })
    r.fail('PUT /snapshot/create')
    await expect(snapshots.pause(r.record)).rejects.toThrow('injected PUT /snapshot/create')
    expect(r.state).toBe('Running')
    expect(r.running).toBe(true)
    expect(r.saved.paused).toBe(false)
  })

  test('a failed restore retains its checkpoint and rolls disk back before retry', async () => {
    const r = await rig()
    await r.snapshots.pause(r.record)
    const checkpoint = r.saved.checkpoint
    r.fail('guest:ready')
    await expect(r.snapshots.resume(r.record)).rejects.toThrow('injected')
    r.change() // Writes made after the failed unpause must not corrupt the next restore.
    expect(r.saved.checkpoint).toEqual(checkpoint)
    expect(r.saved.paused).toBe(true)
    expect(r.running).toBe(false)
    await r.snapshots.resume(r.record)
    expect(r.disk).toBe('disk-at-pause')
    expect(r.memory).toBe('memory-at-pause')
    expect(r.saved.lastError).toBeNull()
  })

  test('startup thaws an interrupted pause that never committed a checkpoint', async () => {
    const r = await rig()
    await r.dependencies.firecracker.api(r.record.id)('PATCH /vm', { state: 'Paused' })
    await r.snapshots.reconcile(r.record)
    expect(r.state).toBe('Running')
    expect(r.running).toBe(true)
  })

  test('a lost response after PATCH Paused does not leave the original VM frozen', async () => {
    const r = await rig()
    const api = r.dependencies.firecracker.api(r.record.id)
    let lost = false
    const droppedResponse: ReturnType<typeof firecrackerClient> = async (operation, body, timeout) => {
      const result = await api(operation, body, timeout)
      if (operation === 'PATCH /vm' && (body as { state: string }).state === 'Paused' && !lost) {
        lost = true
        throw new Error('lost response')
      }
      return result
    }
    const snapshots = new Snapshots({ ...r.dependencies, firecracker: { ...r.dependencies.firecracker, api: () => droppedResponse } })
    await expect(snapshots.pause(r.record)).rejects.toThrow('lost response')
    expect(r.state).toBe('Running')
    expect(r.saved.paused).toBe(false)
  })

  test('refuses a different Firecracker version while preserving the checkpoint', async () => {
    const r = await rig()
    await r.snapshots.pause(r.record)
    r.record.checkpoint!.firecrackerVersion = '1.16.0'
    await expect(r.snapshots.resume(r.record)).rejects.toThrow('needs Firecracker 1.16.0')
    expect(r.saved.paused).toBe(true)
    expect(r.running).toBe(false)
    expect(r.events).not.toContain('PUT /snapshot/load')
  })

  test('a restore refuses the wrong guest identity and retains the saved checkpoint', async () => {
    const r = await rig()
    await r.snapshots.pause(r.record)
    const snapshots = new Snapshots({ ...r.dependencies,
      waitForGuest: async () => ({ ok: true, vmId: 'vm-other', version: 'test', uptimeMs: 100 }),
    })
    await expect(snapshots.resume(r.record)).rejects.toThrow('identity')
    expect(r.saved.paused).toBe(true)
    expect(r.running).toBe(false)
  })

  test('startup removes saves the record no longer names, keeping the one in use', async () => {
    const r = await rig()
    await r.snapshots.pause(r.record)
    await r.snapshots.resume(r.record)
    const kept = r.snapshots.paths(r.record, r.record.checkpoint!)
    // Left by crashes: an uncommitted pause, and a fork's staging snapshot.
    const orphan = r.snapshots.paths(r.record, { ...r.record.checkpoint!, id: randomUUID() })
    await Bun.write(orphan.memory, 'orphan')
    await r.dependencies.zfs.snapshot(orphan.disk)
    await r.dependencies.zfs.snapshot('substrate/vms/vm-abc@fork-left-behind')
    expect(await r.snapshots.prune(r.record)).toHaveLength(3)
    // The running VM still reads this memory file.
    expect(await Bun.file(kept.memory).exists()).toBe(true)
    expect(await r.dependencies.zfs.datasetExists(kept.disk)).toBe(true)
    expect(await Bun.file(orphan.memory).exists()).toBe(false)
    expect(await r.dependencies.zfs.datasetExists(orphan.disk)).toBe(false)
    expect(await r.dependencies.zfs.datasetExists('substrate/vms/vm-abc@fork-left-behind')).toBe(false)
    expect(await r.snapshots.prune(r.record)).toEqual([])
  })

  test('a removal that fails never stops startup', async () => {
    const r = await rig()
    await r.dependencies.zfs.snapshot('substrate/vms/vm-abc/root@pause-stuck')
    await r.dependencies.zfs.snapshot('substrate/vms/vm-abc@fork-gone')
    const zfs = { ...r.dependencies.zfs, destroy: async (name: string) => {
      if (name.endsWith('@pause-stuck')) throw new Error('dataset is busy')
      return r.dependencies.zfs.destroy(name)
    } }
    const snapshots = new Snapshots({ ...r.dependencies, zfs })
    expect(await snapshots.prune(r.record)).toEqual(['snapshot fork-gone'])
  })
})
