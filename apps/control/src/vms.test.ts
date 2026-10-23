// Who sees what: two signed-in users against a fake hostd.
import type { Vm } from '@substrate/protocol'
import { afterAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createApp } from './app.ts'
import { Owners } from './owners.ts'
import { Tickets } from './tickets.ts'

const hostdToken = 'h'.repeat(64)
const hostdVms = new Map<string, Vm>()
let created = 0

// Just enough of hostd: list, create, get, update, delete.
const fakeHostd = new Hono()
fakeHostd.use('*', async (c, next) => {
  if (c.req.header('Authorization') !== `Bearer ${hostdToken}`) return c.json({ error: 'unauthorized' }, 401)
  await next()
})
fakeHostd.get('/vms', (c) => c.json([...hostdVms.values()]))
fakeHostd.post('/vms', async (c) => {
  const { name } = (await c.req.json()) as { name?: string }
  const id = `vm-${String(++created).padStart(8, '0')}`
  const vm: Vm = {
    id,
    name: name ?? id,
    vcpus: 2,
    memMib: 4096,
    diskGib: 32,
    state: 'running',
    image: 'test',
    guestIp: '172.30.0.2',
    createdAt: new Date().toISOString(),
    startedAt: null,
    bootMs: 1000,
    lastError: null,
  }
  hostdVms.set(id, vm)
  return c.json(vm, 201)
})
fakeHostd.get('/vms/:id', (c) => c.json(hostdVms.get(c.req.param('id'))))
fakeHostd.patch('/vms/:id', async (c) => {
  const vm = { ...hostdVms.get(c.req.param('id'))!, ...((await c.req.json()) as Partial<Vm>) }
  hostdVms.set(vm.id, vm)
  return c.json(vm)
})
fakeHostd.delete('/vms/:id', (c) => {
  hostdVms.delete(c.req.param('id'))
  return c.body(null, 204)
})
const hostd = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: fakeHostd.fetch })
afterAll(() => hostd.stop(true))

const app = createApp({
  version: 'test',
  region: 'ap-south-1',
  webDir: 'does-not-exist',
  readHost: async () => ({ configured: false }),
  clerkPublishableKey: 'pk_test_abc',
  vms: {
    hostd: { url: `http://127.0.0.1:${hostd.port}`, token: hostdToken },
    // Stands in for Clerk: the caller says who they are.
    authenticate: async (req) => (req.headers.get('x-test-user') ? { id: req.headers.get('x-test-user')! } : null),
    owners: new Owners(':memory:'),
    tickets: new Tickets(),
    maxVmsPerUser: 2,
  },
})

const as = (user: string | null) => (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { ...(user ? { 'x-test-user': user } : {}), ...init.headers } })
const alice = as('alice')
const bob = as('bob')
const anonymous = as(null)
const create = (call: typeof alice, name: string) => call('/api/vms', { method: 'POST', body: JSON.stringify({ name }) })

describe('VMs per user', () => {
  let aliceVm: Vm

  test('every VM route needs a signed-in user', async () => {
    expect((await anonymous('/api/vms')).status).toBe(401)
    expect((await create(anonymous, 'x')).status).toBe(401)
    expect((await anonymous('/api/vms/vm-00000001')).status).toBe(401)
    expect((await anonymous('/api/vms/vm-00000001/sessions/s/terminal/ticket', { method: 'POST' })).status).toBe(401)
  })

  test('a new VM belongs to whoever created it', async () => {
    const res = await create(alice, 'alices')
    expect(res.status).toBe(201)
    aliceVm = (await res.json()) as Vm
    expect(((await (await alice('/api/vms')).json()) as Vm[]).map((v) => v.id)).toEqual([aliceVm.id])
    expect(await (await bob('/api/vms')).json()).toEqual([])
  })

  test("someone else's VM looks like it doesn't exist", async () => {
    for (const [path, method] of [
      [`/api/vms/${aliceVm.id}`, 'GET'],
      [`/api/vms/${aliceVm.id}/sessions`, 'GET'],
      [`/api/vms/${aliceVm.id}/stop`, 'POST'],
      [`/api/vms/${aliceVm.id}`, 'PATCH'],
      [`/api/vms/${aliceVm.id}`, 'DELETE'],
      [`/api/vms/${aliceVm.id}/sessions/s/terminal/ticket`, 'POST'],
    ] as const) {
      const res = await bob(path, { method })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: `no VM ${aliceVm.id}` })
    }
    expect(hostdVms.has(aliceVm.id)).toBe(true)
    expect((await alice(`/api/vms/${aliceVm.id}`)).status).toBe(200)
  })

  test('the owner can change when their VM auto-pauses', async () => {
    const res = await alice(`/api/vms/${aliceVm.id}`, { method: 'PATCH', body: JSON.stringify({ autoPauseMinutes: 30 }) })
    expect(res.status).toBe(200)
    expect(hostdVms.get(aliceVm.id)?.autoPauseMinutes).toBe(30)
  })

  test('each user has a VM limit', async () => {
    expect((await create(alice, 'second')).status).toBe(201)
    const third = await create(alice, 'third')
    expect(third.status).toBe(409)
    expect(((await third.json()) as { error: string }).error).toContain('Delete one first')
    // Bob's limit is his own.
    expect((await create(bob, 'bobs')).status).toBe(201)
  })

  test('deleting a VM frees its place', async () => {
    expect((await alice(`/api/vms/${aliceVm.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(hostdVms.has(aliceVm.id)).toBe(false)
    expect((await alice(`/api/vms/${aliceVm.id}`)).status).toBe(404)
    expect((await create(alice, 'third-after-all')).status).toBe(201)
  })
})

describe('terminal tickets', () => {
  const tickets = new Tickets()

  test('open one terminal, once', () => {
    const ticket = tickets.issue({ userId: 'alice', vmId: 'vm-1', sessionId: 's1' })
    expect(tickets.redeem(ticket, 'vm-1', 's2')).toBeNull()
    const again = tickets.issue({ userId: 'alice', vmId: 'vm-1', sessionId: 's1' })
    expect(tickets.redeem(again, 'vm-1', 's1')).toBe('alice')
    expect(tickets.redeem(again, 'vm-1', 's1')).toBeNull()
    expect(tickets.redeem('made-up', 'vm-1', 's1')).toBeNull()
  })

  test('a terminal without a ticket is refused', async () => {
    const res = await alice('/api/vms/vm-00000001/sessions/s/terminal')
    expect(res.status).toBe(401)
  })
})
