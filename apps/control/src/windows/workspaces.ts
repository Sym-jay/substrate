import type { CreateWindowsWorkspace, UpdateWindowsWorkspace, WindowsWorkspaceState } from '@substrate/protocol'
import { randomBytes, randomInt } from 'node:crypto'
import type { WindowsCloud } from './cloud.ts'
import type { WindowsSsh } from './ssh.ts'
import { toWorkspace, type WindowsRow, type WindowsStore } from './store.ts'
import type { WindowsTerminals } from './terminals.ts'
import { windowsUserData } from './user-data.ts'

export type WindowsWorkspacesOptions = {
  store: WindowsStore
  cloud: WindowsCloud
  ssh: Pick<WindowsSsh, 'publicKey' | 'ready' | 'forget' | 'argv'>
  terminals: WindowsTerminals
  instanceType: string
  // How many may be on at once: the account's vCPUs are shared with the host.
  maxRunning: number
  maxPerUser: number
  // For new workspaces; each can change its own.
  idleStopMinutes: number
  // Wraps ssh's argv for a terminal (on the control box, in setsid).
  shell?: (argv: string[]) => string[]
  // TightVNC's port on each workspace.
  vncPort?: number
  now?: () => number
  log?: (message: string) => void
}

export class WindowsError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, message: string) {
    super(message)
  }
}

// A first boot (with its user data) that takes longer than this has failed.
const FIRST_BOOT_TIMEOUT_MS = 30 * 60_000
// Busier than this (the highest 5-minute average, in percent), it's working
// on something, however quiet its terminals are.
const BUSY_CPU_PERCENT = 5
// States in which a workspace's instance is using the account's vCPUs.
const ON: WindowsWorkspaceState[] = ['creating', 'starting', 'running', 'stopping']

const ALPHANUMERIC = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
const randomText = (length: number) => Array.from({ length }, () => ALPHANUMERIC[randomInt(ALPHANUMERIC.length)]).join('')
// Windows wants upper and lower case letters and digits.
export function makePassword() {
  for (;;) {
    const password = randomText(20)
    if (/[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password)) return password
  }
}

// Windows workspaces: an EC2 instance each. Creating one starts its instance;
// stopping one (by hand, or after it has been idle) keeps its disk.
export class WindowsWorkspaces {
  private readonly o: Required<WindowsWorkspacesOptions>
  private lastActive = new Map<string, number>()
  private queue = Promise.resolve()
  private ticking = false

  constructor(options: WindowsWorkspacesOptions) {
    this.o = { shell: (argv) => argv, vncPort: 5900, now: Date.now, log: console.log, ...options }
  }

