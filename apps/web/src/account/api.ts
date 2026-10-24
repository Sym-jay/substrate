import { AgentKeyInfo, GitHubRepoInfo, GitHubStatus, QuotaStatus, UsageReport, type AgentKeyName } from '@substrate/protocol'
import { authHeaders } from '../auth.ts'

// The signed-in user's own things (Phase 2): agent keys, GitHub, quota and use.
export class AccountApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, headers: { ...(init?.headers as Record<string, string>), ...(await authHeaders()) } })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const message = body && typeof body.error === 'string' ? body.error : `Request failed (${response.status})`
    throw new AccountApiError(response.status, message)
  }
  return response.status === 204 ? null : response.json()
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const accountApi = {
  async keys() { return AgentKeyInfo.array().parse(await request('/api/keys')) },
  // The key goes to the control box once; it never comes back.
  async setKey(name: AgentKeyName, value: string) { await request(`/api/keys/${name}`, send('PUT', { value })) },
  async removeKey(name: AgentKeyName) { await request(`/api/keys/${name}`, { method: 'DELETE' }) },

  async github() { return GitHubStatus.parse(await request('/api/github')) },
  // Where to send the browser for "Connect with GitHub".
  async githubAuthorizeUrl() { return ((await request('/api/github/connect', send('POST', {}))) as { url: string }).url },
  async disconnectGitHub() { await request('/api/github', { method: 'DELETE' }) },
  async repos(query: string, signal?: AbortSignal) {
    return GitHubRepoInfo.array().parse(await request(`/api/github/repos?q=${encodeURIComponent(query)}`, { signal }))
  },

  async quota(signal?: AbortSignal) { return QuotaStatus.parse(await request('/api/quota', { signal })) },
  async usage(signal?: AbortSignal) { return UsageReport.parse(await request('/api/usage', { signal })) },
}
