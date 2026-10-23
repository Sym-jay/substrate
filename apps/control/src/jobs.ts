import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

type Job = { id: string; userId: string; vmId: string; state: 'running' | 'done' | 'failed'; error: string | null }

// Fork copies can outlast CloudFront's response timeout. Return a job to the
// browser immediately, then poll it. Ownership is reserved before work starts,
// so even a control restart cannot leave a completed fork invisible to its user.
export class Jobs {
  private db: Database
  private queues = new Map<string, Promise<void>>()
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true, strict: true })
    this.db.run('pragma journal_mode = wal')
    this.db.run('create table if not exists vm_jobs (id text primary key, userId text, vmId text, state text, error text)')
    this.db.run("update vm_jobs set state = 'failed', error = 'Control restarted. Refresh your workspaces before retrying.' where state = 'running'")
  }
  async exclusive<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(userId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => { release = resolve })
    this.queues.set(userId, next)
    await previous
    try { return await work() }
    finally { release(); if (this.queues.get(userId) === next) this.queues.delete(userId) }
  }
  launch(userId: string, vmId: string, work: () => Promise<void>) {
    const id = randomUUID()
    this.db.query('insert into vm_jobs values (?, ?, ?, ?, null)').run(id, userId, vmId, 'running')
    void Promise.resolve().then(work).then(
      () => this.db.query("update vm_jobs set state = 'done' where id = ?").run(id),
      (error: unknown) => this.db.query("update vm_jobs set state = 'failed', error = ? where id = ?")
        .run(error instanceof Error ? error.message : 'Fork failed', id),
    )
    return { id, vmId }
  }
  read(id: string, userId: string) {
    return this.db.query('select * from vm_jobs where id = ? and userId = ?').get(id, userId) as Job | null
  }
  pending(userId: string) {
    return (this.db.query("select vmId from vm_jobs where userId = ? and state = 'running'").all(userId) as { vmId: string }[]).map((job) => job.vmId)
  }
}
