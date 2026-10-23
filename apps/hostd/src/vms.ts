import {
  VmSizes,
  DEFAULT_AUTO_PAUSE_MINUTES,
  DEFAULT_DISK_GIB,
  DEFAULT_MAX_AWAKE_HOURS,
  DEFAULT_VM_SIZE,
  type Capacity,
  type CreateVm,
  type ExecRequest,
  type ExecResult,
  type GrowDisk,
  type UpdateVm,
  type ResizeVm,
  type ForkVm,
  type CreateSession,
  type Session,
  type RunCheckpoint,
  type Vm,
} from '@substrate/protocol'
import { randomBytes, randomUUID } from 'node:crypto'
import { hostCapacity } from './capacity.ts'
import { config } from './config.ts'
import { HttpError, message } from './errors.ts'
import * as firecracker from './firecracker.ts'
import { guestClient, waitForGuest, type GuestClient } from './guest.ts'
import { currentImage } from './images.ts'
import { Mutex } from './mutex.ts'
import { createTap, deleteTap, lowestFreeSlot, slotAddresses } from './network.ts'
import { logOnly, type Notify } from './notify.ts'
import { listRecords, readRecord, vmDir, writeRecord, type VmRecord } from './state.ts'
import { Snapshots } from './snapshots.ts'
import { Checkpoints } from './checkpoints.ts'
import { importRepository } from './repositories.ts'
import * as zfs from './zfs.ts'

// What the HTTP API needs; tests substitute a fake.
export interface VmService {
  list(): Promise<Vm[]>
  get(id: string): Promise<Vm>
  create(input: CreateVm, githubToken?: string, targetId?: string): Promise<Vm>
  start(id: string): Promise<Vm>
  stop(id: string): Promise<Vm>
  pause(id: string): Promise<Vm>
  resume(id: string): Promise<Vm>
  update(id: string, input: UpdateVm): Promise<Vm>
  resize(id: string, input: ResizeVm): Promise<Vm>
  fork(id: string, input: ForkVm, targetId?: string): Promise<Vm>
  checkpoints(id: string): Promise<RunCheckpoint[]>
  rollback(id: string, checkpointId: string): Promise<Vm>
  createSession(id: string, input: CreateSession): Promise<Session>
  growDisk(id: string, input: GrowDisk): Promise<Vm>
  remove(id: string): Promise<void>
  exec(id: string, req: ExecRequest): Promise<ExecResult>
  guest(id: string): Promise<GuestClient>
  capacity(): Promise<Capacity>
}

export { HttpError }

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
export function newVmId() {
  return `vm-${[...randomBytes(8)].map((b) => ID_ALPHABET[b % 32]).join('')}`
}

const dataset = (id: string) => `${config.pool}/vms/${id}`
const rootVolume = (id: string) => `${dataset(id)}/root`

export class VmManager implements VmService {
  // Lifecycle changes (and the capacity and slot checks before them) happen one at a time.
  private lock = new Mutex()
  private transitions = new Map<string, 'starting' | 'stopping' | 'pausing' | 'resuming' | 'forking' | 'checkpointing' | 'resizing'>()
  private snapshots = new Snapshots()
  private runCheckpoints = new Checkpoints()

  constructor(private readonly notify: Notify = logOnly) {}

  async list() {
    const records = await listRecords()
    return Promise.all(records.map((r) => this.toVm(r)))
  }

  async get(id: string) {
    return this.toVm(await this.record(id))
  }

