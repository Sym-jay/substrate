import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { LifecycleProfile } from './lifecycle-profile.ts'
import { config } from './config.ts'
import { message } from './errors.ts'
import * as firecracker from './firecracker.ts'
import { guestClient, waitForGuest } from './guest.ts'
import { deleteTap, slotAddresses } from './network.ts'
import { vmDir, writeRecord, type Checkpoint, type VmRecord } from './state.ts'
import * as vmm from './vmm.ts'
import * as zfs from './zfs.ts'
import { captureWorkingSet, prefetchWorkingSet, saveWorkingSet } from './resume-prefetch.ts'

export const snapshotDependencies = {
  firecracker, zfs, mkdir, readdir, rm, vmDir, writeRecord, deleteTap, guestClient, waitForGuest,
  startNetwork: vmm.startNetwork, launchForRestore: vmm.launchForRestore, ownSnapshotDir: vmm.ownSnapshotDir,
  captureWorkingSet, prefetchWorkingSet, saveWorkingSet,
  resumePrefetch: () => config.resumePrefetch,
}

// VmManager holds its lifecycle mutex around these operations. Each generation
// is immutable: a resumed Firecracker process demand-pages its memory file for
// its entire lifetime, so the next pause must never overwrite that file.
export class Snapshots {
  constructor(private readonly deps = snapshotDependencies) {}

