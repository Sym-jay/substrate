import { Comparison, Task, taskIsPending } from '@substrate/protocol'
import type { Db } from './db.ts'
import { taskSummary } from './task-summary.ts'
import { Owners } from './owners.ts'
import { enqueueTaskNotification } from './notification-events.ts'

export class WorkflowStore {
  constructor(private db: Db, private inTransaction = false, private now = Date.now) {}
  async reserveComparison(userId: string, comparison: Comparison, tasks: [Task, Task]) {
    await this.db.begin(async (tx) => {
      const owners = new Owners(tx), store = new WorkflowStore(tx, true, this.now)
      for (const task of tasks) { await owners.add(task.vmId, userId); await store.saveTask(userId, task) }
      await store.saveComparison(userId, comparison)
    })
  }
  async saveTask(userId: string, task: Task) {
    if (!this.inTransaction) return this.db.begin(async (tx) => { await new WorkflowStore(tx, true, this.now).saveTask(userId, task) })
    const [previous] = await this.db`select active from tasks where id = ${task.id} and user_id = ${userId}`
    const saved = await this.db`insert into tasks (id, user_id, payload, summary, created_at, active, reviewed_at)
      values (${task.id}, ${userId}, ${JSON.stringify(task)}, ${JSON.stringify(taskSummary(task))}, ${task.createdAt}, ${taskIsPending(task) ? 1 : 0}, ${task.reviewedAt})
      on conflict(id) do update set payload = excluded.payload, summary = excluded.summary, active = excluded.active where tasks.user_id = excluded.user_id returning id`
    if (saved.length && Number(previous?.active) === 1 && !taskIsPending(task)) await enqueueTaskNotification(this.db, userId, task, this.now())
  }
  async saveComparison(userId: string, comparison: Comparison) {
    await this.db`insert into comparisons (id, user_id, payload, created_at)
      values (${comparison.id}, ${userId}, ${JSON.stringify(comparison)}, ${comparison.createdAt})
      on conflict(id) do update set payload = excluded.payload where comparisons.user_id = excluded.user_id`
  }
  async tasks(userId: string, activeOnly = false): Promise<Task[]> {
    const rows = activeOnly
      ? await this.db`select payload, reviewed_at from tasks where user_id = ${userId} and active = 1 order by created_at desc, id`
      : await this.db`select payload, reviewed_at from tasks where user_id = ${userId} order by created_at desc, id`
    return rows.map((row: { payload: string; reviewed_at: string | null }) => Task.parse({ ...JSON.parse(row.payload), reviewedAt: row.reviewed_at }))
  }
  async summaries(userId: string): Promise<Task[]> {
    const rows = await this.db`select summary, reviewed_at from tasks where user_id = ${userId} order by created_at desc, id limit 200`
    return rows.map((row: { summary: string; reviewed_at: string | null }) => Task.parse({ ...JSON.parse(row.summary), reviewedAt: row.reviewed_at }))
  }
  async task(userId: string, id: string): Promise<Task | null> {
    const [row] = await this.db`select payload, reviewed_at from tasks where user_id = ${userId} and id = ${id}`
    return row ? Task.parse({ ...JSON.parse(row.payload), reviewedAt: row.reviewed_at }) : null
  }
  async review(userId: string, id: string, reviewedAt: string | null) {
    await this.db`update tasks set reviewed_at = ${reviewedAt} where user_id = ${userId} and id = ${id}`
  }
  async comparisons(userId: string): Promise<Comparison[]> {
    const rows = await this.db`select payload from comparisons where user_id = ${userId} order by created_at desc, id`
    return rows.map((row: { payload: string }) => Comparison.parse(JSON.parse(row.payload)))
  }
  async comparison(userId: string, id: string): Promise<Comparison | null> {
    const [row] = await this.db`select payload from comparisons where user_id = ${userId} and id = ${id}`
    return row ? Comparison.parse(JSON.parse(row.payload)) : null
  }
  async users(): Promise<string[]> { return (await this.db`select distinct user_id from tasks where active = 1`).map((row: { user_id: string }) => row.user_id) }
}