  async create(input: CreateVm, githubToken?: string, targetId?: string) {
    const image = await currentImage()
    if (!image) throw new HttpError(409, 'no VM image yet: run `bun run images:build`')
    const size = VmSizes[input.size ?? DEFAULT_VM_SIZE]
    const diskGib = await this.checkDiskSize(input.diskGib ?? DEFAULT_DISK_GIB, image.rootfs)

    return this.lock.run(async () => {
      const records = await listRecords()
      if (input.name && records.some((r) => r.name === input.name)) {
        throw new HttpError(409, `a VM named ${input.name} already exists`)
      }
      await this.ensureFits(size.memMib)

      const id = targetId ?? newVmId()
      if (await zfs.datasetExists(dataset(id))) throw new HttpError(409, 'workspace destination already exists')
      const record: VmRecord = {
        id,
        name: input.name ?? id,
        ...size,
        diskGib,
        slot: lowestFreeSlot(records.map((r) => r.slot)),
        token: randomBytes(32).toString('hex'),
        image: image.version,
        kernel: image.kernel,
        createdAt: new Date().toISOString(),
        startedAt: null,
        bootMs: null,
        lastError: null,
        checkpoint: null,
        paused: false,
        pauseMs: null,
        resumeMs: null,
        awakeSince: null,
        autoPauseMinutes: DEFAULT_AUTO_PAUSE_MINUTES,
        runCheckpoints: [],
        repository: input.repository ?? null,
        parentId: null,
        rootPath: `${config.paths.run}/rootfs`,
        forkCapable: false,
        maxAwakeHours: DEFAULT_MAX_AWAKE_HOURS,
        shouldRun: true,
      }
      try {
        await zfs.createFilesystem(dataset(id))
        await writeRecord(record)
        await zfs.cloneVolume(image.rootfs, rootVolume(id), record.diskGib)
        await zfs.waitForDevice(zfs.zvolDevice(rootVolume(id)))
        await zfs.growFilesystem(zfs.zvolDevice(rootVolume(id)))
        await this.launch(record)
      } catch (err) {
        await this.cleanUp(record).catch(() => {})
        throw err
      }
      await this.awaitBoot(record)
      if (record.repository) {
        try { await importRepository(record, githubToken) }
        catch (error) {
          record.lastError = error instanceof Error ? error.message : String(error)
          await writeRecord(record)
          // Preserve the newly created VM for retry instead of leaking an
          // unreachable workspace behind a failed create response.
        }
      }
      return this.get(record.id)
    })
  }

  async start(id: string) {
    const started = performance.now()
    return this.lock.run(async () => {
      const record = await this.record(id)
      if (!record.shouldRun) {
        record.shouldRun = true
        await writeRecord(record)
      }
      if (record.paused) return this.restore(record, started)
      if (await firecracker.isRunning(id)) return this.get(id)
      await this.ensureFits(record.memMib)
      await this.launch(record)
      return this.awaitBoot(record)
    })
  }

  // VMs that should be running but aren't, and weren't paused: after a host
  // crash or reboot, a guest kernel panic, or `sudo reboot` inside the VM.
  async crashed() {
    const vms: Vm[] = []
    for (const record of await listRecords()) {
      if (!record.shouldRun || record.paused || this.transitions.has(record.id)) continue
      if (!(await firecracker.isRunning(record.id))) vms.push(await this.toVm(record))
    }
    return vms
  }

  // Boots a crashed VM again, reopening the sessions it had.
  async recover(id: string) {
    return this.lock.run(async () => {
      const record = await this.record(id)
      if (!record.shouldRun || record.paused || (await firecracker.isRunning(id))) return this.toVm(record)
      await this.ensureFits(record.memMib)
      await this.launch(record, { resumeSessions: true })
      return this.awaitBoot(record)
    })
  }

  async pause(id: string) {
    return this.lock.run(async () => {
      const record = await this.record(id)
      if (record.paused) {
        await this.snapshots.reconcile(record)
        return this.get(id)
      }
      if (!(await firecracker.isRunning(id))) throw new HttpError(409, `${record.name} isn't running`)
      this.transitions.set(id, 'pausing')
      try {
        await this.snapshots.pause(record)
      } catch (error) {
        throw new HttpError(502, `couldn't pause ${record.name}: ${error instanceof Error ? error.message : error}`)
      } finally { this.transitions.delete(id) }
      return this.get(id)
    })
  }

  async resume(id: string) {
    const started = performance.now()
    return this.lock.run(async () => {
      const record = await this.record(id)
      if (!record.paused) {
        if (await firecracker.isRunning(id)) return this.get(id)
        throw new HttpError(409, `${record.name} has no paused session; start it instead`)
      }
      return this.restore(record, started)
    })
  }

