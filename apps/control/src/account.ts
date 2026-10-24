import { AgentKeyName, Quota, SetAgentKey, SetGitHubToken, type QuotaStatus, type Vm } from '@substrate/protocol'
import { Hono, type MiddlewareHandler } from 'hono'
import type { Authenticate, User } from './auth.ts'
import type { GitHub } from './github.ts'
import type { Owners } from './owners.ts'
import type { Quotas } from './quotas.ts'
import type { UserSecrets } from './secrets.ts'
import { monthOf, type Usage } from './usage.ts'
import type { Events, Users } from './users.ts'

type Env = { Variables: { user: User } }

export type AccountOptions = {
  authenticate: Authenticate
  users: Users
  events: Events
  usage: Usage
  quotas: Quotas
  owners: Owners
  // The user's VMs, from hostd (for disk totals).
  vmsOf: (userId: string) => Promise<Vm[] | null>
  // KMS-encrypted secrets; null where there's no KMS key (local development).
  secrets: UserSecrets | null
  github: GitHub | null
  // A user's agent keys changed: update their running VMs.
  keysChanged?: (userId: string) => Promise<void>
  admins: string[]
  now?: () => number
}

// A user's own things (Phase 2): agent keys, GitHub, usage, quota and activity.
export function accountRoutes(o: AccountOptions) {
  const app = new Hono<Env>()
  const now = o.now ?? Date.now
  const unavailable = (what: string) => ({ error: `${what} need a KMS key; this server has none` })

  // GitHub's redirect after "Connect with GitHub" carries no session token:
  // the state names the user (see github.ts).
  app.get('/github/callback', async (c) => {
    if (!o.github) return c.redirect('/?github=failed', 302)
    try {
      const userId = await o.github.finish(c.req.query('state') ?? '', c.req.query('code') ?? '')
      await o.events.record(userId, 'github.connected')
      return c.redirect('/?github=connected', 302)
    } catch (err) {
      console.error(`github callback: ${(err as Error).message}`)
      return c.redirect('/?github=failed', 302)
    }
  })

  const signedIn: MiddlewareHandler<Env> = async (c, next) => {
    const user = await o.authenticate(c.req.raw)
    if (!user) return c.json({ error: 'sign in first' }, 401)
    c.set('user', user)
    await o.users.touch(user.id).catch(() => {})
    await next()
  }
  for (const path of ['/keys', '/keys/*', '/github', '/github/*', '/usage', '/quota', '/events', '/admin/*']) app.use(path, signedIn)

  // ── Agent keys ──
  app.get('/keys', async (c) => {
    if (!o.secrets) return c.json([])
    return c.json((await o.secrets.list(c.var.user.id)).filter((key) => AgentKeyName.safeParse(key.name).success))
  })
  app.put('/keys/:name', async (c) => {
    if (!o.secrets) return c.json(unavailable('Agent keys'), 503)
    const name = AgentKeyName.safeParse(c.req.param('name'))
    const input = SetAgentKey.safeParse(await c.req.json().catch(() => null))
    if (!name.success) return c.json({ error: 'unknown key' }, 404)
    if (!input.success) return c.json({ error: input.error.issues[0]?.message ?? 'invalid key' }, 400)
    await o.secrets.set(c.var.user.id, name.data, input.data.value, input.data.value.slice(-4))
    await o.events.record(c.var.user.id, 'key.set', null, { name: name.data })
    await o.keysChanged?.(c.var.user.id).catch((err: Error) => console.error(`keys: ${err.message}`))
    return c.body(null, 204)
  })
  app.delete('/keys/:name', async (c) => {
    if (!o.secrets) return c.json(unavailable('Agent keys'), 503)
    const name = AgentKeyName.safeParse(c.req.param('name'))
    if (!name.success) return c.json({ error: 'unknown key' }, 404)
    await o.secrets.remove(c.var.user.id, name.data)
    await o.events.record(c.var.user.id, 'key.removed', null, { name: name.data })
    await o.keysChanged?.(c.var.user.id).catch((err: Error) => console.error(`keys: ${err.message}`))
    return c.body(null, 204)
  })

  // ── GitHub ──
  app.get('/github', async (c) => c.json(o.github ? await o.github.status(c.var.user.id) : { connected: false, login: null, oauth: false }))
  app.post('/github/connect', async (c) => {
    if (!o.github) return c.json(unavailable('GitHub connections'), 503)
    try { return c.json({ url: await o.github.authorizeUrl(c.var.user.id) }) }
    catch (err) { return c.json({ error: (err as Error).message }, 409) }
  })
  app.put('/github/token', async (c) => {
    if (!o.github) return c.json(unavailable('GitHub connections'), 503)
    const input = SetGitHubToken.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: input.error.issues[0]?.message ?? 'invalid token' }, 400)
    try {
      const login = await o.github.connectWithToken(c.var.user.id, input.data.token)
      await o.events.record(c.var.user.id, 'github.connected', null, { login })
      return c.json({ login })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })
  app.delete('/github', async (c) => {
    if (!o.github) return c.body(null, 204)
    await o.github.disconnect(c.var.user.id)
    await o.events.record(c.var.user.id, 'github.disconnected')
    return c.body(null, 204)
  })
  app.get('/github/repos', async (c) => {
    if (!o.github) return c.json(unavailable('GitHub connections'), 503)
    try { return c.json(await o.github.repos(c.var.user.id, c.req.query('q') ?? '')) }
    catch (err) { return c.json({ error: (err as Error).message }, 409) }
  })

  // ── Usage, quota and activity ──
  app.get('/usage', async (c) => c.json(await o.usage.report(c.var.user.id, c.req.query('month') ?? monthOf(now()))))
  app.get('/quota', async (c) => {
    const userId = c.var.user.id
    const vms = await o.vmsOf(userId)
    const status: QuotaStatus = {
      limits: await o.quotas.of(userId),
      used: {
        vms: vms?.length ?? (await o.owners.vmsOf(userId)).length,
        totalDiskGib: vms?.reduce((total, vm) => total + vm.diskGib, 0) ?? 0,
        runningHours: Math.round((await o.usage.runningHours(userId, monthOf(now()))) * 100) / 100,
      },
    }
    return c.json(status)
  })
  app.get('/events', async (c) => c.json(await o.events.list(c.var.user.id, Math.min(Number(c.req.query('limit')) || 50, 200))))

  // ── Admins: anyone's quota ──
  const admin: MiddlewareHandler<Env> = async (c, next) => {
    if (!o.admins.includes(c.var.user.id)) return c.json({ error: 'not found' }, 404)
    await next()
  }
  app.get('/admin/quotas/:user', admin, async (c) => c.json(await o.quotas.of(c.req.param('user'))))
  app.put('/admin/quotas/:user', admin, async (c) => {
    const input = Quota.partial().safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: input.error.issues[0]?.message ?? 'invalid quota' }, 400)
    await o.quotas.set(c.req.param('user'), input.data)
    return c.json(await o.quotas.of(c.req.param('user')))
  })
  app.delete('/admin/quotas/:user', admin, async (c) => {
    await o.quotas.reset(c.req.param('user'))
    return c.json(await o.quotas.of(c.req.param('user')))
  })

  return app
}
