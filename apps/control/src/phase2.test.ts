import type { Quota, Vm } from '@substrate/protocol'
import { SQL } from 'bun'
import { afterAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountRoutes } from './account.ts'
import { createApp } from './app.ts'
import { importSqlite, migrate, sqliteDatabase, testDatabase, type Db } from './db.ts'
import { GitHub } from './github.ts'
import { Jobs } from './jobs.ts'
import { Metering } from './metering.ts'
import { Owners } from './owners.ts'
import { quotaError, Quotas } from './quotas.ts'
import { UserSecrets, type Cipher } from './secrets.ts'
import { Tickets } from './tickets.ts'
import { monthOf, Usage } from './usage.ts'
import { Events, sessionsTable, Users } from './users.ts'

const cleanups: (() => unknown)[] = []
afterAll(async () => { for (const cleanup of cleanups) await cleanup() })

const DEFAULTS: Quota = { maxVms: 2, sizes: ['small', 'medium'], maxDiskGib: 64, maxTotalDiskGib: 100, maxRunningHours: 10, egress: 'open' }

// Stands in for KMS: a ciphertext only opens with the context it was sealed with.
const fakeCipher: Cipher = {
  async encrypt(plaintext, context) { return Buffer.from(JSON.stringify({ plaintext, context })).toString('base64') },
  async decrypt(ciphertext, context) {
    const sealed = JSON.parse(Buffer.from(ciphertext, 'base64').toString())
    if (JSON.stringify(sealed.context) !== JSON.stringify(context)) throw new Error('InvalidCiphertextException')
    return sealed.plaintext
  },
}

describe('quota rules', () => {
  const used = { vms: 1, totalDiskGib: 60, runningHours: 3 }
  test('each limit, with a reason', () => {
    expect(quotaError(DEFAULTS, used, { newVm: true })).toBeNull()
    expect(quotaError(DEFAULTS, { ...used, vms: 2 }, { newVm: true })).toContain('the most your plan allows')
    expect(quotaError(DEFAULTS, used, { size: 'large' })).toContain("the large size isn't in your plan")
    expect(quotaError(DEFAULTS, used, { diskGib: 65 })).toContain('at most 64 GiB')
    expect(quotaError(DEFAULTS, used, { addDiskGib: 41 })).toContain('over your plan')
    expect(quotaError(DEFAULTS, used, { addDiskGib: 40 })).toBeNull()
    expect(quotaError(DEFAULTS, { ...used, runningHours: 10 }, { start: true })).toContain('running hours')
  })
})

