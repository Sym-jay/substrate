import { AgentEventReport, type AgentEvent } from '@substrate/protocol'
import { chmod, mkdir, rm } from 'node:fs/promises'
import type { Activity } from './activity.ts'

// Inside the VM only: anyone in it may report, so it's a Unix socket rather
// than the token-protected port hostd uses.
export const EVENTS_SOCKET = '/run/substrate/events.sock'

// Claude Code notifications worth an alert. The rest, like `idle_prompt`
// (sent a minute after Stop) or `auth_success`, aren't.
const ATTENTION = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'])

// Turns what an agent's hook reported into an event, or null to ignore it.
export function interpret({ agent, kind, payload }: AgentEventReport): Pick<AgentEvent, 'agent' | 'kind' | 'message'> | null {
  const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const text = (key: string) => (typeof data[key] === 'string' ? (data[key] as string).slice(0, 200) : null)
  // Codex's `notify` sends only agent-turn-complete for now; skip anything newer.
  if (agent === 'codex' && data.type !== undefined && data.type !== 'agent-turn-complete') return null
  if (agent === 'claude' && kind === 'attention') {
    const type = text('notification_type')
    if (type && !ATTENTION.has(type)) return null
  }
  return { agent, kind, message: kind === 'attention' ? text('message') : null }
}

export async function serveEvents(activity: Activity, socket = EVENTS_SOCKET) {
  await mkdir(socket.slice(0, socket.lastIndexOf('/')), { recursive: true })
  await rm(socket, { force: true })
  Bun.serve({
    unix: socket,
    async fetch(req) {
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/events') return new Response(null, { status: 404 })
      const parsed = AgentEventReport.safeParse(await req.json().catch(() => null))
      if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? 'invalid event' }, { status: 400 })
      const event = interpret(parsed.data)
      if (event) activity.record(event)
      return new Response(null, { status: 204 })
    },
  })
  // Agents run as dev, not root.
  await chmod(socket, 0o666)
}

// `substrate-event AGENT start|stop|attention [JSON]`, run by agent hooks.
// Codex passes its JSON as the last argument, Claude Code on stdin. It always
// exits 0, so a hook never gets in an agent's way.
export async function sendEvent([agent, kind, json]: string[], socket = EVENTS_SOCKET) {
  const text = json ?? (process.stdin.isTTY ? '' : await Promise.race([Bun.stdin.text(), Bun.sleep(2_000).then(() => '')]))
  let payload: unknown
  try {
    payload = text ? JSON.parse(text) : undefined
  } catch {
    payload = undefined
  }
  try {
    const res = await fetch('http://guestd/events', {
      unix: socket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, kind, payload }),
      signal: AbortSignal.timeout(2_000),
    })
    if (!res.ok) console.error(`substrate-event: ${((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? res.status}`)
  } catch (err) {
    console.error(`substrate-event: can't reach guestd: ${err}`)
  }
  return 0
}
