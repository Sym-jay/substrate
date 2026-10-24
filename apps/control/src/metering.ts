import type { Vm } from '@substrate/protocol'
import type { Owners } from './owners.ts'
import type { Quotas } from './quotas.ts'
import { monthOf, type Usage } from './usage.ts'
import type { Events } from './users.ts'

type Options = {
  allVms: () => Promise<Vm[] | null>
  owners: Owners
  usage: Usage
  quotas: Quotas
  events: Events
  pause: (vmId: string) => Promise<void>
  now?: () => number
}

// Every minute: adds each running VM's time to its owner's usage, and pauses
// the VMs of anyone past their running hours for the month.
export class Metering {
  private last: number | null = null
  private readonly now: () => number

  constructor(private readonly o: Options) {
    this.now = o.now ?? Date.now
  }

  start(intervalMs = 60_000) {
    void this.tick()
    return setInterval(() => void this.tick().catch((err: Error) => console.error(`metering: ${err.message}`)), intervalMs)
  }

  async tick() {
    const vms = await this.o.allVms()
    if (!vms) return
    const now = this.now()
    // At most two minutes at a time: a gap (the control box was down) isn't billed.
    const seconds = this.last === null ? 0 : Math.min((now - this.last) / 1000, 120)
    this.last = now
    const month = monthOf(now)
    const running = new Map<string, Vm[]>()
    for (const vm of vms.filter((vm) => vm.state === 'running')) {
      const userId = await this.o.owners.owner(vm.id)
      if (!userId) continue
      running.set(userId, [...(running.get(userId) ?? []), vm])
      if (seconds > 0) await this.o.usage.add({ userId, vmId: vm.id, month, seconds, vcpus: vm.vcpus, memMib: vm.memMib })
    }
    for (const [userId, theirs] of running) {
      const { maxRunningHours } = await this.o.quotas.of(userId)
      const hours = await this.o.usage.runningHours(userId, month)
      if (hours < maxRunningHours) continue
      for (const vm of theirs) {
        await this.o.pause(vm.id).then(
          () => this.o.events.record(userId, 'quota.paused', vm.id, { runningHours: Math.round(hours), maxRunningHours }),
          (err: Error) => console.error(`metering: couldn't pause ${vm.id}: ${err.message}`),
        )
      }
    }
  }
}
