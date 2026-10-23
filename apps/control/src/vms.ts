import { CreateVm, DEFAULT_DISK_GIB, DEFAULT_VM_SIZE, ForkVm, GrowDisk, ResizeVm, Session, UpdateVm, VmSizes, type AgentEnv, type Quota, type Vm } from '@substrate/protocol'
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
import { quotaError, type QuotaChange, type Quotas } from './quotas.ts'
import { monthOf, type Usage } from './usage.ts'
import { sessionsTable, type Events, type Users } from './users.ts'

// hostd's address and token. The token is read on every call: it rotates.
export type Hostd = { url: string; readonly token: string }

export type VmRoutesOptions = {
  hostd: Hostd
  authenticate: Authenticate
  owners: Owners
  tickets: Tickets
  maxVmsPerUser: number
  capabilities?: Capabilities
  jobs?: Jobs
  previewOrigin?: string | null
  githubToken?: (userId: string) => Promise<string | undefined>
  // Phase 2: per-user quotas, metered usage, activity, and agent keys.
  quotas?: Quotas
  usage?: Usage
  events?: Events
  users?: Users
  sessions?: ReturnType<typeof sessionsTable>
  agentEnv?: (userId: string) => Promise<AgentEnv>
  now?: () => number
}

type Env = { Variables: { user: User } }

// Without quotas configured (tests, local development): just the VM count.
const openQuota = (maxVms: number): Quota => ({
  maxVms, sizes: ['small', 'medium', 'large'], maxDiskGib: 1024, maxTotalDiskGib: 1_000_000, maxRunningHours: Number.POSITIVE_INFINITY, egress: 'open',
})

