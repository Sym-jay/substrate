import { CreateVm, ExecRequest, type HostdHealth } from '@substrate/protocol'
import { Hono, type Context } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'
import { HttpError, type VmService } from './vms.ts'

type Options = {
  token: string
  version: string
  image: () => Promise<string | null>
  vms: VmService
}

export function createApp({ token, version, image, vms }: Options) {
  const app = new Hono()

  app.use('*', bearerAuth({ token }))

  app.get('/health', async (c) => c.json({ ok: true, version, image: await image() } satisfies HostdHealth))
  app.get('/capacity', async (c) => c.json(await vms.capacity()))

  app.get('/vms', async (c) => c.json(await vms.list()))
  app.post('/vms', async (c) => c.json(await vms.create(await body(c, CreateVm)), 201))
  app.get('/vms/:id', async (c) => c.json(await vms.get(c.req.param('id'))))
  app.post('/vms/:id/start', async (c) => c.json(await vms.start(c.req.param('id'))))
  app.post('/vms/:id/stop', async (c) => c.json(await vms.stop(c.req.param('id'))))
  app.delete('/vms/:id', async (c) => {
    await vms.remove(c.req.param('id'))
    return c.body(null, 204)
  })
  app.post('/vms/:id/exec', async (c) => c.json(await vms.exec(c.req.param('id'), await body(c, ExecRequest))))

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status)
    console.error(err)
    return c.json({ error: err.message }, 500)
  })

  return app
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new HttpError(400, issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid request')
  }
  return parsed.data
}