  private async restore(record: VmRecord, started: number) {
    // Finish an interrupted pause first, so its still-frozen VMM isn't charged
    // twice by the capacity check for this same workspace.
    if (await firecracker.isRunning(record.id)) await this.snapshots.reconcile(record)
    await this.ensureFits(record.memMib)
    this.transitions.set(record.id, 'resuming')
    let failure: unknown
    let resumed = false
    try {
      // Twice, since a restore can fail for passing reasons; the save is kept
      // for exactly that.
      for (let attempt = 1; attempt <= 2 && !resumed; attempt++) {
        try {
          await this.snapshots.resume(record, started)
          resumed = true
        } catch (error) {
          failure = error
          console.error(`resume ${record.id}, attempt ${attempt}: ${message(error)}`)
        }
      }
    } finally {
      this.transitions.delete(record.id)
    }
    return resumed ? this.get(record.id) : this.bootFromSave(record, failure)
  }

  // The saved memory can't be loaded (say, after a Firecracker upgrade), so
  // boot fresh from the disk saved with it, reopening sessions with agents
  // continuing their conversations, and say so.
  private async bootFromSave(record: VmRecord, failure: unknown) {
    const reason = failure instanceof Error ? failure.message : String(failure)
    await zfs.rollback(this.snapshots.paths(record, record.checkpoint!).disk)
    // The save stays until the next pause or stop, in case it's needed by hand.
    record.paused = false
    await writeRecord(record)
    await this.launch(record, { resumeSessions: true })
    const vm = await this.awaitBoot(record)
    void this.notify({
      vm, title: `${record.name} restarted from its save`, priority: 'high', tags: ['warning'],
      message: `Its saved memory couldn't be restored (${reason}), so it booted fresh from the disk saved with it. Its sessions were reopened, with agents continuing their last conversations.`,
    })
    return vm
  }

  async update(id: string, input: UpdateVm) {
    return this.lock.run(async () => {
      const record = await this.record(id)
      if (input.autoPauseMinutes !== undefined) record.autoPauseMinutes = input.autoPauseMinutes
      if (input.maxAwakeHours !== undefined) record.maxAwakeHours = input.maxAwakeHours
      await writeRecord(record)
      return this.get(id)
    })
  }

  // Raises a VM's disk limit. A running VM gets the space straight away. A
  // paused one must be resumed first: its saved state has the old size.
  async growDisk(id: string, { diskGib }: GrowDisk) {
    return this.lock.run(async () => {
      const record = await this.record(id)
      if (record.paused) throw new HttpError(409, `${record.name} is paused; resume it first`)
      // The same size again retries growing the filesystem.
      if (diskGib < record.diskGib) throw new HttpError(400, `the disk is ${record.diskGib} GiB, and disks can only grow`)
      await this.checkPoolFits(diskGib)
      const device = zfs.zvolDevice(rootVolume(id))
      await zfs.setVolumeSize(rootVolume(id), diskGib)
      record.diskGib = diskGib
      await writeRecord(record)
      if (await firecracker.isRunning(id)) {
        // Firecracker rereads the size and tells the guest, which then grows
        // its filesystem with the resize ioctl.
        await firecracker.api(id)('PATCH /drives/rootfs', { drive_id: 'rootfs', path_on_host: record.rootPath ?? device })
        const result = await (await this.guest(id)).exec({ command: growFilesystemInGuest(diskGib), user: 'root', timeoutMs: 60_000 })
        if (result.exitCode !== 0) {
          throw new HttpError(502, `the disk grew, but the guest couldn't grow its filesystem: ${(result.stderr || result.stdout).trim()}`)
        }
      } else {
        await zfs.growFilesystem(device)
      }
      return this.toVm(record)
    })
  }

  async stop(id: string) {
    await this.lock.run(async () => {
      const record = await this.record(id)
      if (record.paused) throw new HttpError(409, `${record.name} is paused; resume it before stopping`)
      // First, so a stop is never mistaken for a crash.
      if (record.shouldRun) {
        record.shouldRun = false
        await writeRecord(record)
      }
      if (!(await firecracker.isRunning(id))) return
      this.transitions.set(id, 'stopping')
      try {
        await this.shutDown(id)
        if (record.checkpoint) {
          const previous = record.checkpoint
          record.checkpoint = null
          await writeRecord(record)
          await this.snapshots.discard(record, previous)
        }
      } finally {
        this.transitions.delete(id)
      }
    })
    return this.get(id)
  }

