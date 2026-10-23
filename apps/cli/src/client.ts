import { CliIdentity, Comparison, Session, Task, Vm, taskIsPending } from '@substrate/protocol'
import type { z } from 'zod'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export class Client {
  constructor(readonly server: string, readonly token?: string, private fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch, private signal?: AbortSignal) {}
  async request(path: string, method = 'GET', body?: unknown, authenticated = true, timeoutMs = 120_000): Promise<unknown> {
    if (!path.startsWith('/api/')) throw new Error('Invalid API path.')
    if (authenticated && !this.token) throw new Error('Sign in first with substrate login --url ' + this.server)
    let response: Response
    try {
      response = await this.fetcher(this.server + path, { method, redirect: 'manual',
        headers: { accept: 'application/json', ...(authenticated ? { authorization: `Bearer ${this.token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(this.signal ? [this.signal] : [])]),
      })
    } catch (error) {
      if (this.signal?.aborted) throw this.signal.reason
      const uncertain = method === 'GET' ? '' : ' The operation may have succeeded; inspect its status before retrying.'
      throw new Error(`Could not reach ${this.server}.${uncertain}`, { cause: error })
    }
    if (response.status >= 300 && response.status < 400) throw new Error('The server redirected this request. Check --url; CLI credentials are never forwarded to another origin.')
    if (response.status === 204) return null
    const data = await response.json().catch(() => null) as { error?: unknown } | null
    if (!response.ok) throw new ApiError(response.status, response.status === 401 ? 'Your CLI login is missing, expired, or revoked. Run substrate login.' : typeof data?.error === 'string' ? data.error : `The API returned ${response.status}.`)
    if (data === null) throw new Error('The server did not return JSON. Check --url and the deployed API version.')
    return data
  }
  async parsed<T>(schema: z.ZodType<T>, path: string, method = 'GET', body?: unknown, timeoutMs?: number) {
    const result = schema.safeParse(await this.request(path, method, body, true, timeoutMs))
    if (!result.success) throw new Error('The server returned an incompatible response. Check CLI/server versions.')
    return result.data
  }
  async identity() { return this.parsed(CliIdentity, '/api/cli/whoami') }
  async workspaces() { return this.parsed(Vm.array(), '/api/vms') }
  async workspace(ref: string) {
    const all = await this.workspaces(), exact = all.find((vm) => vm.id === ref)
    if (exact) return exact
    const found = all.filter((vm) => vm.name === ref)
    if (found.length !== 1) throw new Error(found.length ? `More than one workspace is named ${ref}; use its ID.` : `No workspace named ${ref}. Run substrate workspace list.`)
    return found[0]!
  }
  async operation(result: unknown, waitMs: number) {
    const vm = Vm.safeParse(result)
    if (vm.success) return vm.data
    const job = result as { id?: unknown; vmId?: unknown }
    if (typeof job?.id !== 'string' || typeof job.vmId !== 'string') throw new Error('The server returned an incompatible workspace operation.')
    const deadline = Date.now() + waitMs
    for (;;) {
      const state = await this.request(`/api/jobs/${encodeURIComponent(job.id)}`) as { state: string; error: string | null }
      if (state.state === 'failed') throw new Error(state.error || 'The workspace operation failed.')
      if (state.state === 'done') return this.parsed(Vm, `/api/vms/${encodeURIComponent(job.vmId)}`)
      if (Date.now() >= deadline) throw new Error(`Workspace operation ${job.id} is still pending. It continues on the server; run substrate workspace list before retrying.`)
      await this.sleep(1000)
    }
  }
  async waitTask(id: string, waitMs: number) {
    const deadline = Date.now() + waitMs
    for (;;) {
      const task = await this.parsed(Task, `/api/tasks/${encodeURIComponent(id)}`)
      if (!taskIsPending(task)) return task
      if (Date.now() >= deadline) throw new Error(`Task ${id} is still pending. It continues on the server; use substrate task get ${id}.`)
      await this.sleep(1000)
    }
  }
  async waitComparison(id: string, waitMs: number) {
    const deadline = Date.now() + waitMs
    for (;;) {
      const comparison = await this.parsed(Comparison, `/api/comparisons/${encodeURIComponent(id)}`)
      if (comparison.state === 'failed') return { comparison, tasks: [] }
      const tasks = await Promise.all(comparison.taskIds.map((id) => this.parsed(Task, `/api/tasks/${encodeURIComponent(id)}`)))
      if (comparison.state === 'ready' && tasks.every((task) => !taskIsPending(task))) return { comparison, tasks }
      if (Date.now() >= deadline) throw new Error(`Comparison ${id} is still pending. It continues on the server; use substrate compare get ${id}.`)
      await this.sleep(1000)
    }
  }
  async sessions(vmId: string) { return this.parsed(Session.array(), `/api/vms/${encodeURIComponent(vmId)}/sessions`) }
  async sleep(ms: number) {
    const { setTimeout } = await import('node:timers/promises')
    await setTimeout(ms, undefined, { signal: this.signal })
  }
}
