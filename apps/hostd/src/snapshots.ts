import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { config } from './config.ts'
import * as firecracker from './firecracker.ts'
import { guestClient, waitForGuest } from './guest.ts'
import { createTap, deleteTap, slotAddresses } from './network.ts'
import { vmDir, writeRecord, type Checkpoint, type VmRecord } from './state.ts'
import * as zfs from './zfs.ts'

export const snapshotDependencies = { firecracker, zfs, mkdir, rm, vmDir, writeRecord, createTap, deleteTap, guestClient, waitForGuest }

// VmManager holds its lifecycle mutex around these operations. Each generation
// is immutable: a resumed Firecracker process demand-pages its memory file for
// its entire lifetime, so the next pause must never overwrite that file.
export class Snapshots {
  constructor(private readonly deps = snapshotDependencies) {}

  paths(record: VmRecord, checkpoint: Checkpoint) {
    const dir = `${this.deps.vmDir(record.id)}/snapshots/${checkpoint.id}`
    return { dir, state: `${dir}/state`, memory: `${dir}/memory`, disk: `${config.pool}/vms/${record.id}/root@pause-${checkpoint.id}` }
  }

  async pause(record: VmRecord) {
    const started = performance.now()
    const d = this.deps
    const api = d.firecracker.api(record.id)
    const info = await api('GET /', undefined)
    const checkpoint: Checkpoint = { id: randomUUID(), createdAt: new Date().toISOString(), firecrackerVersion: info.vmm_version }
    const files = this.paths(record, checkpoint)
    const previous = record.checkpoint
    let frozen = false
    let diskSaved = false
    let committed = false
    let manifestAttempted = false
    const discardIncomplete = async () => {
      if (diskSaved) await d.zfs.destroy(files.disk).catch(() => {})
      await d.rm(files.dir, { recursive: true, force: true }).catch(() => {})
    }
    await d.mkdir(files.dir, { recursive: true, mode: 0o700 })
    try {
      await api('PATCH /vm', { state: 'Paused' })
      frozen = true
      // Firecracker also drains and fsyncs the block device before returning.
      await api('PUT /snapshot/create', {
        snapshot_type: 'Full', snapshot_path: files.state, mem_file_path: files.memory,
        sync_snapshot_files: true,
      }, 300_000)
      await d.zfs.snapshot(files.disk)
      diskSaved = true
      await d.zfs.syncPool(config.pool)
      const next = { ...record, checkpoint, paused: true, pauseMs: Math.round(performance.now() - started), lastError: null }
      manifestAttempted = true
      await d.writeRecord(next)
      Object.assign(record, next)
      committed = true
      // A graceful shutdown would change the disk after its matching memory
      // snapshot. Kill the frozen VMM, freeing its RAM without running the guest.
      await d.firecracker.kill(record.id)
      await d.deleteTap(record.slot)
    } catch (error) {
      // An out-of-space snapshot must be removable without writing more data.
      // Until manifest publication is attempted, the old record is untouched.
      if (!committed && !manifestAttempted) await discardIncomplete()
      // A transport error can hide a successful PATCH. Inspect the VMM before
      // assuming that a failed pause request left its vCPUs running.
      if (!committed && (frozen || (await api('GET /', undefined)).state === 'Paused')) {
        // Clear a possibly published manifest before letting the guest write
        // again. If this fails, leave the VM frozen for startup reconciliation.
        if (manifestAttempted) await d.writeRecord(record)
        await api('PATCH /vm', { state: 'Resumed' })
      }
      if (!committed && manifestAttempted) await discardIncomplete()
      throw error
    }
    // The previous memory file is no longer mapped now that its VMM is dead.
    if (previous) await this.discard(record, previous).catch((error) => console.error('old checkpoint cleanup:', error))
  }

  async resume(record: VmRecord, started = performance.now()) {
    const d = this.deps
    const checkpoint = record.checkpoint
    if (!checkpoint) throw new Error('no saved snapshot for this VM')
    const files = this.paths(record, checkpoint)
    try {
      if (await d.firecracker.isRunning(record.id)) await d.firecracker.kill(record.id)
      // Also resets disk writes made by a restore that failed after unpausing.
      await d.zfs.rollback(files.disk)
      await d.createTap(record.slot)
      const root = record.rootPath ? { source: d.zfs.zvolDevice(`${config.pool}/vms/${record.id}/root`), target: record.rootPath } : undefined
      await d.firecracker.launchForRestore(record.id, `${d.vmDir(record.id)}/metadata.json`, root)
      const info = await d.firecracker.waitForApi(record.id)
      if (info.vmm_version !== checkpoint.firecrackerVersion) {
        throw new Error(`snapshot needs Firecracker ${checkpoint.firecrackerVersion}; installed ${info.vmm_version}`)
      }
      const api = d.firecracker.api(record.id)
      await api('PUT /snapshot/load', {
        snapshot_path: files.state, mem_backend: { backend_type: 'File', backend_path: files.memory },
        network_overrides: [{ iface_id: 'eth0', host_dev_name: slotAddresses(record.slot).tap }],
        resume_vm: false, clock_realtime: true,
      })
      // MMDS configuration survives a snapshot; its contents do not.
      const net = slotAddresses(record.slot)
      await api('PUT /mmds', {
        substrate: { vmId: record.id, name: record.name, token: record.token, guestIp: net.guestIp, hostIp: net.hostIp },
      })
      await api('PATCH /vm', { state: 'Resumed' })
      const health = await d.waitForGuest(d.guestClient(net.guestIp, record.token), {
        timeoutMs: config.bootTimeoutMs,
        alive: () => d.firecracker.isRunning(record.id),
      })
      if (health.vmId !== record.id) throw new Error('restored guest identity does not match this VM')
      const next = {
        ...record, paused: false, lastError: null, resumeMs: Math.round(performance.now() - started),
        awakeSince: new Date().toISOString(),
      }
      await d.writeRecord(next)
      Object.assign(record, next)
    } catch (error) {
      // Keep the original checkpoint for retry; never silently cold-boot.
      // Don't release the TAP or mark it down until the VMM is really gone.
      await d.firecracker.kill(record.id)
      await d.deleteTap(record.slot)
      record.lastError = error instanceof Error ? error.message : String(error)
      await d.writeRecord(record)
      throw error
    }
  }

  async reconcile(record: VmRecord) {
    const d = this.deps
    const running = await d.firecracker.isRunning(record.id)
    if (record.paused) {
      // A hostd crash after manifest commit but before killing Firecracker.
      if (running) await d.firecracker.kill(record.id)
      await d.deleteTap(record.slot)
    } else if (running) {
      // A crash after PATCH Paused but before publishing a complete checkpoint.
      const info = await d.firecracker.api(record.id)('GET /', undefined)
      if (info.state === 'Paused') await d.firecracker.api(record.id)('PATCH /vm', { state: 'Resumed' })
    } else {
      await d.deleteTap(record.slot)
    }
  }

  async discard(record: VmRecord, checkpoint: Checkpoint) {
    const files = this.paths(record, checkpoint)
    if (await this.deps.zfs.datasetExists(files.disk)) await this.deps.zfs.destroy(files.disk)
    await this.deps.rm(files.dir, { recursive: true, force: true })
  }
}
