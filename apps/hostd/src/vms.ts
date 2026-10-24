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
  type ForkPair,
  type StartGuestTask,
  type GuestTask,
  type CreateSession,
  type Session,
  type RunCheckpoint,
  type Vm,
  type WarmPoolSize,
} from '@substrate/protocol'
import { randomBytes, randomUUID } from 'node:crypto'
import { hostCapacity } from './capacity.ts'
import { LifecycleProfile } from './lifecycle-profile.ts'
import { config } from './config.ts'
import { HttpError, message } from './errors.ts'
import * as firecracker from './firecracker.ts'
import { guestClient, waitForGuest, type GuestClient } from './guest.ts'
import { currentImage } from './images.ts'
import { Mutex } from './mutex.ts'
import { deleteTap, lowestFreeSlot, setProxied, slotAddresses } from './network.ts'
import * as vmm from './vmm.ts'
import { logOnly, type Notify } from './notify.ts'
import { listRecords, readRecord, vmDir, writeRecord, type VmRecord } from './state.ts'
import { Snapshots } from './snapshots.ts'
import { Checkpoints } from './checkpoints.ts'
import { ExternalActivity } from './activity.ts'
import { Balloons } from './balloon.ts'
import { importRepository } from './repositories.ts'
import { forkGeneration } from './fork-generation.ts'
import * as zfs from './zfs.ts'
import { WarmPool, fits, requestedSize, type Pooled } from './warm-pool.ts'

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
  forkPair?(id: string, input: ForkPair): Promise<{ vms: Vm[]; checkpointId: string }>
  createTask?(id: string, input: StartGuestTask): Promise<GuestTask>
  checkpoints(id: string): Promise<RunCheckpoint[]>
  rollback(id: string, checkpointId: string): Promise<Vm>
  createSession(id: string, input: CreateSession): Promise<Session>
  growDisk(id: string, input: GrowDisk): Promise<Vm>
  remove(id: string): Promise<void>
  exec(id: string, req: ExecRequest): Promise<ExecResult>
  guest(id: string): Promise<GuestClient>
  capacity(): Promise<Capacity>
  touch?(id: string): void
  // A VM from the warm pool, handed over at once; null when none fits.
  claim?(input: CreateVm, githubToken: string | undefined, claimedBy: string): Promise<Vm | null>
  poolStatus?(): Promise<WarmPoolSize[]>
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
  private activity = new ExternalActivity()
  private balloons = new Balloons()
  // Claiming from the warm pool takes this, not the lifecycle lock, so a boot
  // in progress (the pool refilling, or a cold create) never holds a claim up.
  private poolLock = new Mutex()
  // Pool VMs being taken down, which a claim must pass over, and ones being
  // handed over (and the names they're taking), which nothing else may touch.
  private retiring = new Set<string>()
  private claiming = new Set<string>()
  private claimingNames = new Set<string>()

  readonly pool = new WarmPool({
    pooled: () => this.pooled(),
    image: async () => (await currentImage())?.version ?? null,
    memFreeMib: async () => (await this.capacity()).memFreeMib,
    // IDs like control's, which every other VM has.
    boot: async (spec) => { await this.boot({ vcpus: spec.vcpus, memMib: spec.memMib, diskGib: spec.diskGib }, { pool: true, targetId: `vm-${randomBytes(8).toString('hex')}` }) },
    discard: (id) => this.discardPooled(id),
  }, config.warmPool)

  touch(id: string) { this.activity.touch(id) }

  constructor(private readonly notify: Notify = logOnly) {}

  // The warm pool's VMs aren't anyone's yet, so they aren't listed.
  async list() {
    const records = (await listRecords()).filter((r) => !r.pool)
    return Promise.all(records.map((r) => this.toVm(r)))
  }

  async get(id: string) {
    const record = await this.record(id)
    if (record.pool) throw new HttpError(404, `no VM ${id}`)
    return this.toVm(record)
  }

  async create(input: CreateVm, githubToken?: string, targetId?: string) {
    return this.boot(input, { githubToken, targetId })
  }

  // A cold boot: a new disk from the image, Firecracker and the guest. Only
  // the checks and the reservation (name, capacity, slot, dataset) take the
  // lifecycle lock; the clone, launch and boot run alongside other boots.
  // `pool` boots one into the warm pool instead of for a create.
  private async boot(input: CreateVm, { githubToken, targetId, pool = false }: { githubToken?: string; targetId?: string; pool?: boolean }) {
    const profile = new LifecycleProfile(pool ? 'pool-boot' : 'create', targetId ?? null)
    let ok = false
    try {
      const image = await profile.measure('image', () => currentImage())
      if (!image) throw new HttpError(409, 'no VM image yet: run `bun run images:build`')
      const preset = VmSizes[input.size ?? DEFAULT_VM_SIZE]
      const size = { vcpus: input.vcpus ?? preset.vcpus, memMib: input.memMib ?? preset.memMib }
      const diskGib = await this.checkDiskSize(input.diskGib ?? DEFAULT_DISK_GIB, image.rootfs)

      const record = await this.lock.run(async () => {
        const records = await profile.measure('records', () => listRecords())
        if (input.name && records.some((r) => r.name === input.name)) {
          throw new HttpError(409, `a VM named ${input.name} already exists`)
        }
        // The pool gives way to a create: its VMs are only there to save time.
        if (!pool) await profile.measure('poolMakeRoom', () => this.makeRoom(size.memMib))
        await profile.measure('capacity', () => this.ensureFits(size.memMib))

        const id = targetId ?? newVmId()
        profile.vmId = id
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
          balloonEnabled: true,
          activeTaskAtSave: false,
          maxAwakeHours: DEFAULT_MAX_AWAKE_HOURS,
          shouldRun: true,
          isolation: 'none',
          egress: input.egress ?? { mode: 'open', allow: [] },
          pool,
          claimedBy: null,
        }
        // Starting from here: its memory counts against the host's and other
        // VMs keep off it. Its record holds its slot once written.
        this.transitions.set(id, 'starting')
        try {
          await profile.measure('dataset', () => zfs.createFilesystem(dataset(id)))
          await profile.measure('initialRecord', () => writeRecord(record))
        } catch (err) {
          this.transitions.delete(id)
          await this.cleanUp(record).catch(() => {})
          throw err
        }
        return record
      })
      try {
        await profile.measure('diskClone', () => zfs.cloneVolume(image.rootfs, rootVolume(record.id), record.diskGib))
        await profile.measure('deviceReady', () => zfs.waitForDevice(zfs.zvolDevice(rootVolume(record.id))))
        await profile.measure('filesystemResize', () => zfs.growFilesystem(zfs.zvolDevice(rootVolume(record.id))))
        await this.launch(record, { profile })
      } catch (err) {
        this.transitions.delete(record.id)
        await this.cleanUp(record).catch(() => {})
        throw err
      }
      await this.awaitBoot(record, profile)
      if (record.repository) {
        try { await profile.measure('repository', () => importRepository(record, githubToken)) }
        catch (error) {
          record.lastError = error instanceof Error ? error.message : String(error)
          await profile.measure('initialRecord', () => writeRecord(record))
          // Preserve the newly created VM for retry instead of leaking an
          // unreachable workspace behind a failed create response.
        }
      }
      const vm = await profile.measure('response', () => this.toVm(record))
      ok = true
      return vm
    } finally { profile.finish(ok ? 'ok' : 'failed') }
  }

  // Hands a ready VM from the warm pool to this create, if one fits: renamed,
  // its disk grown to the size asked for, and recorded as `claimedBy`'s. The
  // pool then boots a replacement in the background.
  async claim(input: CreateVm, githubToken: string | undefined, claimedBy: string): Promise<Vm | null> {
    const profile = new LifecycleProfile('claim', null)
    let ok = false
    try {
      const record = await this.takeFromPool(input, claimedBy, profile)
      if (!record) return null
      void this.pool.fill()
      if (record.repository) {
        try { await profile.measure('repository', () => importRepository(record, githubToken)) }
        catch (error) {
          record.lastError = error instanceof Error ? error.message : String(error)
          await writeRecord(record)
        }
      }
      const vm = await profile.measure('response', () => this.toVm(record))
      ok = true
      return vm
    } finally { if (profile.vmId) profile.finish(ok ? 'ok' : 'failed') }
  }

  async poolStatus() { return this.pool.status() }

  // The pool lock is held only to pick a VM, so claims run side by side.
  private async takeFromPool(input: CreateVm, claimedBy: string, profile: LifecycleProfile) {
    const image = await currentImage()
    if (!image) return null
    const want = requestedSize(input)
    for (;;) {
      const record = await this.poolLock.run(async () => {
        const records = await profile.measure('records', () => listRecords())
        if (input.name && (records.some((r) => !r.pool && r.name === input.name) || this.claimingNames.has(input.name))) {
          throw new HttpError(409, `a VM named ${input.name} already exists`)
        }
        for (const r of records) {
          if (!r.pool || this.retiring.has(r.id) || this.claiming.has(r.id) || this.transitions.has(r.id) || r.bootMs === null || r.lastError ||
            r.image !== image.version || !fits(r, input) || !(await firecracker.isRunning(r.id))) continue
          this.claiming.add(r.id)
          if (input.name) this.claimingNames.add(input.name)
          return r
        }
        return null
      })
      if (!record) return null
      profile.vmId = record.id
      try {
        if (want.diskGib > record.diskGib) {
          await this.checkPoolFits(want.diskGib)
          await profile.measure('disk', () => this.growLive(record, want.diskGib))
          record.diskGib = want.diskGib
        }
        const renamed = !!input.name && input.name !== record.name
        const now = new Date().toISOString()
        Object.assign(record, { name: input.name ?? record.name, pool: false, claimedBy, createdAt: now, awakeSince: now, repository: input.repository ?? null, lastError: null })
        await profile.measure('record', () => writeRecord(record))
        // It booted under its ID. Its metadata and hostname take its name
        // straight after, off the claim's path: a guest exec can stall for
        // seconds when the host's disks are busy, and a name is cosmetic.
        if (renamed) void this.rename(record).catch((error) => console.error(`rename ${record.id}: ${message(error)}`))
        return record
      } catch (error) {
        // Not this one, then: replace it, and try the next.
        console.error(`warm pool ${record.id}: ${message(error)}`)
        void this.discardPooled(record.id)
      } finally {
        this.claiming.delete(record.id)
        if (input.name) this.claimingNames.delete(input.name)
      }
    }
  }

  // The pool's VMs, as warm-pool.ts sees them.
  private async pooled(): Promise<Pooled[]> {
    const pooled: Pooled[] = []
    for (const record of await listRecords()) {
      if (!record.pool || this.retiring.has(record.id) || this.claiming.has(record.id)) continue
      const state = this.transitions.has(record.id) ? 'booting'
        : record.bootMs !== null && !record.lastError && (await firecracker.isRunning(record.id)) ? 'ready' : 'dead'
      pooled.push({ id: record.id, vcpus: record.vcpus, memMib: record.memMib, diskGib: record.diskGib, image: record.image, state })
    }
    return pooled
  }

  // Takes a pool VM down, unless a claim got it first.
  private async discardPooled(id: string) {
    const ours = await this.poolLock.run(async () => {
      if (this.claiming.has(id) || !(await readRecord(id))?.pool) return false
      this.retiring.add(id)
      return true
    })
    if (!ours) return
    try { await this.lock.run(() => this.destroyPooled(id)) } finally { this.retiring.delete(id) }
  }

  // With the lifecycle lock held.
  private async destroyPooled(id: string) {
    const record = await readRecord(id)
    if (!record?.pool) return
    await firecracker.kill(id)
    await this.cleanUp(record)
    this.activity.forget(id)
    this.balloons.forget(id)
  }

  // With the lifecycle lock held: takes pool VMs down, biggest first, until a
  // VM of this much memory fits, or there are none left to take.
  private async makeRoom(memMib: number) {
    let free = (await this.capacity()).memFreeMib
    if (free >= memMib) return
    const candidates = (await this.pooled()).filter((vm) => vm.state !== 'booting').sort((a, b) => b.memMib - a.memMib)
    for (const vm of candidates) {
      if (free >= memMib) break
      const ours = await this.poolLock.run(async () => {
        if (this.claiming.has(vm.id) || !(await readRecord(vm.id))?.pool) return false
        this.retiring.add(vm.id)
        return true
      })
      if (!ours) continue
      try { await this.destroyPooled(vm.id) } finally { this.retiring.delete(vm.id) }
      free = (await this.capacity()).memFreeMib
    }
  }

  // A warm VM's new name: its metadata, and the guest's hostname.
  private async rename(record: VmRecord) {
    await vmm.updateMetadata(record)
    const result = await (await this.guest(record.id)).exec({ command: `hostname ${record.name}`, user: 'root', timeoutMs: 5_000 })
    if (result.exitCode !== 0) throw new Error(`couldn't set the hostname: ${(result.stderr || result.stdout).trim()}`)
  }

  // A running VM's disk, grown: Firecracker rereads its size and tells the
  // guest, which grows its filesystem with the resize ioctl.
  private async growLive(record: VmRecord, diskGib: number) {
    await zfs.setVolumeSize(rootVolume(record.id), diskGib)
    await this.growGuestFilesystem(record, diskGib)
  }

  private async growGuestFilesystem(record: VmRecord, diskGib: number) {
    await firecracker.api(record.id)('PATCH /drives/rootfs', { drive_id: 'rootfs', path_on_host: vmm.rootDrivePath(record) })
    const result = await (await this.guest(record.id)).exec({ command: growFilesystemInGuest(diskGib), user: 'root', timeoutMs: 60_000 })
    if (result.exitCode !== 0) {
      throw new HttpError(502, `the disk grew, but the guest couldn't grow its filesystem: ${(result.stderr || result.stdout).trim()}`)
    }
  }

  // A VM still booting can't be paused, stopped or changed until it's up.
  private settled(record: VmRecord) {
    if (this.transitions.get(record.id) === 'starting') throw new HttpError(409, `${record.name} is still starting`)
  }

  async start(id: string) {
    const started = performance.now()
    return this.lock.run(async () => {
      const record = await this.record(id)
      if (this.transitions.get(id) === 'starting') return this.toVm(record)
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
      // The pool replaces its own.
      if (!record.shouldRun || record.paused || record.pool || this.transitions.has(record.id)) continue
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
      this.settled(record)
      if (record.paused) {
        await this.snapshots.reconcile(record)
        return this.get(id)
      }
      if (!(await firecracker.isRunning(id))) throw new HttpError(409, `${record.name} isn't running`)
      // Saving must still work if guestd is hung. An unknown task state is
      // conservatively un-forkable until the owner resumes and checks it.
      try {
        const guest = await this.guest(id)
        record.activeTaskAtSave = !!(await guest.health()).features?.tasks &&
          (await guest.tasks()).some((task) => task.state === 'running' || task.state === 'queued')
      } catch { record.activeTaskAtSave = true }
      this.transitions.set(id, 'pausing')
      try {
        await writeRecord(record)
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
      this.settled(record)
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
      this.settled(record)
      if (input.autoPauseMinutes !== undefined) record.autoPauseMinutes = input.autoPauseMinutes
      if (input.maxAwakeHours !== undefined) record.maxAwakeHours = input.maxAwakeHours
      // The firewall and the guest's proxy settings change at its next start.
      if (input.egress !== undefined) record.egress = input.egress
      await writeRecord(record)
      return this.get(id)
    })
  }

  // Raises a VM's disk limit. A running VM gets the space straight away. A
  // paused one must be resumed first: its saved state has the old size.
  async growDisk(id: string, { diskGib }: GrowDisk) {
    return this.lock.run(async () => {
      const record = await this.record(id)
      this.settled(record)
      if (record.paused) throw new HttpError(409, `${record.name} is paused; resume it first`)
      // The same size again retries growing the filesystem.
      if (diskGib < record.diskGib) throw new HttpError(400, `the disk is ${record.diskGib} GiB, and disks can only grow`)
      await this.checkPoolFits(diskGib)
      const device = zfs.zvolDevice(rootVolume(id))
      await zfs.setVolumeSize(rootVolume(id), diskGib)
      record.diskGib = diskGib
      await writeRecord(record)
      if (await firecracker.isRunning(id)) {
        await this.growGuestFilesystem(record, diskGib)
      } else {
        await zfs.growFilesystem(device)
      }
      return this.toVm(record)
    })
  }

  async stop(id: string) {
    await this.lock.run(async () => {
      const record = await this.record(id)
      this.settled(record)
      if (record.paused) throw new HttpError(409, `${record.name} is paused; resume it before stopping`)
      // First, so a stop is never mistaken for a crash.
      if (record.shouldRun) {
        record.shouldRun = false
        await writeRecord(record)
      }
      if (await firecracker.isRunning(id)) {
        this.transitions.set(id, 'stopping')
        try {
          await this.shutDown(id)
        } finally {
          this.transitions.delete(id)
        }
      }
      // A save is useless once the VM has shut down (or crashed) since it was
      // made, so delete it, including for a VM that had already gone down.
      if (record.checkpoint) {
        const previous = record.checkpoint
        record.checkpoint = null
        await writeRecord(record)
        await this.snapshots.discard(record, previous)
      }
    })
    return this.get(id)
  }

  async remove(id: string) {
    await this.lock.run(async () => {
      const record = await this.record(id)
      this.settled(record)
      await firecracker.kill(id)
      await this.cleanUp(record)
      this.activity.forget(id)
      this.balloons.forget(id)
    })
  }

  async resize(id: string, input: ResizeVm) {
    return this.lock.run(async () => {
      const record = await this.record(id)
      this.settled(record)
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
      this.settled(record)
      if (!record.runCheckpoints.some((point) => point.id === checkpointId)) throw new HttpError(404, 'checkpoint not found')
      if (record.paused || await firecracker.isRunning(id)) throw new HttpError(409, 'Stop the workspace before rolling back its disk')
      const save = record.checkpoint
      await this.runCheckpoints.restore(record, checkpointId)
      // The rollback forgets the VM's last save (it no longer matches the
      // disk), so delete its files too.
      if (save) await this.snapshots.discard(record, save)
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
    const pair = await this.forkChildren(id, [{ id: targetId ?? newVmId(), name: input.name }])
    return pair.vms[0]!
  }

  async forkPair(id: string, input: ForkPair) {
    return this.forkChildren(id, input.children)
  }

  // One pause and one immutable generation for every destination. No child
  // executes until all copies have been made from that same saved state.
  private async forkChildren(id: string, destinations: { id: string; name?: string }[]) {
    return this.lock.run(async () => {
      const source = await this.record(id)
      this.settled(source)
      if (!source.forkCapable || !source.rootPath) throw new HttpError(409, 'This VM needs a newer guest image for running-state forks. Create a workspace from the latest image first.')
      if (source.paused && source.activeTaskAtSave) throw new HttpError(409, 'This save contains a running task. Resume it and finish or cancel the task before forking.')
      const records = await listRecords()
      for (const destination of destinations) {
        if (destination.name && records.some((record) => record.name === destination.name)) throw new HttpError(409, `a VM named ${destination.name} already exists`)
        if (await zfs.datasetExists(dataset(destination.id))) throw new HttpError(409, 'fork destination already exists')
      }
      await this.ensureFits(source.memMib * destinations.length)
      const wasRunning = await firecracker.isRunning(id)
      if (!wasRunning && !source.paused) throw new HttpError(409, 'Start or pause this workspace before forking its running state')
      if (wasRunning) {
        const guest = await this.guest(id)
        if ((await guest.health()).features?.tasks && (await guest.tasks()).some((task) => task.state === 'running' || task.state === 'queued')) {
          throw new HttpError(409, 'Finish or cancel the running task before forking this workspace')
        }
      }
      const filesystemSnapshot = `${dataset(id)}@fork-${randomUUID()}`
      let filesystemSaved = false
      this.transitions.set(id, 'forking')
      const result = await forkGeneration({
        destinations,
        capture: async () => {
          if (wasRunning) await this.snapshots.pause(source)
          const point = source.checkpoint!
          await zfs.snapshot(filesystemSnapshot)
          filesystemSaved = true
          return point
        },
        makeChild: (destination, point, children: VmRecord[]): VmRecord => ({ ...source, id: destination.id, name: destination.name ?? destination.id,
            slot: lowestFreeSlot([...records, ...children].map((record) => record.slot)), token: randomBytes(32).toString('hex'),
            shouldRun: true, parentId: id, createdAt: new Date().toISOString(), lastError: null, runCheckpoints: [],
            paused: true, checkpoint: { ...point }, resumeMs: null }),
        copy: async (child, point) => {
          await zfs.copySnapshot(filesystemSnapshot, dataset(child.id), true)
          await zfs.copySnapshot(this.snapshots.paths(source, point).disk, rootVolume(child.id))
          await zfs.waitForDevice(zfs.zvolDevice(rootVolume(child.id)))
          await writeRecord(child)
        },
        resume: async (child) => { await this.snapshots.resume(child) },
        remove: async (child) => {
          await firecracker.kill(child.id)
          await this.cleanUp(child)
        },
        releaseSource: async () => {
          if (filesystemSaved) await zfs.destroy(filesystemSnapshot).catch((error) => console.error('fork staging cleanup:', error))
          try {
            if (wasRunning && source.paused) {
              try { await this.snapshots.resume(source) }
              catch (error) {
                // The original remains durably paused and can be retried.
                console.error(`fork source ${id} could not resume:`, error)
              }
            }
          } finally { this.transitions.delete(id) }
        },
      })
      return { vms: await Promise.all(result.children.map((child) => this.get(child.id))), checkpointId: result.point.id }
    })
  }

  async createTask(id: string, input: StartGuestTask) {
    await this.start(id)
    return this.lock.run(async () => {
      const record = await this.record(id)
      const guest = await this.guest(id)
      if (!(await guest.health()).features?.tasks) throw new HttpError(409, 'This workspace needs the task-enabled guest image. Create a workspace from the latest image first.')
      const previous = (await guest.tasks()).find((task) => task.id === input.id)
      if (previous) return previous
      this.transitions.set(id, 'checkpointing')
      try {
        await this.runCheckpoints.create(record, `Before task: ${input.spec.title}`, input.spec.runner === 'command' ? null : input.spec.runner, input.spec.mode)
        return await guest.createTask(input)
      } finally { this.transitions.delete(id) }
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
    const client = guestClient(slotAddresses(record.slot).guestIp, record.token)
    return { ...client, activity: async () => this.activity.report(id, await client.activity()) }
  }

  async capacity() {
    return hostCapacity(await this.memInUse(), config.memReserveMib)
  }

  // The same lifecycle lock protects snapshot creation, resize and balloon
  // adjustments. Admission still reserves each VM's ceiling, so emergency
  // guest-driven deflation cannot overcommit the host.
  async balanceMemory() {
    return this.lock.run(async () => {
      for (const record of await listRecords()) {
        if (record.paused || this.transitions.has(record.id) || !(await firecracker.isRunning(record.id))) {
          this.balloons.forget(record.id); continue
        }
        try { await this.balloons.balance(record) }
        catch (error) { console.error(`memory ${record.id}:`, error instanceof Error ? error.message : error) }
      }
    })
  }

  // After hostd restarts: VMs that are still running keep going; for the rest,
  // drop TAP devices left behind (e.g. by a host reboot).
  async reconcile() {
    for (const record of await listRecords()) {
      await this.snapshots.reconcile(record)
      await this.snapshots.prune(record)
      // hostd's start rebuilt the firewall, emptying its set of allowlisted VMs.
      if (record.egress.mode === 'allowlist' && !record.paused && (await firecracker.isRunning(record.id))) {
        await setProxied(vmm.hostInterface(record), true).catch((err) => console.error(`egress ${record.id}: ${message(err)}`))
      }
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
    const { token: _token, slot, kernel: _kernel, checkpoint: _checkpoint, paused: _paused, shouldRun: _shouldRun, runCheckpoints: _runs, rootPath: _root, forkCapable: _fork, balloonEnabled: _balloon, activeTaskAtSave: _taskAtSave, pool: _pool, ...rest } = record
    const memory = running && !record.paused && record.balloonEnabled ? this.balloons.get(record.id) ?? {
      floorMib: Math.min(config.memory.floorMib, record.memMib), limitMib: record.memMib,
      targetMib: null, actualMib: null,
      availableMib: null, residentMib: null, proportionalMib: null, sampledAt: null,
    } : null
    return { ...rest, memory, state, pausedAt: record.paused ? record.checkpoint?.createdAt ?? null : null, guestIp: slotAddresses(slot).guestIp }
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
  // A cold boot is when a VM changes isolation (config.isolation).
  private async launch(record: VmRecord, { resumeSessions = false, profile }: { resumeSessions?: boolean; profile?: LifecycleProfile } = {}) {
    this.balloons.forget(record.id)
    record.balloonEnabled = true
    record.isolation = vmm.isolationForBoot()
    await writeRecord(record)
    await (profile ? profile.measure('network', () => vmm.startNetwork(record)) : vmm.startNetwork(record))
    this.transitions.set(record.id, 'starting')
    try {
      await (profile ? profile.measure('firecrackerLaunch', () => vmm.launch(record, resumeSessions)) : vmm.launch(record, resumeSessions))
    } catch (err) {
      this.transitions.delete(record.id)
      await deleteTap(record.slot)
      throw err
    }
    record.startedAt = record.awakeSince = new Date().toISOString()
  }

  // Waits for the guest agent and records how long the boot took.
  private async awaitBoot(record: VmRecord, profile?: LifecycleProfile): Promise<Vm> {
    const launched = performance.now()
    const client = guestClient(slotAddresses(record.slot).guestIp, record.token)
    try {
      const ready = () => waitForGuest(client, {
        timeoutMs: config.bootTimeoutMs,
        alive: () => firecracker.isRunning(record.id),
      })
      const health = await (profile ? profile.measure('guestReady', ready) : ready())
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
