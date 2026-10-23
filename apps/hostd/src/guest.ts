import { ExecResult, GUESTD_PORT, GuestActivity, GuestHealth, Session, type CreateSession, type ExecRequest } from '@substrate/protocol'
import { HttpError } from './errors.ts'

export function guestClient(guestIp: string, token: string, port = GUESTD_PORT) {
  const base = `http://${guestIp}:${port}`
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  return {
    async health(timeoutMs = 500) {
      const res = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`guest health returned ${res.status}`)
      return GuestHealth.parse(await res.json())
    },

    async exec(req: ExecRequest) {
      const res = await fetch(`${base}/exec`, {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(req.timeoutMs + 10_000),
      }).catch((err: Error) => {
        // The guest went away mid-command, e.g. it crashed or rebooted.
        throw new HttpError(502, `lost the VM's guest agent: ${err.message}`)
      })
      if (!res.ok) throw new Error(`guest exec returned ${res.status}: ${await res.text()}`)
      return ExecResult.parse(await res.json())
    },

    // Null from a guest agent older than M4, which doesn't report activity.
    async activity() {
      const res = await fetch(`${base}/activity`, { headers, signal: AbortSignal.timeout(2_000) })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`guest activity returned ${res.status}`)
      return GuestActivity.parse(await res.json())
    },

    async sessions() {
      return Session.array().parse(await sessionCall(`${base}/sessions`, { headers }))
    },

    async createSession(req: CreateSession) {
      return Session.parse(await sessionCall(`${base}/sessions`, { method: 'POST', headers, body: JSON.stringify(req) }))
    },

    // For relaying a browser's terminal straight to guestd.
    terminal(sessionId: string) {
      return { url: `ws://${guestIp}:${port}/sessions/${encodeURIComponent(sessionId)}/terminal`, headers }
    },
  }
}

// guestd's 404 (no such session) and 409 (too many) reach the browser as they are.
async function sessionCall(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  if (res.ok) return data
  const status = res.status === 404 ? 404 : res.status === 409 ? 409 : 502
  throw new HttpError(status, data?.error ?? `guest returned ${res.status}`)
}

// Polls until the guest agent answers. Gives up early if the VM process died.
export async function waitForGuest(
  client: GuestClient,
  { timeoutMs, alive }: { timeoutMs: number; alive: () => Promise<boolean> },
) {
  const deadline = Date.now() + timeoutMs
  for (let i = 0; ; i++) {
    try {
      return await client.health(250)
    } catch {
      if (Date.now() > deadline) throw new Error(`guest didn't answer within ${timeoutMs / 1000} s`)
      // Checking the unit costs a process spawn, so only every ~0.5 s.
      if (i % 20 === 19 && !(await alive())) throw new Error('the VM exited during boot')
      await Bun.sleep(25)
    }
  }
}

export type GuestClient = ReturnType<typeof guestClient>
