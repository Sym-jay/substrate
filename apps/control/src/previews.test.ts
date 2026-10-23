import { afterAll, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { createApp as createHostd } from '../../hostd/src/app.ts'
import type { VmService } from '../../hostd/src/vms.ts'
import { createApp } from './app.ts'
import { Capabilities } from './capabilities.ts'
import { Owners } from './owners.ts'
import { previewRoutes } from './previews.ts'
import { Tickets } from './tickets.ts'

const servers: ReturnType<typeof Bun.serve>[] = []
const serve = (app: Hono) => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket })
  servers.push(server)
  return server
}
const vmId = 'vm-preview'
const app = new Hono()
app.get('/*', async (c, next) => {
  if (c.req.header('upgrade')?.toLowerCase() === 'websocket') return upgradeWebSocket(() => ({
    onMessage: (event, peer) => peer.send(event.data as ArrayBuffer),
  }))(c, next)
  return c.json({ path: c.req.path, query: c.req.query('value'), authorization: c.req.header('authorization') ?? null,
    cookie: c.req.header('cookie') ?? null }, 200, { 'set-cookie': 'app=yes; Domain=example.com; Path=/; HttpOnly' })
})
const dev = serve(app)
let wakes = 0
let touches = 0
const unused = async (): Promise<never> => { throw new Error('unused') }
const vms: VmService = {
  list: unused, get: unused, create: unused, stop: unused, pause: unused, resume: unused, update: unused, growDisk: unused,
  resize: unused, fork: unused, checkpoints: unused, rollback: unused, createSession: unused,
  remove: unused, exec: unused, guest: unused, capacity: unused,
  start: async (id) => { wakes++; return { id, guestIp: '127.0.0.1' } as never },
  touch: () => { touches++ },
}
const host = serve(createHostd({ token: 'host-secret', version: 'test', image: async () => null, vms }))
const hostd = { url: `http://127.0.0.1:${host.port}`, token: 'host-secret' }
const owners = new Owners(':memory:')
owners.add(vmId, 'alice')
const tickets = new Tickets()
const capabilities = new Capabilities(':memory:')
const controlApp = createApp({ version: 'test', region: 'test', webDir: 'missing', clerkPublishableKey: null,
  readHost: async () => ({ configured: false }), previews: previewRoutes({ hostd, owners, tickets, capabilities }),
  vms: { hostd, owners, tickets, capabilities, previewOrigin: 'https://preview.example', maxVmsPerUser: 3,
    authenticate: async (req) => req.headers.get('x-test-user') ? { id: req.headers.get('x-test-user')! } : null },
})
const control = serve(controlApp)
const base = `http://127.0.0.1:${control.port}`
const previewHeaders = { 'x-substrate-preview': '1' }
const prefix = `/p/${vmId}/${dev.port}`

afterAll(() => { servers.forEach((server) => server.stop(true)); capabilities.close() })

async function openPreview() {
  const response = await fetch(`${base}/api/vms/${vmId}/previews`, { method: 'POST', headers: { 'x-test-user': 'alice' }, body: JSON.stringify({ port: dev.port }) })
  expect(response.status).toBe(200)
  const { url, basePath } = await response.json() as { url: string; basePath: string }
  expect(new URL(url).origin).toBe('https://preview.example')
  expect(basePath).toBe(prefix + '/')
  const bootstrap = await fetch(base + new URL(url).pathname + new URL(url).search, { headers: previewHeaders, redirect: 'manual' })
  expect(bootstrap.status).toBe(303)
  expect(bootstrap.headers.get('location')).toBe(prefix + '/')
  expect(bootstrap.headers.get('set-cookie')).toContain('HttpOnly')
  expect(bootstrap.headers.get('set-cookie')).toContain('Secure')
  return { cookie: bootstrap.headers.get('set-cookie')!.split(';')[0]!, url }
}

