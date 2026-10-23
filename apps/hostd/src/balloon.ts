import type { VmMemory } from '@substrate/protocol'
import { config } from './config.ts'
import * as firecracker from './firecracker.ts'
import type { BalloonStats } from './generated/firecracker.ts'
import type { VmRecord } from './state.ts'

const MIB = 1024 ** 2
const valid = (value: number, limit: number) => Number.isInteger(value) && value >= 0 && value <= limit
const roundUp = (value: number) => Math.ceil(value / 1024) * 1024

// Decide from the actual balloon size, not just its requested size: inflation
// is asynchronous, and the OOM backstop can return pages independently.
export class BalloonPolicy {
  private underused = new Map<string, number>()
  constructor(private now = () => performance.now(), private reclaimAfterMs = config.memory.reclaimAfterMs) {}
  forget(id: string) { this.underused.delete(id) }

  target(id: string, limit: number, stats: BalloonStats): number | null {
    if (!valid(stats.actual_mib, limit) || !valid(stats.target_mib, limit) ||
      stats.available_memory === undefined || !Number.isFinite(stats.available_memory) || stats.available_memory < 0) {
      this.forget(id); return null
    }
    const floor = Math.min(config.memory.floorMib, limit)
    const assigned = limit - stats.actual_mib, target = limit - stats.target_mib
    const available = Math.min(assigned, stats.available_memory / MIB)
    const used = assigned - available
    // Keep 1 GiB plus 20% headroom. Grow promptly; the guest's OOM deflation
    // is only a backstop while a sample or host lifecycle operation is pending.
    const wanted = Math.min(limit, Math.max(floor, roundUp((used + 1024) / 0.8)))
    const pressure = available < Math.max(1024, assigned * 0.2)
    if (target < limit && (wanted > target || pressure)) {
      this.forget(id)
      return Math.min(limit, Math.max(wanted, target + 2048, assigned + 1024))
    }
    if (wanted > target - 1024 || available < 2048) {
      this.forget(id); return null
    }
    // Never stack inflation requests while the driver is still catching up.
    if (Math.abs(stats.actual_mib - stats.target_mib) > 256) return null
    const since = this.underused.get(id)
    if (since === undefined) { this.underused.set(id, this.now()); return null }
    if (this.now() - since < this.reclaimAfterMs) return null
    return Math.max(floor, wanted, target - 1024)
  }
}

export const balloonDependencies = { api: firecracker.api, memoryUsage: firecracker.memoryUsage }
type Record = Pick<VmRecord, 'id' | 'memMib' | 'balloonEnabled'>

export class Balloons {
  private samples = new Map<string, VmMemory>()
  constructor(private deps = balloonDependencies, private policy = new BalloonPolicy()) {}
  forget(id: string) { this.samples.delete(id); this.policy.forget(id) }
  get(id: string) { return this.samples.get(id) ?? null }

  async balance(record: Record) {
    if (!record.balloonEnabled) { this.forget(record.id); return }
    const api = this.deps.api(record.id)
    const stats = await api('GET /balloon/statistics', undefined, 1000)
    const desired = this.policy.target(record.id, record.memMib, stats)
    if (desired !== null && desired !== record.memMib - stats.target_mib) {
      await api('PATCH /balloon', { amount_mib: record.memMib - desired }, 1000)
      stats.target_mib = record.memMib - desired
    }
    const usage = await this.deps.memoryUsage(record.id)
    this.samples.set(record.id, {
      floorMib: Math.min(config.memory.floorMib, record.memMib), limitMib: record.memMib,
      targetMib: record.memMib - stats.target_mib,
      actualMib: valid(stats.actual_mib, record.memMib) ? record.memMib - stats.actual_mib : null,
      availableMib: Number.isFinite(stats.available_memory) && stats.available_memory! >= 0 ? stats.available_memory! / MIB : null,
      ...usage, sampledAt: new Date().toISOString(),
    })
  }
}

export class MemoryController {
  private running = false
  constructor(private balance: () => Promise<void>) {}
  start(intervalMs = config.memory.pollMs) {
    void this.tick()
    return setInterval(() => void this.tick(), intervalMs)
  }
  async tick() {
    if (this.running) return
    this.running = true
    try { await this.balance() }
    catch (error) { console.error('memory controller:', error) }
    finally { this.running = false }
  }
}
