import { randomBytes, randomUUID } from 'node:crypto'
import { Comparison, GuestTask, Task, Vm, taskIsActive, taskIsPending, type CreateComparison, type TaskSpec } from '@substrate/protocol'
import { HTTPException } from 'hono/http-exception'
import type { Owners } from './owners.ts'
import type { Jobs } from './jobs.ts'
import { quotaError, type Quotas } from './quotas.ts'
import { monthOf, type Usage } from './usage.ts'

import { WorkflowStore } from './workflow-store.ts'
export { WorkflowStore } from './workflow-store.ts'
export { taskSummary } from './task-summary.ts'

type Options = {
  store: WorkflowStore; owners: Owners; jobs: Jobs; maxVmsPerUser: number; hostd: { url: string; readonly token: string }
  // The user's VM limit when quotas are on (Phase 2); otherwise maxVmsPerUser.
  maxVms?: (userId: string) => Promise<number>
  quotas?: Quotas
  usage?: Usage
}
const fail = (status: 400 | 404 | 409 | 502 | 503, message: string): never => { throw new HTTPException(status, { message }) }
const activeTask = taskIsPending
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
  async pendingVms(userId: string) { return (await this.store.comparisons(userId)).filter((comparison) => comparison.state === 'preparing').flatMap((comparison) => comparison.vmIds) }
  async hasActiveTask(userId: string, vmId: string) { return (await this.store.tasks(userId, true)).some((task) => task.vmId === vmId) }
  list(userId: string) { return this.store.summaries(userId) }
  comparisons(userId: string) { return this.store.comparisons(userId) }
  async task(userId: string, id: string) { return await this.store.task(userId, id) ?? fail(404, 'Task not found') }
  async comparison(userId: string, id: string) { return await this.store.comparison(userId, id) ?? fail(404, 'Comparison not found') }

  async createTask(userId: string, vmId: string, spec: TaskSpec) {
    return this.options.jobs.exclusive(userId, async () => {
      await this.own(userId, vmId)
      if (await this.hasActiveTask(userId, vmId)) fail(409, 'A task is already running in this workspace. Wait or cancel it first.')
      // hostd starts a stopped/paused VM when a task is submitted.
      if (this.options.quotas) {
        const limits = await this.options.quotas.of(userId)
        const runningHours = this.options.usage ? await this.options.usage.runningHours(userId, monthOf(Date.now())) : 0
        const refused = quotaError(limits, { vms: 0, totalDiskGib: 0, runningHours }, { start: true })
        if (refused) fail(409, refused)
      }
      const task = this.makeTask(vmId, spec)
      await this.store.saveTask(userId, task)
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
    await this.store.saveTask(userId, task)
  }

  async createComparison(userId: string, input: CreateComparison) {
    return this.options.jobs.exclusive(userId, async () => {
      await this.own(userId, input.sourceVmId)
      if (await this.hasActiveTask(userId, input.sourceVmId)) fail(409, 'Finish or cancel the source workspace task before comparing approaches')
      const all = Vm.array().parse(await this.requireResponse(await this.host('/vms'), 'Could not check workspace quota'))
      const source = all.find((vm) => vm.id === input.sourceVmId) ?? fail(404, 'Source workspace not found')
      if (!['running', 'paused'].includes(source.state)) fail(409, 'Start or pause the source workspace before comparing approaches')
      const owned = new Set(await this.options.owners.vmsOf(userId))
      const used = new Set([...all.filter((vm) => owned.has(vm.id)).map((vm) => vm.id), ...await this.options.jobs.pending(userId), ...await this.pendingVms(userId)])
      const maxVms = this.options.maxVms ? await this.options.maxVms(userId) : this.options.maxVmsPerUser
      if (used.size + 2 > maxVms) fail(409, 'A comparison needs two free workspace places. Delete unused workspaces or raise your VM quota first.')
      if (this.options.quotas) {
        const limits = await this.options.quotas.of(userId)
        const runningHours = this.options.usage ? await this.options.usage.runningHours(userId, monthOf(Date.now())) : 0
        const totalDiskGib = all.filter((vm) => owned.has(vm.id)).reduce((sum, vm) => sum + vm.diskGib, 0)
        const refused = quotaError(limits, { vms: used.size, totalDiskGib, runningHours }, { diskGib: source.diskGib, addDiskGib: source.diskGib * 2, start: true })
        if (refused) fail(409, refused)
        if (limits.egress === 'allowlist' && source.egress?.mode !== 'allowlist') fail(409, 'This plan requires allowlisted egress. Update the source workspace before comparing approaches.')
      }
      const vmIds: [string, string] = [`vm-${randomBytes(8).toString('hex')}`, `vm-${randomBytes(8).toString('hex')}`]
      const id = randomUUID()
      const tasks = input.approaches.map((spec, index) => this.makeTask(vmIds[index]!, spec, id)) as [Task, Task]
      const comparison: Comparison = { id, sourceVmId: source.id, title: input.title, vmIds,
        taskIds: [tasks[0].id, tasks[1].id], createdAt: new Date().toISOString(), state: 'preparing',
        sourceCheckpointId: null, selectedTaskId: null, error: null }
      await this.store.reserveComparison(userId, comparison, tasks)
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
      await this.store.saveComparison(userId, comparison)
      for (const task of tasks) this.launch(userId, task)
    } catch (error) {
      comparison.state = 'failed'
      comparison.error = error instanceof Error ? error.message : 'Comparison preparation failed'
      await this.store.saveComparison(userId, comparison)
      for (const task of tasks) { task.error = 'The comparison was not prepared. Inspect its workspaces before retrying.'; await this.store.saveTask(userId, task) }
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
    for (const comparison of await this.store.comparisons(userId)) {
      if (comparison.state === 'preparing' && !this.preparing.has(comparison.id)) {
        comparison.state = 'failed'
        comparison.error = 'Control restarted during preparation. Existing branches were retained; tasks were not automatically replayed. Inspect the workspaces before retrying.'
        await this.store.saveComparison(userId, comparison)
      }
    }
    await Promise.all((await this.store.tasks(userId, true)).map(async (task) => {
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
      await this.store.saveTask(userId, task)
    }))
  }
  async review(userId: string, id: string, reviewed: boolean) {
    const task = await this.task(userId, id)
    if (activeTask(task)) fail(409, 'Wait for the task to finish before marking its result reviewed')
    await this.store.review(userId, id, reviewed ? new Date().toISOString() : null)
    return this.task(userId, id)
  }
  async cancel(userId: string, id: string) {
    const task = await this.task(userId, id)
    await this.own(userId, task.vmId)
    if (this.dispatching.has(id) || (task.comparisonId && this.preparing.has(task.comparisonId))) fail(409, 'The task is still preparing. Wait for its workspace to be ready before cancelling.')
    if (!activeTask(task)) return task
    task.run = GuestTask.parse(await this.requireResponse(await this.host(`/vms/${task.vmId}/tasks/${id}/cancel`, this.post({ spec: task.spec })), 'Could not cancel task'))
    if (task.run.id !== task.id) fail(502, 'The workspace returned a different task ID')
    task.dispatchUncertain = false
    task.error = null
    await this.store.saveTask(userId, task)
    return task
  }
  async select(userId: string, id: string, taskId: string) {
    const comparison = await this.comparison(userId, id)
    if (comparison.state !== 'ready' || !comparison.taskIds.includes(taskId)) fail(400, 'Choose an approach belonging to this prepared comparison')
    const task = await this.task(userId, taskId)
    await this.own(userId, task.vmId)
    if (activeTask(task)) fail(409, 'Wait for this approach to finish before choosing it')
    comparison.selectedTaskId = taskId
    await this.store.saveComparison(userId, comparison)
    return comparison
  }
  start() {
    const timer = setInterval(() => { void this.store.users().then((users) => Promise.all(users.map((user) => this.refresh(user)))).catch((error) => console.error('task refresh:', error)) }, 3000)
    timer.unref()
    return timer
  }
}