  async remove(id: string) {
    await this.lock.run(async () => {
      const record = await this.record(id)
      await firecracker.kill(id)
      await this.cleanUp(record)
    })
  }

  async resize(id: string, input: ResizeVm) {
    return this.lock.run(async () => {
      const record = await this.record(id)
      if (record.paused || await firecracker.isRunning(id)) throw new HttpError(409, 'Stop the workspace before resizing; paused sessions cannot be resized')
      const diskGib = input.diskGib ?? record.diskGib
      if (diskGib < record.diskGib) throw new HttpError(400, 'Disks can only be grown, not shrunk')
      if (diskGib > await zfs.poolSizeGib(config.pool)) throw new HttpError(400, 'The disk cannot be larger than the host storage pool')
      this.transitions.set(id, 'resizing')
      try {
        await this.runCheckpoints.create(record, 'Before resize')
        if (diskGib > record.diskGib) {
          await zfs.setVolumeSize(rootVolume(id), diskGib)
          record.diskGib = diskGib
          await writeRecord(record)
        }
        await zfs.growFilesystem(zfs.zvolDevice(rootVolume(id)))
        if (input.size) Object.assign(record, VmSizes[input.size])
        record.lastError = null
        await writeRecord(record)
      } catch (error) {
        record.lastError = error instanceof Error ? error.message : String(error)
        await writeRecord(record)
        throw error
      } finally { this.transitions.delete(id) }
      return this.get(id)
    })
  }

  async checkpoints(id: string) { return (await this.record(id)).runCheckpoints }

  async rollback(id: string, checkpointId: string) {
    return this.lock.run(async () => {
      const record = await this.record(id)
      if (!record.runCheckpoints.some((point) => point.id === checkpointId)) throw new HttpError(404, 'checkpoint not found')
      if (record.paused || await firecracker.isRunning(id)) throw new HttpError(409, 'Stop the workspace before rolling back its disk')
      await this.runCheckpoints.restore(record, checkpointId)
      return this.get(id)
    })
  }

  async createSession(id: string, input: CreateSession) {
    return this.lock.run(async () => {
      const record = await this.record(id)
      const guest = await this.guest(id)
      if (!input.agent) return guest.createSession({})
      this.transitions.set(id, 'checkpointing')
      try {
        const point = await this.runCheckpoints.create(record, `Before ${input.agent}`, input.agent, input.mode ?? 'ask')
        const session = await guest.createSession({ agent: input.agent, mode: input.mode ?? 'ask', checkpointId: point.id })
        point.sessionId = session.id
        await writeRecord(record)
        return { ...session, mode: input.mode ?? 'ask', checkpointId: point.id }
      } finally { this.transitions.delete(id) }
    })
  }

  async fork(id: string, input: ForkVm, targetId?: string): Promise<Vm> {
    return this.lock.run(async () => {
      const source = await this.record(id)
      if (!source.forkCapable || !source.rootPath) throw new HttpError(409, 'This VM needs a newer guest image for running-state forks. Create a workspace from the latest image first.')
      const records = await listRecords()
      if (input.name && records.some((record) => record.name === input.name)) throw new HttpError(409, `a VM named ${input.name} already exists`)
      await this.ensureFits(source.memMib)
      const wasRunning = await firecracker.isRunning(id)
      if (!wasRunning && !source.paused) throw new HttpError(409, 'Start or pause this workspace before forking its running state')
      const childId = targetId ?? newVmId()
      if (await zfs.datasetExists(dataset(childId))) throw new HttpError(409, 'fork destination already exists')
      const filesystemSnapshot = `${dataset(id)}@fork-${randomUUID()}`
      let filesystemSaved = false
      let child: VmRecord | null = null
      this.transitions.set(id, 'forking')
      try {
        if (wasRunning) await this.snapshots.pause(source)
        const point = source.checkpoint!
        child = { ...source, id: childId, name: input.name ?? childId,
          slot: lowestFreeSlot(records.map((record) => record.slot)), token: randomBytes(32).toString('hex'),
          shouldRun: true, parentId: id, createdAt: new Date().toISOString(), lastError: null, runCheckpoints: [],
          paused: true, checkpoint: { ...point }, resumeMs: null }
        await zfs.snapshot(filesystemSnapshot)
        filesystemSaved = true
        await zfs.copySnapshot(filesystemSnapshot, dataset(childId), true)
        await zfs.copySnapshot(this.snapshots.paths(source, point).disk, rootVolume(childId))
        await zfs.waitForDevice(zfs.zvolDevice(rootVolume(childId)))
        await writeRecord(child)
        await this.writeMetadata(child)
        await this.snapshots.resume(child)
      } catch (error) {
        if (child) {
          await firecracker.kill(childId)
          await this.cleanUp(child)
        }
        throw error
      } finally {
        if (filesystemSaved) await zfs.destroy(filesystemSnapshot).catch((error) => console.error('fork staging cleanup:', error))
        try {
          if (wasRunning && source.paused) {
            try { await this.snapshots.resume(source) }
            catch (error) {
              // The original remains durably paused and can be retried. Don't
              // hide a successfully created child behind a failed response.
              console.error(`fork source ${id} could not resume:`, error)
            }
          }
        }
        finally { this.transitions.delete(id) }
      }
      return this.get(childId)
    })
  }

