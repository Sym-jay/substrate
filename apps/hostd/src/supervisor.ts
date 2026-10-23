import type { PoolStatus, Vm } from '@substrate/protocol'
import { message } from './errors.ts'
import type { Notify } from './notify.ts'

// A VM that goes down this many times this quickly is left stopped.
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 30 * 60_000
const POOL_CHECK_MS = 60_000

type Options = {
  vms: { crashed(): Promise<Vm[]>; recover(id: string): Promise<Vm> }
  pool: () => Promise<PoolStatus>
  notify: Notify
  now?: () => number
}

// Brings back VMs that went down without being stopped (a host crash or
// reboot, a guest kernel panic, `sudo reboot` inside the VM), and warns when
// the storage pool every VM shares is filling up or unhealthy.
export class Supervisor {
  private readonly vms: Options['vms']
  private readonly pool: Options['pool']
  private readonly notify: Notify
  private readonly now: () => number
  private restarts = new Map<string, number[]>()
  private gaveUp = new Set<string>()
  private lastPoolCheck = -Infinity
  private poolHealth = 'ONLINE'
  // 0, or the 80% or 90% mark last warned about.
  private poolMark = 0
  private running = false

  constructor({ vms, pool, notify, now = Date.now }: Options) {
    this.vms = vms
    this.pool = pool
    this.notify = notify
    this.now = now
  }

  start(intervalMs: number) {
    void this.tick()
    return setInterval(() => void this.tick(), intervalMs)
  }

  async tick() {
    if (this.running) return
    this.running = true
    try {
      await this.recoverCrashed()
      if (this.now() - this.lastPoolCheck >= POOL_CHECK_MS) await this.checkPool()
    } catch (err) {
      console.error(`supervisor: ${message(err)}`)
    } finally {
      this.running = false
    }
  }

  private async recoverCrashed() {
    const crashed = await this.vms.crashed()
    for (const id of this.gaveUp) if (!crashed.some((vm) => vm.id === id)) this.gaveUp.delete(id)
    for (const vm of crashed) {
      const now = this.now()
      const recent = (this.restarts.get(vm.id) ?? []).filter((t) => now - t < RESTART_WINDOW_MS)
      if (recent.length >= MAX_RESTARTS) {
        if (!this.gaveUp.has(vm.id)) {
          this.gaveUp.add(vm.id)
          void this.notify({
            vm, title: `${vm.name} keeps going down`, priority: 'high', tags: ['warning'],
            message: `It went down ${MAX_RESTARTS} times in ${RESTART_WINDOW_MS / 60_000} minutes, so it was left stopped. Start it to try again.`,
          })
        }
        continue
      }
      this.restarts.set(vm.id, [...recent, now])
      console.log(`supervisor: ${vm.id} went down without being stopped; booting it again`)
      try {
        await this.vms.recover(vm.id)
        void this.notify({
          vm, title: `${vm.name} was restarted`, priority: 'default', tags: ['arrows_counterclockwise'],
          message: 'It went down without being stopped, so it was booted again. Its sessions were reopened, with agents continuing their last conversations.',
        })
      } catch (err) {
        console.error(`supervisor: couldn't boot ${vm.id} again: ${message(err)}`)
      }
    }
  }

  private async checkPool() {
    this.lastPoolCheck = this.now()
    const pool = await this.pool()
    if (pool.health !== this.poolHealth) {
      if (pool.health !== 'ONLINE') {
        void this.notify({
          vm: null, title: `Host storage is ${pool.health}`, priority: 'high', tags: ['rotating_light'],
          message: 'The ZFS pool holding every VM is not healthy. Check `zpool status` on the host.',
        })
      }
      this.poolHealth = pool.health
    }
    const mark = pool.usedPct >= 90 ? 90 : pool.usedPct >= 80 ? 80 : 0
    if (mark > this.poolMark) {
      void this.notify({
        vm: null, title: `Host storage ${pool.usedPct}% full`, priority: mark === 90 ? 'high' : 'default', tags: ['floppy_disk'],
        message: `VM disks and saved memory share ${pool.sizeGib} GiB. Delete VMs you don't need, or grow the host's data disk, before it fills up.`,
      })
    }
    // Warn again only after it has dropped well below the marks.
    this.poolMark = pool.usedPct < 75 ? 0 : Math.max(this.poolMark, mark)
  }
}
