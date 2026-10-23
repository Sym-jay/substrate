import { randomUUID } from 'node:crypto'
import { type Agent, type AgentMode, type RunCheckpoint } from '@substrate/protocol'
import { config } from './config.ts'
import * as firecracker from './firecracker.ts'
import { guestClient } from './guest.ts'
import { slotAddresses } from './network.ts'
import { writeRecord, type VmRecord } from './state.ts'
import * as zfs from './zfs.ts'

export const runSnapshot = (record: VmRecord, id: string) => `${config.pool}/vms/${record.id}/root@run-${id}`
export const checkpointDependencies = { firecracker, guestClient, zfs, writeRecord }

// Called with the VM lifecycle mutex held. These are disk rollback points;
// restoring one requires a stopped VM and starts a fresh guest afterwards.
export class Checkpoints {
  constructor(private readonly deps = checkpointDependencies) {}

  async create(record: VmRecord, label: string, agent: Agent | null = null, mode: AgentMode | null = null) {
    const d = this.deps
    const running = await d.firecracker.isRunning(record.id)
    const point: RunCheckpoint = { id: randomUUID(), createdAt: new Date().toISOString(), label, agent, mode, sessionId: null }
    const snapshot = runSnapshot(record, point.id)
    let saved = false
    let manifestAttempted = false
    let pauseAttempted = false
    try {
      if (running) {
        const sync = await d.guestClient(slotAddresses(record.slot).guestIp, record.token)
          .exec({ command: 'sync', user: 'root', timeoutMs: 10_000 })
        if (sync.exitCode !== 0) throw new Error('could not sync the workspace before its checkpoint')
        pauseAttempted = true
        await d.firecracker.api(record.id)('PATCH /vm', { state: 'Paused' })
      }
      await d.zfs.snapshot(snapshot)
      saved = true
      await d.zfs.syncPool(config.pool)
      const next = { ...record, runCheckpoints: [...record.runCheckpoints, point] }
      manifestAttempted = true
      await d.writeRecord(next)
      Object.assign(record, next)
      return point
    } catch (error) {
      // A failed fsync may still have published the manifest. Retaining an
      // orphan snapshot is safer than deleting a potentially referenced one.
      if (saved && !manifestAttempted) await d.zfs.destroy(snapshot).catch(() => {})
      throw error
    } finally {
      // Also covers a transport error after Firecracker accepted Paused.
      if (pauseAttempted) await d.firecracker.api(record.id)('PATCH /vm', { state: 'Resumed' })
    }
  }

  async restore(record: VmRecord, id: string) {
    const index = record.runCheckpoints.findIndex((point) => point.id === id)
    if (index < 0) throw new Error('checkpoint not found')
    // Publish the shorter manifest first: rollback -r destroys later snapshots.
    // An interrupted rollback can be retried; it must not leave references to
    // snapshots that no longer exist.
    const next = { ...record, runCheckpoints: record.runCheckpoints.slice(0, index + 1), lastError: null, checkpoint: null, paused: false }
    await this.deps.writeRecord(next)
    Object.assign(record, next)
    await this.deps.zfs.rollback(runSnapshot(record, id))
    record.diskGib = Math.ceil(await this.deps.zfs.volumeSizeGib(`${config.pool}/vms/${record.id}/root`))
    await this.deps.writeRecord(record)
  }
}
