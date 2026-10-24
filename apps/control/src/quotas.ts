import { Quota, VmLimits, sizeCeiling } from '@substrate/protocol'
import type { Db } from './db.ts'

const UNLIMITED: Quota = {
  maxVms: 1_000, sizes: ['small', 'medium', 'large'], maxDiskGib: 1024, maxTotalDiskGib: 1_000_000, maxRunningHours: 1_000_000, egress: 'open',
  maxVcpus: VmLimits.vcpus.max, maxMemMib: VmLimits.memMib.max,
}

// Each user's limits: the defaults, or what an admin set for them.
export class Quotas {
  constructor(private readonly db: Db, private readonly defaults: Quota, private readonly admins: readonly string[] = []) {}

  async of(userId: string): Promise<Quota> {
    const [row] = await this.db`select limits from quotas where user_id = ${userId}`
    if (!row) return this.admins.includes(userId) ? UNLIMITED : this.defaults
    const parsed = Quota.partial().safeParse(JSON.parse(row.limits))
    return { ...this.defaults, ...(parsed.success ? parsed.data : {}) }
  }

  async set(userId: string, limits: Partial<Quota>) {
    await this.db`insert into quotas (user_id, limits, updated_at) values (${userId}, ${JSON.stringify(limits)}, ${new Date().toISOString()})
      on conflict (user_id) do update set limits = excluded.limits, updated_at = excluded.updated_at`
  }

  async reset(userId: string) {
    await this.db`delete from quotas where user_id = ${userId}`
  }
}

export type QuotaUse = { vms: number; totalDiskGib: number; runningHours: number }
export type QuotaChange = {
  newVm?: boolean
  size?: string
  // A custom size, in place of `size`.
  vcpus?: number
  memMib?: number
  // The VM's disk after the change, and how much the user's disks grow by.
  diskGib?: number
  addDiskGib?: number
  // Starting or resuming a VM, which uses running hours.
  start?: boolean
}

// Why a change would break the user's quota, or null if it wouldn't.
export function quotaError(limits: Quota, used: QuotaUse, change: QuotaChange): string | null {
  if (change.newVm && used.vms >= limits.maxVms) {
    return `you have ${used.vms} VM${used.vms === 1 ? '' : 's'}, the most your plan allows. Delete one first.`
  }
  if (change.size && !(limits.sizes as string[]).includes(change.size)) {
    return `the ${change.size} size isn't in your plan (${limits.sizes.join(', ')})`
  }
  if (change.vcpus !== undefined || change.memMib !== undefined) {
    const most = sizeCeiling(limits)
    if ((change.vcpus ?? 0) > most.vcpus || (change.memMib ?? 0) > most.memMib) {
      return `your plan allows up to ${most.vcpus} vCPU and ${most.memMib / 1024} GB per workspace`
    }
  }
  if (change.diskGib !== undefined && change.diskGib > limits.maxDiskGib) {
    return `disks can be at most ${limits.maxDiskGib} GiB on your plan`
  }
  if (change.addDiskGib && used.totalDiskGib + change.addDiskGib > limits.maxTotalDiskGib) {
    return `that would take your disks to ${used.totalDiskGib + change.addDiskGib} GiB, over your plan's ${limits.maxTotalDiskGib} GiB`
  }
  if (change.start && used.runningHours >= limits.maxRunningHours) {
    return `you've used your ${limits.maxRunningHours} running hours for this month`
  }
  return null
}
