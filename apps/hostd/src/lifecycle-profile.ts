// One structured journal record per operation, without tokens, commands or
// memory contents. Timing never changes lifecycle ordering or persistence.
export class LifecycleProfile {
  readonly stagesMs: Record<string, number> = {}
  constructor(readonly operation: string, public vmId: string | null, private started = performance.now()) {}
  async measure<T>(name: string, work: () => Promise<T>): Promise<T> {
    const before = performance.now()
    try { return await work() }
    finally { this.stagesMs[name] = (this.stagesMs[name] ?? 0) + performance.now() - before }
  }
  finish(outcome: 'ok' | 'failed') {
    const sample = { operation: this.operation, vmId: this.vmId, outcome,
      totalMs: Math.round((performance.now() - this.started) * 100) / 100,
      stagesMs: Object.fromEntries(Object.entries(this.stagesMs).map(([name, ms]) => [name, Math.round(ms * 100) / 100])) }
    console.log(`vm.lifecycle ${JSON.stringify(sample)}`)
    return sample
  }
}
