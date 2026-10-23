import type { UsageReport } from '@substrate/protocol'
import type { Db } from './db.ts'

export const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7)

// Metered running time, per VM per month: the basis for quotas and billing.
export class Usage {
  constructor(private readonly db: Db) {}

  async add(input: { userId: string; vmId: string; month: string; seconds: number; vcpus: number; memMib: number }) {
    const vcpuSeconds = input.seconds * input.vcpus
    const gibSeconds = input.seconds * (input.memMib / 1024)
    await this.db`insert into usage (user_id, vm_id, month, running_seconds, vcpu_seconds, gib_seconds, updated_at)
      values (${input.userId}, ${input.vmId}, ${input.month}, ${input.seconds}, ${vcpuSeconds}, ${gibSeconds}, ${new Date().toISOString()})
      on conflict (user_id, vm_id, month) do update set
        running_seconds = usage.running_seconds + excluded.running_seconds,
        vcpu_seconds = usage.vcpu_seconds + excluded.vcpu_seconds,
        gib_seconds = usage.gib_seconds + excluded.gib_seconds,
        updated_at = excluded.updated_at`
  }

  async report(userId: string, month: string): Promise<UsageReport> {
    const rows = await this.db`select vm_id, running_seconds, vcpu_seconds, gib_seconds from usage where user_id = ${userId} and month = ${month} order by vm_id`
    const hours = (seconds: number) => Math.round((Number(seconds) / 3600) * 100) / 100
    const vms: UsageReport['vms'] = rows.map((row: { vm_id: string; running_seconds: number; vcpu_seconds: number; gib_seconds: number }) => ({
      vmId: row.vm_id, runningHours: hours(row.running_seconds), vcpuHours: hours(row.vcpu_seconds), gibHours: hours(row.gib_seconds),
    }))
    const sum = (key: 'runningHours' | 'vcpuHours' | 'gibHours') => Math.round(vms.reduce((total, vm) => total + vm[key], 0) * 100) / 100
    return { month, vms, totals: { runningHours: sum('runningHours'), vcpuHours: sum('vcpuHours'), gibHours: sum('gibHours') } }
  }

  async runningHours(userId: string, month: string) {
    const [row] = await this.db`select coalesce(sum(running_seconds), 0) as seconds from usage where user_id = ${userId} and month = ${month}`
    return Number(row?.seconds ?? 0) / 3600
  }
}
