import { AgentEnv, CreateSession, ExecRequest, GitHubRepo, SshKey, type ExecResult, type GuestHealth } from '@substrate/protocol'
import { writeAgentEnv } from './environment.ts'
import { z } from 'zod'
import { setupRepository } from './repository.ts'
import { authorizeSsh } from './ssh.ts'
import type { ServerWebSocket } from 'bun'
import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { upgradeWebSocket } from 'hono/bun'
import { HTTPException } from 'hono/http-exception'
import type { Activity } from './activity.ts'
import type { Sessions } from './sessions.ts'

type Options = {
  vmId: string
  token: string
  version: string
  run: (req: ExecRequest) => Promise<ExecResult>
  sessions: Sessions
  // Where the user's agent keys go (environment.ts); tests substitute a fake.
  agentEnv?: (env: AgentEnv) => Promise<unknown>
  activity: Activity
}

// A browser that stops reading gets dropped rather than buffered forever.
const MAX_BUFFERED_BYTES = 1024 * 1024

export function createApp({ vmId, token, version, run, sessions, activity, agentEnv = writeAgentEnv }: Options) {
  const started = performance.now()
  const app = new Hono()

  // Only hostd knows the token; it came to this VM through the metadata service.
  app.use('*', bearerAuth({ token }))

  app.get('/health', (c) =>
    c.json({ ok: true, vmId, version, uptimeMs: Math.round(performance.now() - started), features: { forkNetwork: true } } satisfies GuestHealth),
  )

  // hostd polls this for alerts and auto-pause.
  app.get('/activity', (c) => c.json(activity.report()))

  app.post('/exec', async (c) => {
    const parsed = ExecRequest.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid request' }, 400)
    return c.json(await run(parsed.data))
  })

  // The user's agent keys, from the control box through hostd only.
  app.put('/agent-env', async (c) => {
    const parsed = AgentEnv.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid agent environment' }, 400)
    await agentEnv(parsed.data)
    return c.body(null, 204)
  })

  app.post('/repository', async (c) => {
    const parsed = z.object({ repository: GitHubRepo, token: z.string().max(4096).optional() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid repository request' }, 400)
    try { await setupRepository(parsed.data.repository, parsed.data.token); return c.json({ ok: true }) }
    catch { return c.json({ error: 'Repository setup failed; verify its name and token access' }, 502) }
  })
  app.post('/ssh/keys', async (c) => {
    const parsed = SshKey.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid SSH public key' }, 400)
    await authorizeSsh(parsed.data.publicKey)
    return c.json({ ok: true })
  })

  app.get('/sessions', (c) => c.json(sessions.list()))

  app.post('/sessions', async (c) => {
    const parsed = CreateSession.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid request' }, 400)
    const session = sessions.create(parsed.data)
    if (!session) return c.json({ error: 'this VM has too many open sessions' }, 409)
    return c.json(session.info, 201)
  })

  app.get(
    '/sessions/:id/terminal',
    async (c, next) => {
      if (!sessions.get(c.req.param('id'))) return c.json({ error: 'no such session' }, 404)
      await next()
    },
    upgradeWebSocket((c) => {
      const session = sessions.get(c.req.param('id')!)!
      let detach = () => {}
      return {
        onOpen(_event, ws) {
          const raw = ws.raw as ServerWebSocket
          detach = session.attach((message) => {
            if (raw.getBufferedAmount() > MAX_BUFFERED_BYTES) ws.close(1013, 'client too slow')
            else ws.send(JSON.stringify(message))
          })
        },
        onMessage(event, ws) {
          let value: unknown
          try {
            value = JSON.parse(String(event.data))
          } catch {
            value = null
          }
          if (!session.receive(value)) ws.close(1008, 'invalid terminal message')
        },
        onClose: () => detach(),
      }
    }),
  )

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    // One line: the bundled binary would print screenfuls of minified source.
    console.error(`${c.req.method} ${c.req.path}: ${err.message}`)
    return c.json({ error: err.message }, 500)
  })

  return app
}
