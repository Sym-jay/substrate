import { randomUUID } from 'node:crypto'
import type { Db } from './db.ts'

type JobKind = 'create' | 'fork'
export type Job = { id: string; userId: string; vmId: string; state: 'running' | 'done' | 'failed'; error: string | null; kind: JobKind | null; createdAt: string }
type Row = { id: string; user_id: string; vm_id: string; state: Job['state']; error: string | null; kind: JobKind | null; created_at: string }
const toJob = (row: Row): Job => ({ id: row.id, userId: row.user_id, vmId: row.vm_id, state: row.state, error: row.error, kind: row.kind, createdAt: row.created_at })

// Fork copies can outlast CloudFront's response timeout. Return a job to the
// browser immediately, then poll it. Ownership is reserved before work starts,
// so even a control restart cannot leave a completed fork invisible to its user.
export class Jobs {
  private queues = new Map<string, Promise<void>>()

  constructor(private readonly db: Db) {}

  // A restart ends the work of jobs that were running.
  async start() {
    await this.db`update jobs set state = 'failed', error = 'Control restarted. Refresh your workspaces before retrying.' where state = 'running'`
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

  async launch(userId: string, vmId: string, work: () => Promise<void>, kind: JobKind = 'create') {
    const id = randomUUID()
    await this.db`insert into jobs (id, user_id, vm_id, state, error, kind, created_at) values (${id}, ${userId}, ${vmId}, 'running', null, ${kind}, ${new Date().toISOString()})`
    void Promise.resolve().then(work).then(
      () => this.db`update jobs set state = 'done' where id = ${id}`,
      (error: unknown) => this.db`update jobs set state = 'failed', error = ${error instanceof Error ? error.message : 'Job failed'} where id = ${id}`,
    ).catch((err: Error) => console.error(`job ${id}: ${err.message}`))
    return { id, vmId }
  }

  async read(id: string, userId: string): Promise<Job | null> {
    const [row] = await this.db`select * from jobs where id = ${id} and user_id = ${userId}`
    return row ? toJob(row) : null
  }

  // The user's most recent jobs, newest first.
  async list(userId: string, limit = 20): Promise<Job[]> {
    return (await this.db`select * from jobs where user_id = ${userId} order by created_at desc limit ${limit}`).map(toJob)
  }

  async pending(userId: string): Promise<string[]> {
    return (await this.db`select vm_id from jobs where user_id = ${userId} and state = 'running'`).map((row: { vm_id: string }) => row.vm_id)
  }
}
