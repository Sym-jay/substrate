import { ExecRequest, type ExecResult, type GuestHealth } from '@substrate/protocol'
import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { HTTPException } from 'hono/http-exception'

type Options = {
  vmId: string
  token: string
  version: string
  run: (req: ExecRequest) => Promise<ExecResult>
}

export function createApp({ vmId, token, version, run }: Options) {
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

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    console.error(err)
    return c.json({ error: err.message }, 500)
  })

  return app
}