describe('stores', () => {
  test('usage adds up per VM and month, and reports hours', async () => {
    const usage = new Usage(await testDatabase())
    await usage.add({ userId: 'ann', vmId: 'vm-a', month: '2026-10', seconds: 1800, vcpus: 4, memMib: 8192 })
    await usage.add({ userId: 'ann', vmId: 'vm-a', month: '2026-10', seconds: 1800, vcpus: 4, memMib: 8192 })
    await usage.add({ userId: 'ann', vmId: 'vm-b', month: '2026-10', seconds: 3600, vcpus: 2, memMib: 4096 })
    await usage.add({ userId: 'ann', vmId: 'vm-a', month: '2026-09', seconds: 99_999, vcpus: 4, memMib: 8192 })
    expect(await usage.runningHours('ann', '2026-10')).toBe(2)
    expect(await usage.report('ann', '2026-10')).toEqual({
      month: '2026-10',
      vms: [{ vmId: 'vm-a', runningHours: 1, vcpuHours: 4, gibHours: 8 }, { vmId: 'vm-b', runningHours: 1, vcpuHours: 2, gibHours: 4 }],
      totals: { runningHours: 2, vcpuHours: 6, gibHours: 12 },
    })
    expect(await usage.runningHours('bob', '2026-10')).toBe(0)
  })

  test("quotas: the defaults, someone's own, and admins unlimited unless set", async () => {
    const quotas = new Quotas(await testDatabase(), DEFAULTS, ['root-user'])
    expect(await quotas.of('ann')).toEqual(DEFAULTS)
    await quotas.set('ann', { maxVms: 5 })
    expect(await quotas.of('ann')).toEqual({ ...DEFAULTS, maxVms: 5 })
    expect((await quotas.of('root-user')).maxRunningHours).toBeGreaterThan(10_000)
    await quotas.set('root-user', { maxRunningHours: 1 })
    expect((await quotas.of('root-user')).maxRunningHours).toBe(1)
    await quotas.reset('ann')
    expect(await quotas.of('ann')).toEqual(DEFAULTS)
  })

  test("secrets are sealed to their user and name: one user's row can't be read as another's", async () => {
    const db = await testDatabase()
    const secrets = new UserSecrets(db, fakeCipher)
    await secrets.set('ann', 'anthropic', 'sk-ant-secret-1234', '1234')
    expect(await secrets.get('ann', 'anthropic')).toBe('sk-ant-secret-1234')
    expect(await secrets.list('ann')).toMatchObject([{ name: 'anthropic', hint: '1234' }])
    const [row] = await db`select ciphertext from user_secrets where user_id = 'ann'`
    expect(row.ciphertext).not.toContain('sk-ant')
    // Copy Ann's ciphertext into Bob's row: it won't decrypt for Bob.
    await db`insert into user_secrets (user_id, name, ciphertext, hint, updated_at) values ('bob', 'anthropic', ${row.ciphertext}, 'x', 'now')`
    expect(secrets.get('bob', 'anthropic')).rejects.toThrow('InvalidCiphertextException')
  })

  test('events and jobs, newest first, per user', async () => {
    const db = await testDatabase()
    const events = new Events(db)
    await events.record('ann', 'vm.created', 'vm-a', { size: 'small' })
    await Bun.sleep(2)
    await events.record('ann', 'vm.deleted', 'vm-a')
    await events.record('bob', 'vm.created', 'vm-b')
    expect((await events.list('ann')).map((e) => e.kind)).toEqual(['vm.deleted', 'vm.created'])
    expect((await events.list('ann'))[1]!.detail).toEqual({ size: 'small' })
    const jobs = new Jobs(db)
    await jobs.launch('ann', 'vm-a', async () => {})
    await jobs.launch('ann', 'vm-b', () => new Promise(() => {}), 'fork')
    await Bun.sleep(10)
    expect((await jobs.list('ann')).map((j) => j.state).sort()).toEqual(['done', 'running'])
    expect(await jobs.pending('ann')).toEqual(['vm-b'])
    await jobs.start()
    expect(await jobs.pending('ann')).toEqual([])
  })

  test("a deleted VM stops being its owner's, but stays on record", async () => {
    const db = await testDatabase()
    const owners = new Owners(db)
    await owners.add('vm-a', 'ann')
    await owners.remove('vm-a')
    expect(await owners.owner('vm-a')).toBeNull()
    expect(await owners.vmsOf('ann')).toEqual([])
    expect((await db`select id from vms`).length).toBe(1)
  })

  test("the first start on Postgres brings over the old SQLite file's owners and jobs, once", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'substrate-import-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const file = join(dir, 'control.db')
    const old = new SQL({ adapter: 'sqlite', filename: file })
    await old.unsafe('create table vm_owners (vm_id text primary key, user_id text not null, created_at text not null)')
    await old.unsafe('create table vm_jobs (id text primary key, userId text, vmId text, state text, error text)')
    await old`insert into vm_owners values ('vm-a', 'ann', '2026-10-01T00:00:00Z')`
    await old`insert into vm_jobs values ('job-1', 'ann', 'vm-a', 'done', null)`
    await old.close()
    const db = await testDatabase()
    expect(await importSqlite(db, file)).toBe(1)
    expect(await new Owners(db).owner('vm-a')).toBe('ann')
    expect((await new Jobs(db).read('job-1', 'ann'))?.state).toBe('done')
    expect(await importSqlite(db, file)).toBe(0)
    expect(await importSqlite(db, join(dir, 'missing.db'))).toBe(0)
  })

  test('migrations run once, and again harmlessly', async () => {
    const db = sqliteDatabase(':memory:')
    await migrate(db)
    await migrate(db)
    expect((await db`select version from schema_migrations`).length).toBe(2)
  })
})

