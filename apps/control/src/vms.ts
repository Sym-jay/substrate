import { CreateVm, ForkVm, type Vm } from '@substrate/protocol'
import { randomBytes } from 'node:crypto'
import { relayTo } from '@substrate/protocol/relay'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import type { Authenticate, User } from './auth.ts'
import type { Owners } from './owners.ts'
import type { Tickets } from './tickets.ts'
import type { Capabilities } from './capabilities.ts'
import type { Jobs } from './jobs.ts'
import { previewPort, previewPrefix } from './previews.ts'

export type VmRoutesOptions = {
  hostd: { url: string; token: string }
  authenticate: Authenticate
  owners: Owners
  tickets: Tickets
  maxVmsPerUser: number
  capabilities?: Capabilities
  jobs?: Jobs
  previewOrigin?: string | null
  githubToken?: (userId: string) => Promise<string | undefined>
}

type Env = { Variables: { user: User } }

// VMs and their terminals, passed through to hostd with its token. Every
// route needs a signed-in user, and each user only sees their own VMs.
export function vmRoutes({ hostd, authenticate, owners, tickets, maxVmsPerUser, capabilities, jobs, previewOrigin, githubToken }: VmRoutesOptions) {
  const app = new Hono<Env>()
  const auth = { Authorization: `Bearer ${hostd.token}` }
  const hostdPath = (c: Context) => c.req.path.replace(/^\/api/, '')
  const callHostd = (path: string, init: RequestInit = {}) =>
    fetch(`${hostd.url}${path}`, { ...init, headers: { ...auth, 'content-type': 'application/json' } }).catch(
      () => null,
    )
  const unreachable = (c: Context) => c.json({ error: "can't reach the sandbox host. Is it running?" }, 502)
  const passThrough = (res: Response) =>
    new Response(res.body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    })
  const allVms = async () => {
    const res = await callHostd('/vms')
    return res?.ok ? ((await res.json()) as Vm[]) : null
  }

  // The terminal takes a ticket instead of a session token (see tickets.ts).
  app.get(
    '/vms/:id/sessions/:session/terminal',
    async (c, next) => {
      const id = c.req.param('id')
      const user = tickets.redeem(c.req.query('ticket') ?? '', id, c.req.param('session'))
      if (!user || owners.owner(id) !== user) return c.json({ error: 'missing or expired terminal ticket' }, 401)
      await next()
    },
    upgradeWebSocket((c) => relayTo(`${hostd.url.replace(/^http/, 'ws')}${hostdPath(c)}`, auth)),
  )

  app.get('/vms/:id/ssh', async (c, next) => {
    const id = c.req.param('id')
    const grant = capabilities?.read(c.req.query('access') ?? '', 'ssh', id, 22)
    if (!grant || owners.owner(id) !== grant.userId) return c.json({ error: 'missing or expired SSH access' }, 401)
    await next()
  }, upgradeWebSocket((c) => relayTo(`${hostd.url.replace(/^http/, 'ws')}${hostdPath(c)}`, auth)))

  const signedIn: MiddlewareHandler<Env> = async (c, next) => {
    const user = await authenticate(c.req.raw)
    if (!user) return c.json({ error: 'sign in first' }, 401)
    c.set('user', user)
    await next()
  }
  app.use('/vms', signedIn)
  app.use('/vms/*', signedIn)
  app.use('/jobs', signedIn)
  app.use('/jobs/*', signedIn)
  app.use('/capacity', signedIn)
  app.get('/jobs', (c) => c.json(jobs?.list(c.var.user.id) ?? []))
  // The host's CPUs and memory, for the web app's Compute page.
  app.get('/capacity', async (c) => {
    const res = await callHostd('/capacity')
    return res?.ok ? c.json(await res.json()) : unreachable(c)
  })
  app.get('/jobs/:id', (c) => {
    const job = jobs?.read(c.req.param('id'), c.var.user.id)
    return job ? c.json(job) : c.json({ error: 'job not found' }, 404)
  })

  // Someone else's VM is a 404, the same as a VM that doesn't exist.
  const ownVm: MiddlewareHandler<Env> = async (c, next) => {
    const id = c.req.param('id') ?? ''
    if (owners.owner(id) !== c.var.user.id) return c.json({ error: `no VM ${id}` }, 404)
    await next()
  }
  app.use('/vms/:id', ownVm)
  app.use('/vms/:id/*', ownVm)

  app.get('/vms', async (c) => {
    const vms = await allVms()
    if (!vms) return unreachable(c)
    const mine = new Set(owners.vmsOf(c.var.user.id))
    return c.json(vms.filter((vm) => mine.has(vm.id)))
  })

  const exclusive = <T,>(userId: string, work: () => Promise<T>) => jobs ? jobs.exclusive(userId, work) : work()
  const vmCount = (vms: Vm[], userId: string) => {
    const mine = new Set(owners.vmsOf(userId))
    return new Set([...vms.filter((vm) => mine.has(vm.id)).map((vm) => vm.id), ...jobs?.pending(userId) ?? []]).size
  }
  app.post('/vms', (c) => exclusive(c.var.user.id, async () => {
    const vms = await allVms()
    if (!vms) return unreachable(c)
    const count = vmCount(vms, c.var.user.id)
    if (count >= maxVmsPerUser) {
      return c.json({ error: `you have ${count} VMs, the most each user may have. Delete one first.` }, 409)
    }
    const parsed = CreateVm.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid workspace' }, 400)
    const credential = parsed.data.repository ? await githubToken?.(c.var.user.id) : undefined
    if (jobs) {
      const targetId = `vm-${randomBytes(8).toString('hex')}`
      owners.add(targetId, c.var.user.id)
      const job = jobs.launch(c.var.user.id, targetId, async () => {
        const res = await callHostd('/vms', { method: 'POST', body: JSON.stringify({ ...parsed.data, githubToken: credential, targetId }) })
        if (!res) throw new Error('The host is unreachable. Refresh workspaces before creating another.')
        if (res.status !== 201) {
          // A failed boot may still have a durable VM record. Keep ownership
          // so its creator can inspect/delete it; absent IDs use no VM quota.
          const body = await res.json().catch(() => null) as { error?: string } | null
          throw new Error(body?.error ?? 'Workspace creation failed')
        }
      })
      c.header('cache-control', 'no-store')
      return c.json(job, 202)
    }
    const res = await callHostd('/vms', { method: 'POST', body: JSON.stringify({ ...parsed.data, githubToken: credential }) })
    if (!res) return unreachable(c)
    if (res.status !== 201) return passThrough(res)
    const vm = (await res.json()) as Vm
    owners.add(vm.id, c.var.user.id)
    return c.json(vm, 201)
  }))

  app.post('/vms/:id/sessions/:session/terminal/ticket', (c) =>
    c.json({
      ticket: tickets.issue({ userId: c.var.user.id, vmId: c.req.param('id'), sessionId: c.req.param('session') }),
    }),
  )

  app.post('/vms/:id/fork', (c) => exclusive(c.var.user.id, async () => {
    if (!jobs) return c.json({ error: 'Fork jobs are not configured' }, 503)
    const input = ForkVm.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: 'Invalid fork name' }, 400)
    const vms = await allVms()
    if (!vms) return unreachable(c)
    if (vmCount(vms, c.var.user.id) >= maxVmsPerUser) return c.json({ error: 'Delete a workspace before creating another fork; your VM quota is full' }, 409)
    const targetId = `vm-${randomBytes(8).toString('hex')}`
    owners.add(targetId, c.var.user.id)
    const path = hostdPath(c)
    const job = jobs.launch(c.var.user.id, targetId, async () => {
      const res = await callHostd(path, { method: 'POST', body: JSON.stringify({ ...input.data, targetId }) })
      if (!res) throw new Error('The host is unreachable. Refresh workspaces before retrying the fork.')
      if (res.status !== 201) {
        // Keep ownership if a failed cleanup left a recoverable child behind.
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? 'Fork failed')
      }
    }, 'fork')
    c.header('cache-control', 'no-store')
    return c.json(job, 202)
  }))

  app.post('/vms/:id/previews', async (c) => {
    if (!previewOrigin) return c.json({ error: 'Previews need the M6 infrastructure deployment first' }, 503)
    const input = await c.req.json().catch(() => null) as { port?: unknown } | null
    if (typeof input?.port !== 'number' || !previewPort(input.port)) return c.json({ error: 'Choose an app port between 1024 and 65535, excluding 7000' }, 400)
    const id = c.req.param('id')
    const ticket = tickets.issue({ userId: c.var.user.id, vmId: id, sessionId: `preview:${input.port}` })
    const url = new URL(previewPrefix(id, input.port) + '/', previewOrigin)
    url.searchParams.set('__substrate_ticket', ticket)
    return c.json({ url: url.href, basePath: previewPrefix(id, input.port) + '/' })
  })

  app.post('/vms/:id/ssh/access', (c) => {
    if (!capabilities) return c.json({ error: 'SSH access is not configured' }, 503)
    const id = c.req.param('id')
    const grant = capabilities.issue({ userId: c.var.user.id, vmId: id, port: 22, kind: 'ssh' })
    const url = new URL(`/api/vms/${encodeURIComponent(id)}/ssh`, c.req.url)
    url.protocol = url.protocol === 'https:' || url.hostname.endsWith('.cloudfront.net') ? 'wss:' : 'ws:'
    url.searchParams.set('access', grant.token)
    c.header('cache-control', 'no-store')
    return c.json({ url: url.href, expiresAt: grant.expiresAt })
  })

  app.on(['GET', 'POST', 'PATCH', 'DELETE'], ['/vms/:id', '/vms/:id/*'], async (c) => {
    // Only management endpoints belong on the control origin. In particular,
    // never expose guest app HTML through this authenticated catch-all: Clerk
    // can authenticate navigation cookies as well as API bearer tokens.
    const suffix = hostdPath(c).replace(/^\/vms\/[^/]+/, '')
    const allowed: Record<string, RegExp> = {
      GET: /^(?:|\/(?:sessions|checkpoints))$/,
      POST: /^\/(?:start|stop|pause|resume|resize|disk|exec|sessions|ssh\/keys|checkpoints\/[a-f0-9-]{36}\/restore)$/,
      PATCH: /^$/,
      DELETE: /^$/,
    }
    if (!allowed[c.req.method]?.test(suffix)) return c.json({ error: 'not found' }, 404)
    const res = await callHostd(hostdPath(c), {
      method: c.req.method,
      body: c.req.method === 'POST' || c.req.method === 'PATCH' ? await c.req.text() : undefined,
    })
    if (!res) return unreachable(c)
    if (c.req.method === 'DELETE' && res.status === 204) owners.remove(c.req.param('id') ?? '')
    return passThrough(res)
  })

  return app
}
