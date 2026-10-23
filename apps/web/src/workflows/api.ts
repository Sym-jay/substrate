import { Comparison, Task, type TaskSpec, type CreateComparison } from '@substrate/protocol'
import { request } from '../workspaces/api.ts'

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const taskPath = (id: string) => `/api/tasks/${encodeURIComponent(id)}`
export const workflowApi = {
  async tasks(signal?: AbortSignal) { return Task.array().parse(await request('/api/tasks', { signal })) },
  async task(id: string, signal?: AbortSignal) { return Task.parse(await request(taskPath(id), { signal })) },
  async create(vmId: string, spec: TaskSpec) { return Task.parse(await request('/api/tasks', post({ vmId, spec }))) },
  async review(id: string, reviewed: boolean) { return Task.parse(await request(taskPath(id), { ...post({ reviewed }), method: 'PATCH' })) },
  async cancel(id: string) { return Task.parse(await request(`${taskPath(id)}/cancel`, post({}))) },
  async comparisons(signal?: AbortSignal) { return Comparison.array().parse(await request('/api/comparisons', { signal })) },
  async comparison(id: string, signal?: AbortSignal) { return Comparison.parse(await request(`/api/comparisons/${encodeURIComponent(id)}`, { signal })) },
  async compare(input: CreateComparison) { return Comparison.parse(await request('/api/comparisons', post(input))) },
  async select(id: string, taskId: string) { return Comparison.parse(await request(`/api/comparisons/${encodeURIComponent(id)}/select`, post({ taskId }))) },
}
