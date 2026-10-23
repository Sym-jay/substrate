import { Session, Vm, type CreateSession, type CreateVm } from '@substrate/protocol'

export class WorkspaceApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const message = body && typeof body.error === 'string' ? body.error : `Request failed (${response.status})`
    throw new WorkspaceApiError(response.status, message)
  }
  return response.json()
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const vmPath = (id: string) => `/api/vms/${encodeURIComponent(id)}`
export const workspaceApi = {
  async list(signal?: AbortSignal) {
    return Vm.array().parse(await request('/api/vms', { signal }))
  },
  async create(input: CreateVm) {
    return Vm.parse(await request('/api/vms', post(input)))
  },
  async start(vmId: string) {
    return Vm.parse(await request(`${vmPath(vmId)}/start`, post({})))
  },
  async pause(vmId: string) {
    return Vm.parse(await request(`${vmPath(vmId)}/pause`, post({})))
  },
  async resume(vmId: string) {
    return Vm.parse(await request(`${vmPath(vmId)}/resume`, post({})))
  },
  async sessions(vmId: string, signal?: AbortSignal) {
    return Session.array().parse(await request(`${vmPath(vmId)}/sessions`, { signal }))
  },
  async createSession(vmId: string, input: CreateSession = {}) {
    return Session.parse(await request(`${vmPath(vmId)}/sessions`, post(input)))
  },
  terminalPath(vmId: string, sessionId: string) {
    return `${vmPath(vmId)}/sessions/${encodeURIComponent(sessionId)}/terminal`
  },
}
