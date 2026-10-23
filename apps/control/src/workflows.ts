import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { Comparison, GuestTask, Task, Vm, taskIsActive, taskIsPending, type CreateComparison, type TaskSpec } from '@substrate/protocol'
import { HTTPException } from 'hono/http-exception'
import type { Owners } from './owners.ts'
import type { Jobs } from './jobs.ts'

export class WorkflowStore {
  private db: Database
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true, strict: true })
    this.db.run('pragma journal_mode = wal')
    this.db.run('create table if not exists agent_tasks (id text primary key, user_id text not null, payload text not null, summary text)')
    const columns = this.db.query('pragma table_info(agent_tasks)').all() as { name: string }[]
    if (!columns.some((column) => column.name === 'summary')) this.db.run('alter table agent_tasks add column summary text')
    for (const row of this.db.query('select id, payload from agent_tasks where summary is null').all() as { id: string; payload: string }[]) {
      this.db.query('update agent_tasks set summary = ? where id = ?').run(JSON.stringify(taskSummary(Task.parse(JSON.parse(row.payload)))), row.id)
    }
    this.db.run('create index if not exists agent_tasks_owner on agent_tasks(user_id)')
    this.db.run('create table if not exists agent_comparisons (id text primary key, user_id text not null, payload text not null)')
    this.db.run('create index if not exists agent_comparisons_owner on agent_comparisons(user_id)')
  }
  saveTask(userId: string, task: Task) { this.db.query('insert into agent_tasks (id, user_id, payload, summary) values (?, ?, ?, ?) on conflict(id) do update set payload = excluded.payload, summary = excluded.summary where user_id = excluded.user_id').run(task.id, userId, JSON.stringify(task), JSON.stringify(taskSummary(task))) }
  saveComparison(userId: string, comparison: Comparison) { this.db.query('insert into agent_comparisons values (?, ?, ?) on conflict(id) do update set payload = excluded.payload where user_id = excluded.user_id').run(comparison.id, userId, JSON.stringify(comparison)) }
  tasks(userId: string, activeOnly = false) {
    return (this.db.query(`select payload from agent_tasks where user_id = ? ${activeOnly ? `and ${ACTIVE_SQL}` : ''}`).all(userId) as { payload: string }[])
      .map(({ payload }) => Task.parse(JSON.parse(payload))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  summaries(userId: string) {
    return (this.db.query("select summary from agent_tasks where user_id = ? order by json_extract(summary, '$.createdAt') desc limit 200").all(userId) as { summary: string }[])
      .map(({ summary }) => Task.parse(JSON.parse(summary)))
  }
  task(userId: string, id: string) {
    const row = this.db.query('select payload from agent_tasks where user_id = ? and id = ?').get(userId, id) as { payload: string } | null
    return row ? Task.parse(JSON.parse(row.payload)) : null
  }
  comparisons(userId: string) {
    return (this.db.query('select payload from agent_comparisons where user_id = ?').all(userId) as { payload: string }[])
      .map(({ payload }) => Comparison.parse(JSON.parse(payload))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  comparison(userId: string, id: string) { return this.comparisons(userId).find((comparison) => comparison.id === id) ?? null }
  users() { return (this.db.query(`select distinct user_id from agent_tasks where ${ACTIVE_SQL}`).all() as { user_id: string }[]).map((row) => row.user_id) }
  close() { this.db.close() }
}

const ACTIVE_SQL = `(coalesce(json_extract(payload, '$.dispatchUncertain'), 0) = 1 or (json_extract(payload, '$.error') is null and (json_extract(payload, '$.run.state') is null or json_extract(payload, '$.run.state') in ('queued', 'running'))))`

type Options = {
  store: WorkflowStore; owners: Owners; jobs: Jobs; maxVmsPerUser: number; hostd: { url: string; readonly token: string }
  // The user's VM limit when quotas are on (Phase 2); otherwise maxVmsPerUser.
  maxVms?: (userId: string) => Promise<number>
}
const fail = (status: 400 | 404 | 409 | 502 | 503, message: string): never => { throw new HTTPException(status, { message }) }
const activeTask = taskIsPending
export const taskSummary = (task: Task): Task => ({ ...task, run: task.run ? { ...task.run,
  stdout: '', stderr: '', changes: '', result: task.run.result.slice(0, 240),
  verification: task.run.verification ? { ...task.run.verification, output: '' } : null } : null })

// Durable intent on control; execution and bounded output live in guestd.
// Lost responses reconcile by ID. Neither service restart nor GET retries run a
// task again, and preparation never restarts automatically after a control crash.
export class Workflows {
  private dispatching = new Set<string>()
  private preparing = new Set<string>()
  private refreshing = new Map<string, Promise<void>>()
  constructor(private options: Options) {}
  private get store() { return this.options.store }
  private async own(userId: string, vmId: string) { if ((await this.options.owners.owner(vmId)) !== userId) fail(404, 'Workspace not found') }
  private async host(path: string, init: RequestInit = {}) {
    return fetch(`${this.options.hostd.url}${path}`, { ...init, headers: {
      Authorization: `Bearer ${this.options.hostd.token}`, 'content-type': 'application/json',
    }, signal: AbortSignal.timeout(init.method === 'POST' ? 360_000 : 5_000) }).catch(() => null)
  }
  private post(value: unknown): RequestInit { return { method: 'POST', body: JSON.stringify(value) } }
  private async requireResponse(response: Response | null, fallback: string) {
    if (!response) return fail(502, `${fallback}: the sandbox host is unreachable`)
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : fallback
      return fail(response.status === 404 ? 404 : response.status === 409 ? 409 : 502, message)
    }
    return data
  }
  private makeTask(vmId: string, spec: TaskSpec, comparisonId: string | null = null): Task {
    return { id: randomUUID(), vmId, spec, comparisonId, createdAt: new Date().toISOString(), reviewedAt: null, run: null, error: null, dispatchUncertain: false }
  }
  pendingVms(userId: string) { return this.store.comparisons(userId).filter((comparison) => comparison.state === 'preparing').flatMap((comparison) => comparison.vmIds) }
  hasActiveTask(userId: string, vmId: string) { return this.store.tasks(userId, true).some((task) => task.vmId === vmId) }
  list(userId: string) { return this.store.summaries(userId) }
  comparisons(userId: string) { return this.store.comparisons(userId) }
  task(userId: string, id: string) { return this.store.task(userId, id) ?? fail(404, 'Task not found') }
  comparison(userId: string, id: string) { return this.store.comparison(userId, id) ?? fail(404, 'Comparison not found') }

  async createTask(userId: string, vmId: string, spec: TaskSpec) {
    return this.options.jobs.exclusive(userId, async () => {
      await this.own(userId, vmId)
      if (this.hasActiveTask(userId, vmId)) fail(409, 'A task is already running in this workspace. Wait or cancel it first.')
      const task = this.makeTask(vmId, spec)
      this.store.saveTask(userId, task)
      this.launch(userId, task)
      return task
    })
  }

  private launch(userId: string, task: Task) {
    this.dispatching.add(task.id)
    void this.dispatch(userId, task).catch((error) => console.error('task dispatch persistence:', error)).finally(() => this.dispatching.delete(task.id))
  }
  private async dispatch(userId: string, task: Task) {
    let response: Response | null = null
    try {
      await this.own(userId, task.vmId)
      response = await this.host(`/vms/${task.vmId}/tasks`, this.post({ id: task.id, spec: task.spec }))
      const run = GuestTask.parse(await this.requireResponse(response, 'Could not start task'))
      if (run.id !== task.id) throw new Error('The workspace returned a different task ID')
      task.run = run
    } catch (error) {
      // A network failure can follow a successful start. Check the same ID
      // instead of blindly submitting another execution.
      const response = await this.host(`/vms/${task.vmId}/tasks/${task.id}`)
      if (response?.ok) {
        const parsed = GuestTask.safeParse(await response.json().catch(() => null))
        if (parsed.success && parsed.data.id === task.id) task.run = parsed.data
      }
      if (!task.run) {
        task.dispatchUncertain = !response || response.status >= 500 || response.ok
        task.error = task.dispatchUncertain ? 'The task start could not be confirmed. It may be running. We will check its ID without replaying it; inspect the workspace or cancel before starting another task.'
          : error instanceof Error ? error.message : 'Task preparation failed. Inspect the workspace before retrying.'
      }
    }
    // A review action may have happened while a response was in flight.
    task.reviewedAt = this.store.task(userId, task.id)?.reviewedAt ?? task.reviewedAt
    this.store.saveTask(userId, task)
  }

  async createComparison(userId: string, input: CreateComparison) {
    return this.options.jobs.exclusive(userId, async () => {
      await this.own(userId, input.sourceVmId)
      if (this.hasActiveTask(userId, input.sourceVmId)) fail(409, 'Finish or cancel the source workspace task before comparing approaches')
      const all = Vm.array().parse(await this.requireResponse(await this.host('/vms'), 'Could not check workspace quota'))
      const source = all.find((vm) => vm.id === input.sourceVmId) ?? fail(404, 'Source workspace not found')
      if (!['running', 'paused'].includes(source.state)) fail(409, 'Start or pause the source workspace before comparing approaches')
      const owned = new Set(await this.options.owners.vmsOf(userId))
      const used = new Set([...all.filter((vm) => owned.has(vm.id)).map((vm) => vm.id), ...await this.options.jobs.pending(userId), ...this.pendingVms(userId)])
      const maxVms = this.options.maxVms ? await this.options.maxVms(userId) : this.options.maxVmsPerUser
      if (used.size + 2 > maxVms) fail(409, 'A comparison needs two free workspace places. Delete unused workspaces or raise your VM quota first.')
      const vmIds: [string, string] = [`vm-${randomBytes(8).toString('hex')}`, `vm-${randomBytes(8).toString('hex')}`]
      const id = randomUUID()
      const tasks = input.approaches.map((spec, index) => this.makeTask(vmIds[index]!, spec, id)) as [Task, Task]
      const comparison: Comparison = { id, sourceVmId: source.id, title: input.title, vmIds,
        taskIds: [tasks[0].id, tasks[1].id], createdAt: new Date().toISOString(), state: 'preparing',
        sourceCheckpointId: null, selectedTaskId: null, error: null }
      for (const task of tasks) { await this.options.owners.add(task.vmId, userId); this.store.saveTask(userId, task) }
      this.store.saveComparison(userId, comparison)
      this.preparing.add(id)
      void this.prepare(userId, comparison, tasks).catch((error) => console.error('comparison persistence:', error)).finally(() => this.preparing.delete(id))
      return comparison
    })
  }

  private async prepare(userId: string, comparison: Comparison, tasks: [Task, Task]) {
    try {
      const data = await this.requireResponse(await this.host(`/vms/${comparison.sourceVmId}/forks`, this.post({
        children: comparison.vmIds.map((id, index) => ({ id, name: `compare-${comparison.id.slice(0, 8)}-${index ? 'b' : 'a'}` })),
      })), 'Could not prepare comparison') as { vms?: unknown; checkpointId?: unknown }
      const vms = Vm.array().parse(data.vms)
      if (vms.length !== 2 || comparison.vmIds.some((id) => !vms.some((vm) => vm.id === id)) || typeof data.checkpointId !== 'string') throw new Error('The host did not confirm both branches from one checkpoint')
      comparison.state = 'ready'
      comparison.sourceCheckpointId = data.checkpointId
      this.store.saveComparison(userId, comparison)
      for (const task of tasks) this.launch(userId, task)
    } catch (error) {
      comparison.state = 'failed'
      comparison.error = error instanceof Error ? error.message : 'Comparison preparation failed'
      this.store.saveComparison(userId, comparison)
      for (const task of tasks) { task.error = 'The comparison was not prepared. Inspect its workspaces before retrying.'; this.store.saveTask(userId, task) }
    }
  }

  async refresh(userId: string) {
    const previous = this.refreshing.get(userId)
    if (previous) return previous
    const work = this.reconcile(userId).finally(() => this.refreshing.delete(userId))
    this.refreshing.set(userId, work)
    return work
  }
  private async reconcile(userId: string) {
    const response = await this.host('/vms')
    if (!response?.ok) return // An outage doesn't erase results or imply failure.
    const parsed = Vm.array().safeParse(await response.json().catch(() => null))
    if (!parsed.success) return
    const vms = parsed.data
    for (const comparison of this.store.comparisons(userId)) {
      if (comparison.state === 'preparing' && !this.preparing.has(comparison.id)) {
        comparison.state = 'failed'
        comparison.error = 'Control restarted during preparation. Existing branches were retained; tasks were not automatically replayed. Inspect the workspaces before retrying.'
        this.store.saveComparison(userId, comparison)
      }
    }
    await Promise.all(this.store.tasks(userId, true).map(async (task) => {
      if (this.dispatching.has(task.id) || (task.comparisonId && this.preparing.has(task.comparisonId))) return
      const vm = vms.find((vm) => vm.id === task.vmId)
      const owned = (await this.options.owners.owner(task.vmId)) === userId
      if (!vm || !owned || vm.state === 'stopped' || vm.state === 'failed') {
        task.error = 'The workspace is unavailable or stopped. Inspect its saved output before starting a new task.'
        if (!vm || !owned) task.dispatchUncertain = false
        if (task.run && taskIsActive(task.run.state) && !task.dispatchUncertain) {
          task.run = { ...task.run, state: 'interrupted', finishedAt: new Date().toISOString(), error: task.error }
          task.error = null
        }
      } else if (vm.state === 'running') {
        const result = await this.host(`/vms/${task.vmId}/tasks/${task.id}`)
        if (result?.ok) {
          const run = GuestTask.safeParse(await result.json().catch(() => null))
          if (run.success && run.data.id === task.id) { task.run = run.data; task.dispatchUncertain = false; task.error = null }
        } else if (result?.status === 404 && !task.dispatchUncertain) task.error = 'The workspace no longer has this task, possibly after recovery or rollback. It was not replayed.'
      }
      // Paused VMs keep their last known progress; viewing the inbox won't wake them.
      task.reviewedAt = this.store.task(userId, task.id)?.reviewedAt ?? task.reviewedAt
      this.store.saveTask(userId, task)
    }))
  }
  review(userId: string, id: string, reviewed: boolean) {
    const task = this.task(userId, id)
    if (activeTask(task)) fail(409, 'Wait for the task to finish before marking its result reviewed')
    task.reviewedAt = reviewed ? new Date().toISOString() : null
    this.store.saveTask(userId, task)
    return task
  }
  async cancel(userId: string, id: string) {
    const task = this.task(userId, id)
    await this.own(userId, task.vmId)
    if (this.dispatching.has(id) || (task.comparisonId && this.preparing.has(task.comparisonId))) fail(409, 'The task is still preparing. Wait for its workspace to be ready before cancelling.')
    if (!activeTask(task)) return task
    task.run = GuestTask.parse(await this.requireResponse(await this.host(`/vms/${task.vmId}/tasks/${id}/cancel`, this.post({ spec: task.spec })), 'Could not cancel task'))
    if (task.run.id !== task.id) fail(502, 'The workspace returned a different task ID')
    task.dispatchUncertain = false
    task.error = null
    this.store.saveTask(userId, task)
    return task
  }
  async select(userId: string, id: string, taskId: string) {
    const comparison = this.comparison(userId, id)
    if (comparison.state !== 'ready' || !comparison.taskIds.includes(taskId)) fail(400, 'Choose an approach belonging to this prepared comparison')
    const task = this.task(userId, taskId)
    await this.own(userId, task.vmId)
    if (activeTask(task)) fail(409, 'Wait for this approach to finish before choosing it')
    comparison.selectedTaskId = taskId
    this.store.saveComparison(userId, comparison)
    return comparison
  }
  start() {
    const timer = setInterval(() => { for (const user of this.store.users()) void this.refresh(user).catch((error) => console.error('task refresh:', error)) }, 3000)
    timer.unref()
    return timer
  }
}
