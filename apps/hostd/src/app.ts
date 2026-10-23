import { CreateSession, CreateVm, ResizeVm, ForkVm, SshKey, ExecRequest, GrowDisk, UpdateVm, type PoolStatus, type HostdHealth } from '@substrate/protocol'
import { relayTo } from '@substrate/protocol/relay'
import { Hono, type Context } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { upgradeWebSocket } from 'hono/bun'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { HttpError, type VmService } from './vms.ts'
import { appHeaders, proxyHttp, tcpRelay } from './proxy.ts'
import { vmLogs } from './logs.ts'

type Options = {
  token: string
  version: string
  image: () => Promise<string | null>
  pool?: () => Promise<PoolStatus>
  vms: VmService
  logs?: typeof vmLogs
}

export function createApp({ token, version, image, pool, vms, logs = vmLogs }: Options) {
  const app = new Hono()

  app.use('*', bearerAuth({ token }))

  app.get('/health', async (c) => {
    const storage = pool ? await pool().catch(() => null) : null
    return c.json({ ok: true, version, image: await image(), pool: storage } satisfies HostdHealth)
  })
  app.get('/capacity', async (c) => c.json(await vms.capacity()))

  app.get('/vms', async (c) => c.json(await vms.list()))
  app.post('/vms', async (c) => {
    const { githubToken, targetId, ...input } = await body(c, CreateVm.extend({ githubToken: z.string().max(4096).optional(), targetId: z.string().regex(/^vm-[a-f0-9]{16}$/).optional() }))
    return c.json(await vms.create(input, githubToken, targetId), 201)
  })
  app.get('/vms/:id', async (c) => c.json(await vms.get(c.req.param('id'))))
  app.patch('/vms/:id', async (c) => c.json(await vms.update(c.req.param('id'), await body(c, UpdateVm))))
  app.post('/vms/:id/start', async (c) => c.json(await vms.start(c.req.param('id'))))
  app.post('/vms/:id/stop', async (c) => c.json(await vms.stop(c.req.param('id'))))
  app.post('/vms/:id/pause', async (c) => c.json(await vms.pause(c.req.param('id'))))
  app.post('/vms/:id/resume', async (c) => c.json(await vms.resume(c.req.param('id'))))
  app.post('/vms/:id/resize', async (c) => c.json(await vms.resize(c.req.param('id'), await body(c, ResizeVm))))
  app.post('/vms/:id/fork', async (c) => {
    const { targetId, ...input } = await body(c, ForkVm.extend({ targetId: z.string().regex(/^vm-[a-f0-9]{16}$/).optional() }))
    return c.json(await vms.fork(c.req.param('id'), input, targetId), 201)
  })
  app.get('/vms/:id/checkpoints', async (c) => c.json(await vms.checkpoints(c.req.param('id'))))
  app.post('/vms/:id/checkpoints/:checkpoint/restore', async (c) => c.json(await vms.rollback(c.req.param('id'), c.req.param('checkpoint'))))
  app.post('/vms/:id/ssh/keys', async (c) => {
    const input = await body(c, SshKey)
    await vms.start(c.req.param('id'))
    await (await vms.guest(c.req.param('id'))).authorizeSsh(input.publicKey)
    return c.json({ ok: true })
  })
  app.get('/vms/:id/ssh', upgradeWebSocket(async (c) => {
    const vm = await vms.start(c.req.param('id')!)
    return tcpRelay(vm.guestIp, 22, activityFor(vms, vm.id))
  }))
  app.all('/vms/:id/preview/:port/*', async (c) => {
    const port = Number(c.req.param('port'))
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 7000) return c.json({ error: 'invalid preview port' }, 400)
    const vm = await vms.start(c.req.param('id'))
    const touch = activityFor(vms, vm.id)
    touch()
    const original = new URL(c.req.url)
    const prefix = `/vms/${encodeURIComponent(vm.id)}/preview/${port}`
    const target = new URL(`http://${vm.guestIp}:${port}${original.pathname.slice(prefix.length) || '/'}${original.search}`)
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket') {
      return upgradeWebSocket(() => relayTo(target.href.replace(/^http/, 'ws'), Object.fromEntries(appHeaders(c.req.raw.headers)), touch))(c, async () => {})
    }
    try { return await proxyHttp(c.req.raw, target, '', touch) }
    catch { return c.json({ error: 'The dev server is not listening on this port' }, 502) }
  })
  app.post('/vms/:id/disk', async (c) => c.json(await vms.growDisk(c.req.param('id'), await body(c, GrowDisk))))
  app.delete('/vms/:id', async (c) => {
    await vms.remove(c.req.param('id'))
    return c.body(null, 204)
  })
  app.post('/vms/:id/exec', async (c) => c.json(await vms.exec(c.req.param('id'), await body(c, ExecRequest))))
  app.get('/vms/:id/logs', async (c) => {
    const { id } = await vms.get(c.req.param('id'))
    const lines = Math.min(Math.max(Math.trunc(Number(c.req.query('lines'))) || 200, 1), 2_000)
    return c.json(await logs(id, lines))
  })

  // Terminal sessions live in guestd; hostd only knows how to reach it.
  app.get('/vms/:id/sessions', async (c) => c.json(await (await vms.guest(c.req.param('id'))).sessions()))
  app.post('/vms/:id/sessions', async (c) => {
    return c.json(await vms.createSession(c.req.param('id'), await body(c, CreateSession)), 201)
  })
  app.get(
    '/vms/:id/sessions/:session/terminal',
    upgradeWebSocket(async (c) => {
      const { url, headers } = (await vms.guest(c.req.param('id')!)).terminal(c.req.param('session')!)
      return relayTo(url, headers)
    }),
  )

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status)
    // One line: the bundled binary would print screenfuls of minified source.
    console.error(`${c.req.method} ${c.req.path}: ${err.message}`)
    return c.json({ error: err.message }, 500)
  })

  return app
}

function activityFor(vms: VmService, id: string) {
  let last = -Infinity
  return () => {
    const now = performance.now()
    if (now - last >= 5000) { last = now; vms.touch?.(id) }
  }
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new HttpError(400, issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid request')
  }
  return parsed.data
}