describe('GitHub', () => {
  function rig(db: Db) {
    const calls: { url: string; auth: string | null; body?: string }[] = []
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const auth = new Headers(init?.headers).get('authorization')
      calls.push({ url, auth, body: init?.body as string | undefined })
      if (url.endsWith('/login/oauth/access_token')) return Response.json(JSON.parse(String(init?.body)).code === 'good' ? { access_token: 'gho_fromoauth' } : { error_description: 'bad code' })
      if (url.endsWith('/user')) return auth === 'Bearer bad' ? new Response('no', { status: 401 }) : Response.json({ login: 'octo-ann' })
      if (url.includes('/user/repos')) return Response.json([
        { full_name: 'octo-ann/app', private: true, description: 'the app', default_branch: 'main', pushed_at: '2026-10-20T00:00:00Z' },
        { full_name: 'octo-ann/site', private: false, description: null, default_branch: 'main', pushed_at: null },
      ])
      return new Response('?', { status: 404 })
    }) as typeof fetch
    let now = 1_000_000
    const github = new GitHub({
      db, secrets: new UserSecrets(db, fakeCipher), fetch: fakeFetch, now: () => now,
      oauth: { clientId: 'client-1', clientSecret: 'shh', redirectUri: 'https://substrate.example/api/github/callback' },
      legacy: async (userId) => (userId === 'old-user' ? 'ghp_legacy' : undefined),
    })
    return { github, calls, advance: (ms: number) => (now += ms) }
  }

  test('a pasted token is checked with GitHub, then stored for that user only', async () => {
    const { github } = rig(await testDatabase())
    expect(github.connectWithToken('ann', 'bad')).rejects.toThrow("didn't accept")
    expect(await github.connectWithToken('ann', 'ghp_goodtokenvalue123')).toBe('octo-ann')
    expect(await github.status('ann')).toEqual({ connected: true, login: 'octo-ann', oauth: true })
    expect(await github.token('ann')).toBe('ghp_goodtokenvalue123')
    expect(await github.token('bob')).toBeUndefined()
    expect(await github.token('old-user')).toBe('ghp_legacy')
    await github.disconnect('ann')
    expect((await github.status('ann')).connected).toBe(false)
  })

  test('OAuth: the state ties GitHub\'s answer to the user, once, for ten minutes', async () => {
    const { github, advance } = rig(await testDatabase())
    const url = new URL(await github.authorizeUrl('ann'))
    expect(url.searchParams.get('client_id')).toBe('client-1')
    expect(url.searchParams.get('scope')).toBe('repo read:user')
    const state = url.searchParams.get('state')!
    expect(github.finish(state, 'bad')).rejects.toThrow('bad code')
    // The failed attempt used the state up.
    expect(github.finish(state, 'good')).rejects.toThrow('expired')
    const again = new URL(await github.authorizeUrl('ann')).searchParams.get('state')!
    expect(await github.finish(again, 'good')).toBe('ann')
    expect(await github.token('ann')).toBe('gho_fromoauth')
    const late = new URL(await github.authorizeUrl('bob')).searchParams.get('state')!
    advance(11 * 60_000)
    expect(github.finish(late, 'good')).rejects.toThrow('expired')
  })

  test("a user's repositories, filtered", async () => {
    const { github, calls } = rig(await testDatabase())
    expect(github.repos('ann')).rejects.toThrow('connect GitHub first')
    await github.connectWithToken('ann', 'ghp_goodtokenvalue123')
    expect((await github.repos('ann', 'APP')).map((r) => r.fullName)).toEqual(['octo-ann/app'])
    expect(calls.at(-1)!.auth).toBe('Bearer ghp_goodtokenvalue123')
  })
})

describe('metering', () => {
  test("adds running time to its owner's usage, and pauses a user's VMs past their hours", async () => {
    const db = await testDatabase()
    const owners = new Owners(db)
    await owners.add('vm-a', 'ann')
    await owners.add('vm-b', 'bob')
    const usage = new Usage(db)
    const quotas = new Quotas(db, { ...DEFAULTS, maxRunningHours: 1 })
    const events = new Events(db)
    let now = Date.parse('2026-10-24T00:00:00Z')
    const vm = (id: string, state: Vm['state']) => ({ id, state, vcpus: 2, memMib: 4096 }) as Vm
    const paused: string[] = []
    const metering = new Metering({
      allVms: async () => [vm('vm-a', 'running'), vm('vm-b', 'stopped'), vm('vm-unowned', 'running')],
      owners, usage, quotas, events, pause: async (id) => { paused.push(id) }, now: () => now,
    })
    await metering.tick()
    now += 60_000
    await metering.tick()
    expect(await usage.runningHours('ann', monthOf(now))).toBeCloseTo(1 / 60)
    expect(await usage.runningHours('bob', monthOf(now))).toBe(0)
    // A long gap (the control box was down) counts as two minutes at most.
    now += 3_600_000
    await metering.tick()
    expect(await usage.runningHours('ann', monthOf(now))).toBeCloseTo(3 / 60)
    expect(paused).toEqual([])
    await usage.add({ userId: 'ann', vmId: 'vm-a', month: monthOf(now), seconds: 3600, vcpus: 2, memMib: 4096 })
    now += 60_000
    await metering.tick()
    expect(paused).toEqual(['vm-a'])
    expect((await events.list('ann'))[0]).toMatchObject({ kind: 'quota.paused', vmId: 'vm-a' })
  })
})