  async exec(id: string, req: ExecRequest) {
    return (await this.guest(id)).exec(req)
  }

  // The guest agent of a running VM.
  async guest(id: string) {
    const record = await this.record(id)
    if (record.paused || !(await firecracker.isRunning(id)) || this.transitions.has(id)) {
      throw new HttpError(409, `${record.name} isn't running`)
    }
    return guestClient(slotAddresses(record.slot).guestIp, record.token)
  }

  async capacity() {
    return hostCapacity(await this.memInUse(), config.memReserveMib)
  }

  // After hostd restarts: VMs that are still running keep going; for the rest,
  // drop TAP devices left behind (e.g. by a host reboot).
  async reconcile() {
    for (const record of await listRecords()) {
      await this.snapshots.reconcile(record)
      // VMs that were running before hostd knew to record it.
      if (!record.shouldRun && !record.paused && (await firecracker.isRunning(record.id))) {
        record.shouldRun = true
        await writeRecord(record)
      }
    }
  }

  private async record(id: string) {
    const record = await readRecord(id)
    if (!record) throw new HttpError(404, `no VM ${id}`)
    return record
  }

  private async toVm(record: VmRecord): Promise<Vm> {
    const running = await firecracker.isRunning(record.id)
    const state =
      this.transitions.get(record.id) ?? (record.paused ? 'paused' : running ? 'running' : record.lastError ? 'failed' : 'stopped')
    const { token: _token, slot, kernel: _kernel, checkpoint: _checkpoint, paused: _paused, shouldRun: _shouldRun, runCheckpoints: _runs, rootPath: _root, forkCapable: _fork, ...rest } = record
    return { ...rest, state, pausedAt: record.paused ? record.checkpoint?.createdAt ?? null : null, guestIp: slotAddresses(slot).guestIp }
  }

  private async memInUse() {
    let total = 0
    for (const record of await listRecords()) {
      if (this.transitions.get(record.id) === 'starting' || (await firecracker.isRunning(record.id))) {
        total += record.memMib
      }
    }
    return total
  }

  // A disk can't be smaller than the image it's cloned from, and since disks
  // are thin, one bigger than the whole storage pool would only fail later.
  private async checkDiskSize(diskGib: number, rootfsSnapshot: string) {
    const imageGib = Math.ceil(await zfs.volumeSizeGib(rootfsSnapshot.split('@')[0]!))
    if (diskGib < imageGib) throw new HttpError(400, `the disk must be at least ${imageGib} GiB, the image's size`)
    await this.checkPoolFits(diskGib)
    return diskGib
  }

  private async checkPoolFits(diskGib: number) {
    const poolGib = await zfs.poolSizeGib(config.pool)
    if (diskGib > poolGib) {
      throw new HttpError(400, `the disk can't be bigger than the host's storage pool (${poolGib} GiB)`)
    }
  }