  // `load` is where Firecracker sees the files: in its chroot, if it's jailed.
  paths(record: VmRecord, checkpoint: Checkpoint) {
    const base = vmm.isJailed(record) ? `${firecracker.jailRoot(record.id)}/snapshots` : `${this.deps.vmDir(record.id)}/snapshots`
    const dir = `${base}/${checkpoint.id}`
    const seen = vmm.isJailed(record) ? `/snapshots/${checkpoint.id}` : dir
    return {
      dir, state: `${dir}/state`, memory: `${dir}/memory`, disk: `${config.pool}/vms/${record.id}/root@pause-${checkpoint.id}`,
      load: { state: `${seen}/state`, memory: `${seen}/memory` },
    }
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
    await d.ownSnapshotDir(record, files.dir)
    try {
      await api('PATCH /vm', { state: 'Paused' })
      frozen = true
      const workingSet = previous && d.resumePrefetch() ? await d.captureWorkingSet(record.id, this.paths(record, previous).memory) : null
      // Firecracker also drains and fsyncs the block device before returning.
      await api('PUT /snapshot/create', {
        snapshot_type: 'Full', snapshot_path: files.load.state, mem_file_path: files.load.memory,
        sync_snapshot_files: true,
      }, 300_000)
      await d.saveWorkingSet(`${files.dir}/working-set.json`, workingSet)
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
    const profile = new LifecycleProfile('resume', record.id, started)
    let ok = false
    try {
      if (await profile.measure('processCheck', () => d.firecracker.isRunning(record.id))) await profile.measure('processStop', () => d.firecracker.kill(record.id))
      // Also resets disk writes made by a restore that failed after unpausing.
      // The disk and the network namespace are independent. Join both before
      // launching, including on failure, so cleanup cannot race a late setup.
      const prepared = await Promise.allSettled([
        profile.measure('diskRollback', () => d.zfs.rollback(files.disk)),
        profile.measure('network', () => d.startNetwork(record)),
        profile.measure('prefetch', async () => {
          profile.counters.prefetchedBytes = d.resumePrefetch()
            ? await d.prefetchWorkingSet(files.memory, `${files.dir}/working-set.json`) : 0
        }),
      ])
      for (const result of prepared) if (result.status === 'rejected') throw result.reason
      await profile.measure('firecrackerLaunch', () => d.launchForRestore(record))
      const info = await profile.measure('apiReady', () => d.firecracker.waitForApi(record.id))
      if (info.vmm_version !== checkpoint.firecrackerVersion) {
        throw new Error(`snapshot needs Firecracker ${checkpoint.firecrackerVersion}; installed ${info.vmm_version}`)
      }
      const api = d.firecracker.api(record.id)
      await profile.measure('snapshotLoad', () => api('PUT /snapshot/load', {
        snapshot_path: files.load.state, mem_backend: { backend_type: 'File', backend_path: files.load.memory },
        network_overrides: [{ iface_id: 'eth0', host_dev_name: vmm.tapName(record) }],
        resume_vm: false, clock_realtime: true,
      }))
      // MMDS configuration survives a snapshot; its contents do not.
      const net = slotAddresses(record.slot)
      await profile.measure('metadata', () => api('PUT /mmds', vmm.metadata(record)))
      await profile.measure('unpause', () => api('PATCH /vm', { state: 'Resumed' }))
      const health = await profile.measure('guestReady', () => d.waitForGuest(d.guestClient(net.guestIp, record.token), {
        timeoutMs: config.bootTimeoutMs,
        // Cold memory faults can outlast 250 ms. Give the first valid request
        // time to complete; avoid aborting it and opening another connection.
        probeTimeoutMs: 1000,
        alive: () => d.firecracker.isRunning(record.id),
      }))
      if (health.vmId !== record.id) throw new Error('restored guest identity does not match this VM')
      const next = {
        ...record, paused: false, lastError: null, resumeMs: Math.round(performance.now() - started),
        awakeSince: new Date().toISOString(),
      }
      await profile.measure('recordCommit', () => d.writeRecord(next))
      Object.assign(record, next)
      ok = true
    } catch (error) {
      // Keep the original checkpoint for retry; never silently cold-boot.
      // Don't release the TAP or mark it down until the VMM is really gone.
      await d.firecracker.kill(record.id)
      await d.deleteTap(record.slot)
      record.lastError = error instanceof Error ? error.message : String(error)
      await d.writeRecord(record)
      throw error
    } finally { profile.finish(ok ? 'ok' : 'failed') }
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

  // Deletes saves the VM's record doesn't refer to: a crash mid-pause or
  // mid-fork, or a rollback, can leave their memory files (as big as the VM's
  // RAM) and ZFS snapshots behind. Only for hostd's startup, when no pause or
  // fork can be under way. The save the record names stays, since a VM
  // resumed from it reads its memory file for as long as it runs.
  async prune(record: VmRecord) {
    const d = this.deps
    const keep = record.checkpoint?.id
    const removed: string[] = []
    const attempt = async (what: string, remove: () => Promise<unknown>) => {
      try {
        await remove()
        removed.push(what)
      } catch (err) {
        console.error(`prune ${record.id}: couldn't remove ${what}: ${message(err)}`)
      }
    }
    // Saves can be in either place: a VM can change isolation between boots.
    for (const dir of [`${d.vmDir(record.id)}/snapshots`, `${firecracker.jailRoot(record.id)}/snapshots`]) {
      for (const name of await d.readdir(dir).catch(() => [] as string[])) {
        if (name !== keep) await attempt(`saved memory ${name}`, () => d.rm(`${dir}/${name}`, { recursive: true, force: true }))
      }
    }
    const dataset = `${config.pool}/vms/${record.id}`
    const snapshots = [
      ...(await d.zfs.snapshots(`${dataset}/root`).catch(() => [] as string[])),
      ...(await d.zfs.snapshots(dataset).catch(() => [] as string[])),
    ]
    for (const snapshot of snapshots) {
      const name = snapshot.slice(snapshot.indexOf('@') + 1)
      const stale = (name.startsWith('pause-') && name !== `pause-${keep}`) || name.startsWith('fork-')
      if (stale) await attempt(`snapshot ${name}`, () => d.zfs.destroy(snapshot))
    }
    if (removed.length) console.log(`prune ${record.id}: removed ${removed.join(', ')}`)
    return removed
  }

  async discard(record: VmRecord, checkpoint: Checkpoint) {
    const files = this.paths(record, checkpoint)
    if (await this.deps.zfs.datasetExists(files.disk)) await this.deps.zfs.destroy(files.disk)
    await this.deps.rm(files.dir, { recursive: true, force: true })
  }
}
