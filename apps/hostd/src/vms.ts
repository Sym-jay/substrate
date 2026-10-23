import {
  VmSizes,
  DEFAULT_VM_SIZE,
  type Capacity,
  type CreateVm,
  type ExecRequest,
  type ExecResult,
  type Vm,
} from '@substrate/protocol'
import { randomBytes } from 'node:crypto'
import { hostCapacity } from './capacity.ts'
import { config } from './config.ts'
import * as firecracker from './firecracker.ts'
import { guestClient, waitForGuest } from './guest.ts'
import { currentImage } from './images.ts'
import { Mutex } from './mutex.ts'
import { createTap, deleteTap, lowestFreeSlot, slotAddresses } from './network.ts'
import { listRecords, readRecord, vmDir, writeRecord, type VmRecord } from './state.ts'
import * as zfs from './zfs.ts'

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message)
  }
}

// What the HTTP API needs; tests substitute a fake.
export interface VmService {
  list(): Promise<Vm[]>
  get(id: string): Promise<Vm>
  create(input: CreateVm): Promise<Vm>
  start(id: string): Promise<Vm>
  stop(id: string): Promise<Vm>
  remove(id: string): Promise<void>
  exec(id: string, req: ExecRequest): Promise<ExecResult>
  capacity(): Promise<Capacity>
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
export function newVmId() {
  return `vm-${[...randomBytes(8)].map((b) => ID_ALPHABET[b % 32]).join('')}`
}

const dataset = (id: string) => `${config.pool}/vms/${id}`
const rootVolume = (id: string) => `${dataset(id)}/root`

export class VmManager implements VmService {
  // Lifecycle changes (and the capacity and slot checks before them) happen one at a time.
  private lock = new Mutex()
  private transitions = new Map<string, 'starting' | 'stopping'>()

  async list() {
    const records = await listRecords()
    return Promise.all(records.map((r) => this.toVm(r)))
  }

  async get(id: string) {
    return this.toVm(await this.record(id))
  }

  async create(input: CreateVm) {
    const image = await currentImage()
    if (!image) throw new HttpError(409, 'no VM image yet: run `bun run images:build`')
    const size = VmSizes[input.size ?? DEFAULT_VM_SIZE]

    const record = await this.lock.run(async () => {
      const records = await listRecords()
      if (input.name && records.some((r) => r.name === input.name)) {
        throw new HttpError(409, `a VM named ${input.name} already exists`)
      }
      await this.ensureFits(size.memMib)

      const id = newVmId()
      const record: VmRecord = {
        id,
        name: input.name ?? id,
        ...size,
        diskGib: config.diskGib,
        slot: lowestFreeSlot(records.map((r) => r.slot)),
        token: randomBytes(32).toString('hex'),
        image: image.version,
        kernel: image.kernel,
        createdAt: new Date().toISOString(),
        startedAt: null,
        bootMs: null,
        lastError: null,
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
      return record
    })

    return this.awaitBoot(record)
  }

  async start(id: string) {
    const record = await this.lock.run(async () => {
      const record = await this.record(id)
      if (this.transitions.has(id) || (await firecracker.isRunning(id))) return null
      await this.ensureFits(record.memMib)
      await this.launch(record)
      return record
    })
    return record ? this.awaitBoot(record) : this.get(id)
  }

  async stop(id: string) {
    await this.lock.run(async () => {
      await this.record(id)
      if (!(await firecracker.isRunning(id))) return
      this.transitions.set(id, 'stopping')
      try {
        await this.shutDown(id)
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

  async exec(id: string, req: ExecRequest) {
    const record = await this.record(id)
    if (!(await firecracker.isRunning(id)) || this.transitions.has(id)) {
      throw new HttpError(409, `${record.name} isn't running`)
    }
    return guestClient(slotAddresses(record.slot).guestIp, record.token).exec(req)
  }

  async capacity() {
    return hostCapacity(await this.memInUse(), config.memReserveMib)
  }

  // After hostd restarts: VMs that are still running keep going; for the rest,
  // drop TAP devices left behind (e.g. by a host reboot).
  async reconcile() {
    for (const record of await listRecords()) {
      if (!(await firecracker.isRunning(record.id))) await deleteTap(record.slot)
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
      this.transitions.get(record.id) ?? (running ? 'running' : record.lastError ? 'failed' : 'stopped')
    const { token: _token, slot, kernel: _kernel, ...rest } = record
    return { ...rest, state, guestIp: slotAddresses(slot).guestIp }
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

  private async ensureFits(memMib: number) {
    const capacity = await this.capacity()
    if (memMib > capacity.memFreeMib) {
      throw new HttpError(
        409,
        `not enough memory: the VM needs ${memMib} MiB and ${capacity.memFreeMib} MiB is free`,
      )
    }
  }

  private async launch(record: VmRecord) {
    const net = slotAddresses(record.slot)
    const dir = vmDir(record.id)
    const spec = {
      id: record.id,
      hostname: record.name,
      vcpus: record.vcpus,
      memMib: record.memMib,
      kernel: record.kernel,
      rootDevice: zfs.zvolDevice(rootVolume(record.id)),
      ...net,
    }
    await Bun.write(`${dir}/firecracker.json`, JSON.stringify(firecracker.firecrackerConfig(spec), null, 2))
    const metadata = {
      substrate: { vmId: record.id, name: record.name, token: record.token, guestIp: net.guestIp, hostIp: net.hostIp },
    }
    await Bun.write(`${dir}/metadata.json`, JSON.stringify(metadata), { mode: 0o600 })

    await createTap(record.slot)
    this.transitions.set(record.id, 'starting')
    try {
      await firecracker.launch(spec, { config: `${dir}/firecracker.json`, metadata: `${dir}/metadata.json` })
    } catch (err) {
      this.transitions.delete(record.id)
      await deleteTap(record.slot)
      throw err
    }
    record.startedAt = new Date().toISOString()
  }

  // Waits for the guest agent and records how long the boot took.
  private async awaitBoot(record: VmRecord): Promise<Vm> {
    const launched = performance.now()
    const client = guestClient(slotAddresses(record.slot).guestIp, record.token)
    try {
      await waitForGuest(client, {
        timeoutMs: config.bootTimeoutMs,
        alive: () => firecracker.isRunning(record.id),
      })
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

  // Clean shutdown via Ctrl+Alt+Del, then a hard stop if the guest ignores it.
  private async shutDown(id: string) {
    await firecracker.sendCtrlAltDel(id).catch(() => {})
    const deadline = Date.now() + 15_000
    while ((await firecracker.isRunning(id)) && Date.now() < deadline) await Bun.sleep(200)
    await firecracker.kill(id)
    const record = await readRecord(id)
    if (record) await deleteTap(record.slot)
  }

  private async cleanUp(record: VmRecord) {
    await deleteTap(record.slot)
    if (await zfs.datasetExists(dataset(record.id))) await zfs.destroy(dataset(record.id))
  }
}