describe('routes', () => {
  async function serve({ quota = DEFAULTS, admins = [] as string[] } = {}) {
    const db = await testDatabase()
    const seen: { method: string; path: string; body: unknown }[] = []
    const vms = new Map<string, Vm>()
    const fakeHostd = new Hono()
    fakeHostd.all('*', async (c) => {
      const body = c.req.method === 'GET' ? null : await c.req.json().catch(() => null)
      seen.push({ method: c.req.method, path: c.req.path, body })
      if (c.req.path === '/vms' && c.req.method === 'GET') return c.json([...vms.values()])
      if (c.req.path === '/vms' && c.req.method === 'POST') {
        const input = body as { targetId: string; size?: string; diskGib?: number }
        const vm = { id: input.targetId, name: input.targetId, state: 'running', vcpus: 2, memMib: 4096, diskGib: input.diskGib ?? 32 } as Vm
        vms.set(vm.id, vm)
        return c.json(vm, 201)
      }
      if (/\/sessions$/.test(c.req.path) && c.req.method === 'POST') return c.json({ id: 'sess-1', agent: 'claude', createdAt: 'now', state: 'running', exitCode: null }, 201)
      if (/\/agent-env$/.test(c.req.path)) return c.body(null, 204)
      return c.json({ ok: true })
    })
    const hostdServer = Bun.serve({ port: 0, fetch: fakeHostd.fetch })
    cleanups.push(() => hostdServer.stop(true))
    const hostd = { url: `http://127.0.0.1:${hostdServer.port}`, token: 'hostd-token' }
    const owners = new Owners(db)
    const users = new Users(db)
    const events = new Events(db)
    const usage = new Usage(db)
    const quotas = new Quotas(db, quota, admins)
    const secrets = new UserSecrets(db, fakeCipher)
    const authenticate = async (req: Request) => (req.headers.get('x-user') ? { id: req.headers.get('x-user')! } : null)
    const keysChangedFor: string[] = []
    const app = createApp({
      version: 'test', region: 'test', webDir: 'missing', clerkPublishableKey: null, readHost: async () => ({ configured: false }),
      account: accountRoutes({
        authenticate, users, events, usage, quotas, owners, secrets, github: null, admins,
        vmsOf: async () => [...vms.values()], keysChanged: async (userId) => { keysChangedFor.push(userId) },
      }),
      vms: {
        hostd, authenticate, owners, tickets: new Tickets(), jobs: new Jobs(db), maxVmsPerUser: 99, quotas, usage, events, users,
        sessions: sessionsTable(db),
        agentEnv: async (userId) => ({ ANTHROPIC_API_KEY: (await secrets.get(userId, 'anthropic')) ?? undefined }),
      },
    })
    const as = (user: string) => (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, { ...init, headers: { 'x-user': user, 'content-type': 'application/json', ...init.headers } })
    const waitForVm = async (id: string) => { for (let i = 0; i < 100 && !vms.has(id); i++) await Bun.sleep(5) }
    return { db, seen, vms, as, usage, quotas, keysChangedFor, waitForVm }
  }

  test("creating VMs keeps to the user's quota", async () => {
    const { as, waitForVm } = await serve()
    const ann = as('ann')
    const create = (body: object) => ann('/vms', { method: 'POST', body: JSON.stringify(body) })
    expect((await (await create({ size: 'large' })).json() as { error: string }).error).toContain("large size isn't in your plan")
    expect((await create({ size: 'small', diskGib: 128 })).status).toBe(409)
    const first = await (await create({ size: 'small', diskGib: 60 })).json() as { vmId: string }
    await waitForVm(first.vmId)
    expect(((await (await create({ size: 'small', diskGib: 60 })).json()) as { error: string }).error).toContain('over your plan')
    const second = await (await create({ size: 'small', diskGib: 32 })).json() as { vmId: string }
    await waitForVm(second.vmId)
    expect(((await (await create({ size: 'small' })).json()) as { error: string }).error).toContain('the most your plan allows')
  })

  test('a plan with allowlisted egress makes every new VM allowlisted, for good', async () => {
    const { as, seen, vms, waitForVm } = await serve({ quota: { ...DEFAULTS, egress: 'allowlist' } })
    const ann = as('ann')
    const job = await (await ann('/vms', { method: 'POST', body: JSON.stringify({ size: 'small', egress: { mode: 'open', allow: ['example.com'] } }) })).json() as { vmId: string }
    await waitForVm(job.vmId)
    expect((seen.find((r) => r.method === 'POST' && r.path === '/vms')!.body as { egress: unknown }).egress).toEqual({ mode: 'allowlist', allow: ['example.com'] })
    expect((await ann(`/vms/${job.vmId}`, { method: 'PATCH', body: JSON.stringify({ egress: { mode: 'open', allow: [] } }) })).status).toBe(403)
    expect(vms.has(job.vmId)).toBe(true)
  })

  test("starting a VM is refused once the month's hours are used", async () => {
    const { as, usage, waitForVm } = await serve()
    const ann = as('ann')
    const job = await (await ann('/vms', { method: 'POST', body: JSON.stringify({ size: 'small' }) })).json() as { vmId: string }
    await waitForVm(job.vmId)
    expect((await ann(`/vms/${job.vmId}/start`, { method: 'POST', body: '{}' })).status).toBe(200)
    await usage.add({ userId: 'ann', vmId: job.vmId, month: monthOf(Date.now()), seconds: 10 * 3600, vcpus: 2, memMib: 4096 })
    expect((await ann(`/vms/${job.vmId}/resume`, { method: 'POST', body: '{}' })).status).toBe(409)
  })

  test('agent keys: set and shown as a hint, sent into the VM before a session, never to the browser', async () => {
    const { as, seen, keysChangedFor, db, waitForVm } = await serve()
    const ann = as('ann')
    expect((await ann('/keys/anthropic', { method: 'PUT', body: JSON.stringify({ value: 'bad key!' }) })).status).toBe(400)
    expect((await ann('/keys/github', { method: 'PUT', body: JSON.stringify({ value: 'sk-whatever-1234' }) })).status).toBe(404)
    expect((await ann('/keys/anthropic', { method: 'PUT', body: JSON.stringify({ value: 'sk-ant-api03-secret-9876' }) })).status).toBe(204)
    expect(keysChangedFor).toEqual(['ann'])
    const listed = await (await ann('/keys')).text()
    expect(listed).toContain('"hint":"9876"')
    expect(listed).not.toContain('secret')
    const job = await (await ann('/vms', { method: 'POST', body: JSON.stringify({ size: 'small' }) })).json() as { vmId: string }
    await waitForVm(job.vmId)
    // A browser can't set the environment itself: only the stored key is sent.
    const session = await ann(`/vms/${job.vmId}/sessions`, { method: 'POST', body: JSON.stringify({ agent: 'claude', env: { LD_PRELOAD: 'x' } }) })
    expect(session.status).toBe(201)
    const pushed = seen.find((r) => r.path === `/vms/${job.vmId}/agent-env`)!
    expect(pushed).toMatchObject({ method: 'PUT', body: { ANTHROPIC_API_KEY: 'sk-ant-api03-secret-9876' } })
    expect((seen.findLast((r) => r.path === `/vms/${job.vmId}/sessions`)!.body as { env?: unknown }).env).toEqual({ LD_PRELOAD: 'x' })
    expect((await db`select agent from sessions where vm_id = ${job.vmId}`)[0].agent).toBe('claude')
    expect(((await (await ann('/events')).json()) as { kind: string }[]).map((e) => e.kind)).toContain('session.started')
    expect((await ann('/keys/anthropic', { method: 'DELETE' })).status).toBe(204)
    expect(await (await ann('/keys')).json()).toEqual([])
  })

  test('quota status, and only admins change quotas', async () => {
    const { as } = await serve({ admins: ['root-user'] })
    const status = await (await as('ann')('/quota')).json()
    expect(status).toMatchObject({ limits: DEFAULTS, used: { vms: 0, runningHours: 0 } })
    expect((await as('ann')('/admin/quotas/bob', { method: 'PUT', body: JSON.stringify({ maxVms: 9 }) })).status).toBe(404)
    expect(await (await as('root-user')('/admin/quotas/bob', { method: 'PUT', body: JSON.stringify({ maxVms: 9 }) })).json()).toMatchObject({ maxVms: 9 })
    expect((await as('root-user')('/admin/quotas/bob', { method: 'PUT', body: JSON.stringify({ maxVms: -1 }) })).status).toBe(400)
  })
})