  private async ensureFits(memMib: number) {
    const capacity = await this.capacity()
    if (memMib > capacity.memFreeMib) {
      throw new HttpError(
        409,
        `not enough memory: the VM needs ${memMib} MiB and ${capacity.memFreeMib} MiB is free`,
      )
    }
  }

  // `resumeSessions` asks guestd to reopen the sessions the VM had (see sessions.ts).
  private async launch(record: VmRecord, { resumeSessions = false } = {}) {
    const net = slotAddresses(record.slot)
    const dir = vmDir(record.id)
    const spec = {
      id: record.id,
      hostname: record.name,
      vcpus: record.vcpus,
      memMib: record.memMib,
      kernel: record.kernel,
      rootDevice: record.rootPath ?? zfs.zvolDevice(rootVolume(record.id)),
      ...net,
    }
    await Bun.write(`${dir}/firecracker.json`, JSON.stringify(firecracker.firecrackerConfig(spec), null, 2))
    await this.writeMetadata(record, resumeSessions)

    await createTap(record.slot)
    this.transitions.set(record.id, 'starting')
    try {
      const root = record.rootPath ? { source: zfs.zvolDevice(rootVolume(record.id)), target: record.rootPath } : undefined
      await firecracker.launch(spec, { config: `${dir}/firecracker.json`, metadata: `${dir}/metadata.json` }, root)
    } catch (err) {
      this.transitions.delete(record.id)
      await deleteTap(record.slot)
      throw err
    }
    record.startedAt = record.awakeSince = new Date().toISOString()
  }

  // Waits for the guest agent and records how long the boot took.
  private async awaitBoot(record: VmRecord): Promise<Vm> {
    const launched = performance.now()
    const client = guestClient(slotAddresses(record.slot).guestIp, record.token)
    try {
      const health = await waitForGuest(client, {
        timeoutMs: config.bootTimeoutMs,
        alive: () => firecracker.isRunning(record.id),
      })
      if (health.vmId !== record.id) throw new Error('guest identity does not match this VM')
      record.forkCapable = health.features?.forkNetwork === true
      record.bootMs = Math.round(performance.now() - launched)
      record.lastError = null
      await writeRecord(record)
      return this.toVm(record)
    } catch (err) {
      const log = await firecracker.journalTail(record.id)
      await firecracker.kill(record.id)
      await deleteTap(record.slot)
      record.lastError = `${err instanceof Error ? err.message : err}`
      await writeRecord(record)
      throw new HttpError(502, `${record.name} failed to boot: ${record.lastError}\n${log}`)
    } finally {
      this.transitions.delete(record.id)
    }
  }

  private async shutDown(id: string) {
    await firecracker.stop(id)
    const record = await readRecord(id)
    if (record) await deleteTap(record.slot)
  }

  private async writeMetadata(record: VmRecord, resumeSessions = false) {
    const net = slotAddresses(record.slot)
    const metadata = { substrate: { vmId: record.id, name: record.name, token: record.token, guestIp: net.guestIp, hostIp: net.hostIp, resumeSessions } }
    await Bun.write(`${vmDir(record.id)}/metadata.json`, JSON.stringify(metadata), { mode: 0o600 })
  }

  private async cleanUp(record: VmRecord) {
    await deleteTap(record.slot)
    if (await zfs.datasetExists(dataset(record.id))) await zfs.destroy(dataset(record.id))
  }
}

// Run as root in the guest. Waits for the guest to see the bigger disk, then
// grows / with EXT4_IOC_RESIZE_FS, which works on a mounted filesystem
// without opening the disk itself (resize2fs would, and is refused).
function growFilesystemInGuest(diskGib: number) {
  return `python3 - ${diskGib * 2 ** 30} <<'PY'
import fcntl, os, struct, sys, time
want = int(sys.argv[1])
for _ in range(100):
    size = int(open('/sys/block/vda/size').read()) * 512
    if size >= want:
        break
    time.sleep(0.1)
else:
    sys.exit(f'the guest still sees a {size}-byte disk')
fd = os.open('/', os.O_RDONLY)
fcntl.ioctl(fd, 0x40086610, struct.pack('Q', size // os.statvfs('/').f_frsize))
PY`
}
