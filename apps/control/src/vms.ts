import type { Vm } from '@substrate/protocol'
import { relayTo } from '@substrate/protocol/relay'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import type { Authenticate, User } from './auth.ts'
import type { Owners } from './owners.ts'
import type { Tickets } from './tickets.ts'

export type VmRoutesOptions = {
  hostd: { url: string; token: string }
  authenticate: Authenticate
  owners: Owners
  tickets: Tickets
  maxVmsPerUser: number
}

type Env = { Variables: { user: User } }

// VMs and their terminals, passed through to hostd with its token. Every
// route needs a signed-in user, and each user only sees their own VMs.
export function vmRoutes({ hostd, authenticate, owners, tickets, maxVmsPerUser }: VmRoutesOptions) {
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

  const signedIn: MiddlewareHandler<Env> = async (c, next) => {
    const user = await authenticate(c.req.raw)
    if (!user) return c.json({ error: 'sign in first' }, 401)
    c.set('user', user)
    await next()
  }
  app.use('/vms', signedIn)
  app.use('/vms/*', signedIn)

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

  app.post('/vms', async (c) => {
    const vms = await allVms()
    if (!vms) return unreachable(c)
    const mine = new Set(owners.vmsOf(c.var.user.id))
    const count = vms.filter((vm) => mine.has(vm.id)).length
    if (count >= maxVmsPerUser) {
      return c.json({ error: `you have ${count} VMs, the most each user may have. Delete one first.` }, 409)
    }
    const res = await callHostd('/vms', { method: 'POST', body: await c.req.text() })
    if (!res) return unreachable(c)
    if (res.status !== 201) return passThrough(res)
    const vm = (await res.json()) as Vm
    owners.add(vm.id, c.var.user.id)
    return c.json(vm, 201)
  })

  app.post('/vms/:id/sessions/:session/terminal/ticket', (c) =>
    c.json({
      ticket: tickets.issue({ userId: c.var.user.id, vmId: c.req.param('id'), sessionId: c.req.param('session') }),
    }),
  )

  app.on(['GET', 'POST', 'DELETE'], ['/vms/:id', '/vms/:id/*'], async (c) => {
    const res = await callHostd(hostdPath(c), {
      method: c.req.method,
      body: c.req.method === 'POST' ? await c.req.text() : undefined,
    })
    if (!res) return unreachable(c)
    if (c.req.method === 'DELETE' && res.status === 204) owners.remove(c.req.param('id') ?? '')
    return passThrough(res)
  })

  return app
}