test('preview access is scoped, one-time bootstrap removes the ticket, and the app path is preserved', async () => {
  expect((await fetch(`${base}${prefix}/`, { headers: previewHeaders })).status).toBe(401)
  const { cookie, url } = await openPreview()
  expect((await fetch(base + new URL(url).pathname + new URL(url).search, { headers: previewHeaders })).status).toBe(401)
  const before = wakes
  const activityBefore = touches
  const result = await fetch(`${base}${prefix}/assets/main.js?value=42`, { headers: { ...previewHeaders, cookie: `${cookie}; app=ok` } })
  expect(await result.json()).toEqual({ path: prefix + '/assets/main.js', query: '42', authorization: null, cookie: 'app=ok' })
  expect(wakes).toBeGreaterThan(before)
  expect(touches).toBeGreaterThan(activityBefore)
  expect(result.headers.get('cache-control')).toBe('private, no-store')
  expect(result.headers.get('set-cookie')).toContain(`Path=${prefix}/`)
  expect(result.headers.get('set-cookie')).not.toContain('Domain=')
  expect((await fetch(`${base}/api/health`, { headers: { ...previewHeaders, cookie } })).status).toBe(404)
  owners.remove(vmId)
  expect((await fetch(`${base}${prefix}/`, { headers: { ...previewHeaders, cookie } })).status).toBe(401)
  owners.add(vmId, 'alice')
})

test('previews relay text and binary WebSocket frames through both proxies', async () => {
  const activityBefore = touches
  const { cookie } = await openPreview()
  const ws = new WebSocket(`${base.replace('http', 'ws')}${prefix}/hmr`, { protocols: ['vite-hmr'], headers: { ...previewHeaders, cookie } })
  ws.binaryType = 'arraybuffer'
  const messages: (string | ArrayBuffer)[] = []
  ws.onmessage = (event) => messages.push(event.data)
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('websocket failed')) })
  expect(ws.protocol).toBe('vite-hmr')
  ws.send('vite-update')
  const bytes = new Uint8Array([0, 255, 128, 10, 13, 42])
  ws.send(bytes)
  for (let i = 0; messages.length < 2; i++) { if (i > 100) throw new Error('relay timed out'); await Bun.sleep(10) }
  expect(messages[0]).toBe('vite-update')
  expect(new Uint8Array(messages[1] as ArrayBuffer)).toEqual(bytes)
  expect(touches).toBeGreaterThan(activityBefore)
  ws.close()
})

test('another account cannot issue preview or SSH access, and internal ports are rejected', async () => {
  for (const action of ['previews', 'ssh/access', 'fork', 'resize', 'ssh/keys']) {
    expect((await fetch(`${base}/api/vms/${vmId}/${action}`, { method: 'POST', headers: { 'x-test-user': 'bob' }, body: '{}' })).status).toBe(404)
  }
  for (const port of [22, 7000, 65536]) {
    expect((await fetch(`${base}/api/vms/${vmId}/previews`, { method: 'POST', headers: { 'x-test-user': 'alice' }, body: JSON.stringify({ port }) })).status).toBe(400)
  }
})

test('even an authenticated owner cannot serve guest app content on the control origin', async () => {
  const before = wakes
  const response = await fetch(`${base}/api/vms/${vmId}/preview/${dev.port}${prefix}/`, { headers: { 'x-test-user': 'alice' } })
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: 'not found' })
  expect(wakes).toBe(before)
})

test('capabilities expire and cannot be reused for a different VM, port or kind', () => {
  let now = 1000
  const caps = new Capabilities(':memory:', () => now)
  const grant = caps.issue({ userId: 'alice', vmId, port: 22, kind: 'ssh' }, 100)
  expect(caps.read(grant.token, 'ssh', vmId, 22)?.userId).toBe('alice')
  expect(caps.read(grant.token, 'preview', vmId, 22)).toBeNull()
  expect(caps.read(grant.token, 'ssh', 'vm-other', 22)).toBeNull()
  expect(caps.read(grant.token, 'ssh', vmId, 23)).toBeNull()
  now = 1100
  expect(caps.read(grant.token, 'ssh', vmId, 22)).toBeNull()
  caps.close()
})