  // Creating and starting happen one at a time, so two can't both take the last slot.
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work)
    this.queue = result.then(() => {}, () => {})
    return result
  }

  list(owner: string) {
    return this.o.store.of(owner).map(toWorkspace)
  }

  // The workspace, if it's this user's; others' look like they don't exist.
  own(owner: string, id: string) {
    const row = this.o.store.get(id)
    if (!row || row.owner !== owner) throw new WindowsError(404, `no Windows workspace ${id}`)
    return row
  }

  create(owner: string, { name }: CreateWindowsWorkspace) {
    return this.exclusive(async () => {
      const { store, cloud, ssh } = this.o
      const mine = store.of(owner)
      if (mine.length >= this.o.maxPerUser) {
        throw new WindowsError(409, `you have ${mine.length} Windows workspace${mine.length === 1 ? '' : 's'}, the most each user may have. Delete one first.`)
      }
      if (mine.some((w) => w.name === name)) throw new WindowsError(409, `you already have a Windows workspace named ${name}`)
      this.ensureRoom()
      const now = new Date(this.o.now()).toISOString()
      const row: WindowsRow = {
        id: `win-${randomBytes(6).toString('hex')}`,
        owner, name,
        instanceId: null,
        instanceType: this.o.instanceType,
        state: 'creating',
        privateIp: null,
        password: makePassword(),
        vncPassword: randomText(8),
        createdAt: now,
        lastActiveAt: now,
        idleStopMinutes: this.o.idleStopMinutes,
        error: null,
      }
      store.add(row)
      try {
        const userData = windowsUserData({ password: row.password, vncPassword: row.vncPassword, publicKey: await ssh.publicKey() })
        const instanceId = await cloud.launch({ id: row.id, name, userData })
        store.update(row.id, { instanceId })
        this.o.log(`windows: created ${name} (${row.id}) as ${instanceId}`)
      } catch (err) {
        store.remove(row.id)
        throw new WindowsError(502, `couldn't start it: ${(err as Error).message}`)
      }
      return toWorkspace(store.get(row.id)!)
    })
  }

  start(owner: string, id: string) {
    return this.exclusive(async () => {
      const row = this.own(owner, id)
      if (row.state !== 'stopped') throw new WindowsError(409, `it's ${row.state}`)
      this.ensureRoom()
      await this.o.cloud.start(row.instanceId!)
      this.o.store.update(id, { state: 'starting', error: null })
      return toWorkspace(this.o.store.get(id)!)
    })
  }

  async stop(owner: string, id: string) {
    const row = this.own(owner, id)
    if (row.state !== 'running' && row.state !== 'starting' && row.state !== 'creating') throw new WindowsError(409, `it's ${row.state}`)
    await this.halt(row)
    return toWorkspace(this.o.store.get(id)!)
  }

  update(owner: string, id: string, { idleStopMinutes }: UpdateWindowsWorkspace) {
    this.own(owner, id)
    this.o.store.update(id, { idleStopMinutes })
    return toWorkspace(this.o.store.get(id)!)
  }

  async remove(owner: string, id: string) {
    const row = this.own(owner, id)
    this.o.terminals.stopAll(id)
    if (row.instanceId) {
      await this.o.cloud.terminate(row.instanceId).catch((err: Error) => {
        if (!/InvalidInstanceID\.NotFound/.test(err.name)) throw new WindowsError(502, `couldn't delete its instance: ${err.message}`)
      })
    }
    await this.o.ssh.forget(id)
    this.o.store.remove(id)
    this.lastActive.delete(id)
    this.o.log(`windows: deleted ${row.name} (${id})`)
  }

  credentials(owner: string, id: string) {
    const row = this.own(owner, id)
    return { username: 'Administrator', password: row.password }
  }

  // Where its desktop (VNC) is, and its password.
  desktop(owner: string, id: string) {
    const row = this.running(this.own(owner, id))
    return { host: row.privateIp!, port: this.o.vncPort, password: row.vncPassword }
  }

  terminals(owner: string, id: string) {
    this.own(owner, id)
    return this.o.terminals.list(id)
  }

  createTerminal(owner: string, id: string) {
    const row = this.running(this.own(owner, id))
    this.touch(id)
    return this.o.terminals.create(id, this.o.shell(this.o.ssh.argv(id, row.privateIp!)), () => this.touch(id))
  }

  terminal(id: string, terminalId: string) {
    return this.o.terminals.get(id, terminalId)
  }

  // Someone is using it (typing, or output arriving).
  touch(id: string) {
    this.lastActive.set(id, this.o.now())
  }

  run(intervalMs = 30_000) {
    void this.tick()
    return setInterval(() => void this.tick(), intervalMs)
  }

  // Brings each workspace's state up to date with its instance, finishes
  // first boots and starts, and stops workspaces that have been idle.
  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const { store, cloud } = this.o
      const rows = store.all().filter((row) => row.instanceId)
      const instances = await cloud.describe(rows.map((row) => row.instanceId!))
      for (const row of rows) {
        await this.follow(row, instances.get(row.instanceId!)).catch((err: Error) => this.o.log(`windows: ${row.id}: ${err.message}`))
      }
    } catch (err) {
      this.o.log(`windows: couldn't check instances: ${(err as Error).message}`)
    } finally {
      this.ticking = false
    }
  }

  private async follow(row: WindowsRow, instance: { state: string; privateIp: string | null } | undefined) {
    const { store, cloud, ssh, terminals } = this.o
    const now = this.o.now()
    if (!instance || instance.state === 'terminated' || instance.state === 'shutting-down') {
      if (row.state !== 'failed') {
        terminals.stopAll(row.id)
        store.update(row.id, { state: 'failed', error: 'its instance is gone' })
      }
      return
    }
    if (instance.privateIp && instance.privateIp !== row.privateIp) store.update(row.id, { privateIp: instance.privateIp })
    switch (instance.state) {
      case 'stopping':
      case 'stopped':
        terminals.stopAll(row.id)
        if (row.state !== 'failed' && row.state !== instance.state) store.update(row.id, { state: instance.state })
        return
      case 'running':
        if (row.state === 'failed') {
          // A workspace that failed shouldn't keep costing.
          await cloud.stop(row.instanceId!)
        } else if (row.state === 'creating' || row.state === 'starting') {
          if (instance.privateIp && (await ssh.ready(row.id, instance.privateIp))) {
            store.update(row.id, { state: 'running', error: null, lastActiveAt: new Date(now).toISOString() })
            this.touch(row.id)
            this.o.log(`windows: ${row.name} (${row.id}) is ready`)
          } else if (row.state === 'creating' && now - Date.parse(row.createdAt) > FIRST_BOOT_TIMEOUT_MS) {
            store.update(row.id, { state: 'failed', error: "its first boot didn't finish within 30 minutes" })
          }
        } else if (row.state === 'running') {
          await this.stopIfIdle(row, now)
        }
        return
    }
  }

  private async stopIfIdle(row: WindowsRow, now: number) {
    const last = Math.max(this.lastActive.get(row.id) ?? 0, Date.parse(row.lastActiveAt))
    if (last > Date.parse(row.lastActiveAt) + 60_000) this.o.store.update(row.id, { lastActiveAt: new Date(last).toISOString() })
    if (row.idleStopMinutes === null || now - last < row.idleStopMinutes * 60_000) return
    const cpu = await this.o.cloud.cpu(row.instanceId!, 15)
    if (cpu !== null && cpu >= BUSY_CPU_PERCENT) {
      this.touch(row.id)
      return
    }
    this.o.log(`windows: stopping ${row.name} (${row.id}), idle for ${Math.round((now - last) / 60_000)} min`)
    await this.halt(row)
  }

  private async halt(row: WindowsRow) {
    this.o.terminals.stopAll(row.id)
    await this.o.cloud.stop(row.instanceId!)
    this.o.store.update(row.id, { state: 'stopping' })
  }

  private running(row: WindowsRow) {
    if (row.state !== 'running' || !row.privateIp) throw new WindowsError(409, `it's ${row.state}`)
    return row
  }

  private ensureRoom() {
    const on = this.o.store.all().filter((row) => ON.includes(row.state))
    if (on.length >= this.o.maxRunning) {
      throw new WindowsError(409, `${on.length === 1 ? 'a Windows workspace is' : `${on.length} Windows workspaces are`} already on, the most at once. Stop it first.`)
    }
  }
}
