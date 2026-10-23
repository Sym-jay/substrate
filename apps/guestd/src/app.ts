import { CreateSession, ExecRequest, GitHubRepo, SshKey, StartGuestTask, CancelGuestTask, TaskId, type ExecResult, type GuestHealth } from '@substrate/protocol'
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
import type { Tasks } from './tasks.ts'

type Options = {
  vmId: string
  token: string
  version: string
  run: (req: ExecRequest) => Promise<ExecResult>
  sessions: Sessions
  activity: Activity
  tasks?: Tasks
}

// A browser that stops reading gets dropped rather than buffered forever.
const MAX_BUFFERED_BYTES = 1024 * 1024

export function createApp({ vmId, token, version, run, sessions, activity, tasks }: Options) {
  const started = performance.now()
  const app = new Hono()

  // Only hostd knows the token; it came to this VM through the metadata service.
  app.use('*', bearerAuth({ token }))

  app.get('/health', (c) =>
    c.json({ ok: true, vmId, version, uptimeMs: Math.round(performance.now() - started), features: { forkNetwork: true, tasks: !!tasks } } satisfies GuestHealth),
  )

  // hostd polls this for alerts and auto-pause.
  app.get('/activity', (c) => c.json(activity.report()))

  app.get('/tasks', (c) => tasks ? c.json(tasks.list()) : c.json({ error: 'Tasks are not configured' }, 503))
  app.get('/tasks/:id', (c) => {
    if (!TaskId.safeParse(c.req.param('id')).success) return c.json({ error: 'invalid task ID' }, 400)
    const task = tasks?.get(c.req.param('id'))
    return task ? c.json(task) : c.json({ error: 'task not found' }, 404)
  })
  app.post('/tasks', async (c) => {
    if (!tasks) return c.json({ error: 'Tasks are not configured' }, 503)
    const parsed = StartGuestTask.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid task' }, 400)
    try { return c.json(await tasks.create(parsed.data), 201) }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Could not start task' }, 409) }
  })
  app.post('/tasks/:id/cancel', async (c) => {
    if (!TaskId.safeParse(c.req.param('id')).success) return c.json({ error: 'invalid task ID' }, 400)
    const input = CancelGuestTask.safeParse(await c.req.json().catch(() => ({})))
    if (!input.success) return c.json({ error: 'invalid cancellation' }, 400)
    const task = await tasks?.cancel(c.req.param('id'), input.data.spec)
    return task ? c.json(task) : c.json({ error: 'task not found' }, 404)
  })

  app.post('/exec', async (c) => {
    const parsed = ExecRequest.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid request' }, 400)
    return c.json(await run(parsed.data))
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
