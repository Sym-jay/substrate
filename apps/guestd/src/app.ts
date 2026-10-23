import { CreateSession, ExecRequest, type ExecResult, type GuestHealth } from '@substrate/protocol'
import type { ServerWebSocket } from 'bun'
import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { upgradeWebSocket } from 'hono/bun'
import { HTTPException } from 'hono/http-exception'
import type { Sessions } from './sessions.ts'

type Options = {
  vmId: string
  token: string
  version: string
  run: (req: ExecRequest) => Promise<ExecResult>
  sessions: Sessions
}

// A browser that stops reading gets dropped rather than buffered forever.
const MAX_BUFFERED_BYTES = 1024 * 1024

export function createApp({ vmId, token, version, run, sessions }: Options) {
  const started = performance.now()
  const app = new Hono()

  // Only hostd knows the token; it came to this VM through the metadata service.
  app.use('*', bearerAuth({ token }))

  app.get('/health', (c) =>
    c.json({ ok: true, vmId, version, uptimeMs: Math.round(performance.now() - started) } satisfies GuestHealth),
  )

  app.post('/exec', async (c) => {
    const parsed = ExecRequest.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid request' }, 400)
    return c.json(await run(parsed.data))
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
    console.error(err)
    return c.json({ error: err.message }, 500)
  })

  return app
}