// VMs and their terminals, passed through to hostd with its token. Every
// route needs a signed-in user, and each user only sees their own VMs.
export function vmRoutes(o: VmRoutesOptions) {
  const { hostd, authenticate, owners, tickets, capabilities, jobs, previewOrigin, githubToken } = o
  const now = o.now ?? Date.now
  const app = new Hono<Env>()
  const auth = () => ({ Authorization: `Bearer ${hostd.token}` })
  const hostdPath = (c: Context) => c.req.path.replace(/^\/api/, '')
  const callHostd = (path: string, init: RequestInit = {}) =>
    fetch(`${hostd.url}${path}`, { ...init, headers: { ...auth(), 'content-type': 'application/json' } }).catch(
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
  const record = (userId: string, kind: string, vmId: string | null = null, detail: Record<string, unknown> | null = null) =>
    o.events?.record(userId, kind, vmId, detail)

  // The terminal takes a ticket instead of a session token (see tickets.ts).
  app.get(
    '/vms/:id/sessions/:session/terminal',
    async (c, next) => {
      const id = c.req.param('id')
      const user = tickets.redeem(c.req.query('ticket') ?? '', id, c.req.param('session'))
      if (!user || (await owners.owner(id)) !== user) return c.json({ error: 'missing or expired terminal ticket' }, 401)
      await next()
    },
    upgradeWebSocket((c) => relayTo(`${hostd.url.replace(/^http/, 'ws')}${hostdPath(c)}`, auth())),
  )

  app.get('/vms/:id/ssh', async (c, next) => {
    const id = c.req.param('id')
    const grant = await capabilities?.read(c.req.query('access') ?? '', 'ssh', id, 22)
    if (!grant || (await owners.owner(id)) !== grant.userId) return c.json({ error: 'missing or expired SSH access' }, 401)
    await next()
  }, upgradeWebSocket((c) => relayTo(`${hostd.url.replace(/^http/, 'ws')}${hostdPath(c)}`, auth())))

  const signedIn: MiddlewareHandler<Env> = async (c, next) => {
    const user = await authenticate(c.req.raw)
    if (!user) return c.json({ error: 'sign in first' }, 401)
    c.set('user', user)
    await o.users?.touch(user.id).catch(() => {})
    await next()
  }
  app.use('/vms', signedIn)
  app.use('/vms/*', signedIn)
  app.use('/jobs', signedIn)
  app.use('/jobs/*', signedIn)
  app.get('/jobs', async (c) => c.json((await jobs?.list(c.var.user.id)) ?? []))
  app.get('/jobs/:id', async (c) => {
    const job = await jobs?.read(c.req.param('id'), c.var.user.id)
    return job ? c.json(job) : c.json({ error: 'job not found' }, 404)
  })

  // Someone else's VM is a 404, the same as a VM that doesn't exist.
  const ownVm: MiddlewareHandler<Env> = async (c, next) => {
    const id = c.req.param('id') ?? ''
    if ((await owners.owner(id)) !== c.var.user.id) return c.json({ error: `no VM ${id}` }, 404)
    await next()
  }
  app.use('/vms/:id', ownVm)
  app.use('/vms/:id/*', ownVm)

  app.get('/vms', async (c) => {
    const vms = await allVms()
    if (!vms) return unreachable(c)
    const mine = new Set(await owners.vmsOf(c.var.user.id))
    return c.json(vms.filter((vm) => mine.has(vm.id)))
  })

  const exclusive = <T,>(userId: string, work: () => Promise<T>) => jobs ? jobs.exclusive(userId, work) : work()

  // The user's quota, and how much of it a change would use.
  const quotaFor = async (userId: string, vms: Vm[]) => {
    const limits = o.quotas ? await o.quotas.of(userId) : openQuota(o.maxVmsPerUser)
    const mineIds = new Set(await owners.vmsOf(userId))
    const mine = vms.filter((vm) => mineIds.has(vm.id))
    const pending = (await jobs?.pending(userId)) ?? []
    const used = {
      vms: new Set([...mine.map((vm) => vm.id), ...pending]).size,
      totalDiskGib: mine.reduce((total, vm) => total + vm.diskGib, 0),
      runningHours: o.usage ? await o.usage.runningHours(userId, monthOf(now())) : 0,
    }
    return { limits, used, mine, check: (change: QuotaChange) => quotaError(limits, used, change) }
  }

  app.post('/vms', (c) => exclusive(c.var.user.id, async () => {
    const vms = await allVms()
    if (!vms) return unreachable(c)
    const parsed = CreateVm.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid workspace' }, 400)
    const quota = await quotaFor(c.var.user.id, vms)
    const diskGib = parsed.data.diskGib ?? DEFAULT_DISK_GIB
    const refused = quota.check({ newVm: true, size: parsed.data.size ?? DEFAULT_VM_SIZE, diskGib, addDiskGib: diskGib, start: true })
    if (refused) return c.json({ error: refused }, 409)
    const input = { ...parsed.data }
    // A plan with allowlisted egress makes every new VM's egress allowlisted.
    if (quota.limits.egress === 'allowlist') input.egress = { mode: 'allowlist', allow: input.egress?.allow ?? [] }
    const credential = input.repository ? await githubToken?.(c.var.user.id) : undefined
    if (jobs) {
      const targetId = `vm-${randomBytes(8).toString('hex')}`
      await owners.add(targetId, c.var.user.id)
      await record(c.var.user.id, 'vm.created', targetId, { size: input.size ?? DEFAULT_VM_SIZE, repository: input.repository ?? null })
      const job = await jobs.launch(c.var.user.id, targetId, async () => {
        const res = await callHostd('/vms', { method: 'POST', body: JSON.stringify({ ...input, githubToken: credential, targetId }) })
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
    const res = await callHostd('/vms', { method: 'POST', body: JSON.stringify({ ...input, githubToken: credential }) })
    if (!res) return unreachable(c)
    if (res.status !== 201) return passThrough(res)
    const vm = (await res.json()) as Vm
    await owners.add(vm.id, c.var.user.id)
    await record(c.var.user.id, 'vm.created', vm.id, { size: input.size ?? DEFAULT_VM_SIZE, repository: input.repository ?? null })
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
    const quota = await quotaFor(c.var.user.id, vms)
    const source = quota.mine.find((vm) => vm.id === c.req.param('id'))
    const refused = quota.check({ newVm: true, addDiskGib: source?.diskGib ?? 0, start: true })
    if (refused) return c.json({ error: refused }, 409)
    const targetId = `vm-${randomBytes(8).toString('hex')}`
    await owners.add(targetId, c.var.user.id)
    await record(c.var.user.id, 'vm.forked', targetId, { from: c.req.param('id') })
    const path = hostdPath(c)
    const job = await jobs.launch(c.var.user.id, targetId, async () => {
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

  app.post('/vms/:id/ssh/access', async (c) => {
    if (!capabilities) return c.json({ error: 'SSH access is not configured' }, 503)
    const id = c.req.param('id')
    const grant = await capabilities.issue({ userId: c.var.user.id, vmId: id, port: 22, kind: 'ssh' })
    const url = new URL(`/api/vms/${encodeURIComponent(id)}/ssh`, c.req.url)
    url.protocol = url.protocol === 'https:' || url.hostname.endsWith('.cloudfront.net') ? 'wss:' : 'ws:'
    url.searchParams.set('access', grant.token)
    c.header('cache-control', 'no-store')
    return c.json({ url: url.href, expiresAt: grant.expiresAt })
  })

  // ── Quota checks ahead of the pass-through below (each continues to it) ──
  const quotaGate = (change: (c: Context<Env>, vm: Vm | undefined) => Promise<QuotaChange | Response>): MiddlewareHandler<Env> => async (c, next) => {
    const vms = await allVms()
    if (!vms) return unreachable(c)
    const quota = await quotaFor(c.var.user.id, vms)
    const result = await change(c, quota.mine.find((vm) => vm.id === c.req.param('id')))
    if (result instanceof Response) return result
    const refused = quota.check(result)
    if (refused) return c.json({ error: refused }, 409)
    await next()
  }
  app.post('/vms/:id/start', quotaGate(async () => ({ start: true })))
  app.post('/vms/:id/resume', quotaGate(async () => ({ start: true })))
  app.post('/vms/:id/resize', quotaGate(async (c, vm) => {
    const input = ResizeVm.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: input.error.issues[0]?.message ?? 'invalid size' }, 400)
    const diskGib = input.data.diskGib ?? vm?.diskGib ?? 0
    return { size: input.data.size, diskGib, addDiskGib: Math.max(0, diskGib - (vm?.diskGib ?? diskGib)) }
  }))
  app.post('/vms/:id/disk', quotaGate(async (c, vm) => {
    const input = GrowDisk.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: input.error.issues[0]?.message ?? 'invalid disk size' }, 400)
    return { diskGib: input.data.diskGib, addDiskGib: Math.max(0, input.data.diskGib - (vm?.diskGib ?? input.data.diskGib)) }
  }))
  app.patch('/vms/:id', async (c, next) => {
    const input = UpdateVm.safeParse(await c.req.json().catch(() => null))
    if (input.success && input.data.egress?.mode === 'open' && o.quotas && (await o.quotas.of(c.var.user.id)).egress === 'allowlist') {
      return c.json({ error: "your plan's VMs have allowlisted egress" }, 403)
    }
    await next()
  })
  // The user's agent keys go into the VM before every session (see guestd's
  // /agent-env), so a new session always has the current ones.
  app.post('/vms/:id/sessions', async (c, next) => {
    if (o.agentEnv) {
      const env = await o.agentEnv(c.var.user.id).catch((err: Error) => (console.error(`agent keys: ${err.message}`), null))
      if (env) {
        const res = await callHostd(`/vms/${encodeURIComponent(c.req.param('id'))}/agent-env`, { method: 'PUT', body: JSON.stringify(env) })
        if (res && !res.ok) console.error(`agent keys for ${c.req.param('id')}: hostd said ${res.status}`)
      }
    }
    await next()
  })

  app.on(['GET', 'POST', 'PATCH', 'DELETE'], ['/vms/:id', '/vms/:id/*'], async (c) => {
    // Only management endpoints belong on the control origin. In particular,
    // never expose guest app HTML through this authenticated catch-all: Clerk
    // can authenticate navigation cookies as well as API bearer tokens.
    const suffix = hostdPath(c).replace(/^\/vms\/[^/]+/, '')
    const allowed: Record<string, RegExp> = {
      GET: /^(?:|\/(?:sessions|checkpoints|logs))$/,
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
    const id = c.req.param('id') ?? ''
    if (res.ok && c.req.method !== 'GET') {
      if (c.req.method === 'DELETE') {
        await owners.remove(id)
        await record(c.var.user.id, 'vm.deleted', id)
      } else if (suffix === '/sessions' && res.status === 201) {
        const session = Session.safeParse(await res.clone().json().catch(() => null))
        if (session.success) {
          await o.sessions?.record({ id: session.data.id, vmId: id, userId: c.var.user.id, agent: session.data.agent })
          await record(c.var.user.id, 'session.started', id, { agent: session.data.agent })
        }
      } else if (/^\/(start|stop|pause|resume|resize|disk)$/.test(suffix)) {
        await record(c.var.user.id, `vm.${suffix.slice(1)}`, id)
      }
    }
    return passThrough(res)
  })

  return app
}

