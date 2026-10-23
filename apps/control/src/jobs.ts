import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

type JobKind = 'create' | 'fork'
type Job = { id: string; userId: string; vmId: string; state: 'running' | 'done' | 'failed'; error: string | null; kind: JobKind | null; createdAt: string | null }

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
    // Added for the web app's Jobs page; older rows have neither.
    const columns = (this.db.query('pragma table_info(vm_jobs)').all() as { name: string }[]).map((c) => c.name)
    if (!columns.includes('kind')) this.db.run('alter table vm_jobs add column kind text')
    if (!columns.includes('createdAt')) this.db.run('alter table vm_jobs add column createdAt text')
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
  launch(userId: string, vmId: string, work: () => Promise<void>, kind: JobKind = 'create') {
    const id = randomUUID()
    this.db.query("insert into vm_jobs (id, userId, vmId, state, error, kind, createdAt) values (?, ?, ?, 'running', null, ?, ?)")
      .run(id, userId, vmId, kind, new Date().toISOString())
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
  // The user's most recent jobs, newest first.
  list(userId: string, limit = 20) {
    return this.db.query('select * from vm_jobs where userId = ? order by rowid desc limit ?').all(userId, limit) as Job[]
  }
  pending(userId: string) {
    return (this.db.query("select vmId from vm_jobs where userId = ? and state = 'running'").all(userId) as { vmId: string }[]).map((job) => job.vmId)
  }
}
