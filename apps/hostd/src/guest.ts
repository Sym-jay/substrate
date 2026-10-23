import { ExecResult, GUESTD_PORT, GuestHealth, type ExecRequest } from '@substrate/protocol'

export function guestClient(guestIp: string, token: string) {
  const base = `http://${guestIp}:${GUESTD_PORT}`
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
      })
      if (!res.ok) throw new Error(`guest exec returned ${res.status}: ${await res.text()}`)
      return ExecResult.parse(await res.json())
    },
  }
}

// Polls until the guest agent answers. Gives up early if the VM process died.
export async function waitForGuest(
  client: ReturnType<typeof guestClient>,
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
