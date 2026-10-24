import type { Vm } from '@substrate/protocol'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { testDatabase } from './db.ts'
import { Owners } from './owners.ts'
import { fingerprint, SshAccess } from './ssh-access.ts'
import { Tickets } from './tickets.ts'

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOxzQ7Hk1lJpVv2Kq3Yc8mJmFv1u3pZ6Wn7m2b0rWb8s ann@laptop'

const ownersDb = await testDatabase()

describe('SSH access store', () => {
  test("fingerprints match ssh-keygen's", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-'))
    expect(Bun.spawnSync(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'k')]).exitCode).toBe(0)
    const publicKey = (await readFile(join(dir, 'k.pub'), 'utf8')).trim()
    const listed = Bun.spawnSync(['ssh-keygen', '-lf', join(dir, 'k.pub')]).stdout.toString().split(' ')[1]
    expect(fingerprint(publicKey)).toBe(listed!)
  })

  test("keys: named by their comment, no duplicates, and only their owner's to remove", async () => {
    const access = new SshAccess(await testDatabase())
    const key = (await access.addKey('ann', { publicKey: KEY }))
    expect(key.name).toBe('ann@laptop')
    await expect(access.addKey('ann', { publicKey: KEY })).rejects.toThrow('already on your account')
    expect((await access.addKey('bob', { publicKey: KEY, name: 'work' })).name).toBe('work')
    await expect(access.removeKey('bob', key.id)).rejects.toThrow('No such key')
    await access.removeKey('ann', key.id)
    expect((await access.keys('ann'))).toEqual([])
    expect((await access.keys('bob'))).toHaveLength(1)
  })

  test('tokens: shown once, kept hashed, and revocable', async () => {
    const access = new SshAccess(await testDatabase())
    const { token, id } = (await access.createToken('ann', 'laptop'))
    expect(token).toStartWith('sbs_')
    expect(JSON.stringify((await access.tokens('ann')))).not.toContain(token)
    expect((await access.userForToken(token))).toBe('ann')
    expect((await access.tokens('ann'))[0]!.lastUsedAt).toBeString()
    expect((await access.userForToken('sbs_nope'))).toBeNull()
    await expect(access.revokeToken('bob', id)).rejects.toThrow('No such token')
    await access.revokeToken('ann', id)
    expect((await access.userForToken(token))).toBeNull()
  })
})

describe('SSH and desktop routes, end to end', async () => {
  const vm = (id: string, name: string, state: Vm['state'] = 'running') =>
    ({ id, name, state, vcpus: 2, memMib: 4096, diskGib: 32, image: 'x', guestIp: '172.30.0.2', createdAt: '', startedAt: null, bootMs: null, lastError: null }) as Vm
  const vms = [vm('vm-aaaaaaaaaaaaaaaa', 'demo'), vm('vm-bbbbbbbbbbbbbbbb', 'bobs', 'stopped')]
  const synced: { id: string; body: { publicKeys: string[]; start?: boolean } }[] = []

  // Just enough of hostd: the VM list, key sync, and SSH and VNC that echo
  // what they get, upper-cased.
  const echo = () => upgradeWebSocket(() => ({
    onMessage(event, ws) { ws.send(new TextDecoder().decode(event.data as ArrayBuffer).toUpperCase()) },
  }))
  const fakeHostd = new Hono()
  fakeHostd.get('/vms', (c) => c.json(vms))
  fakeHostd.put('/vms/:id/ssh/keys', async (c) => {
    synced.push({ id: c.req.param('id'), body: await c.req.json() })
    return c.json({ ok: true })
  })
  fakeHostd.get('/vms/:id/gui', (c) => c.json({ state: 'ready', available: true }))
  fakeHostd.get('/vms/:id/ssh', echo())
  fakeHostd.get('/vms/:id/gui/vnc', echo())
  const hostd = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: fakeHostd.fetch, websocket })

  const owners = new Owners(ownersDb)
  beforeAll(async () => {
    await owners.add('vm-aaaaaaaaaaaaaaaa', 'ann')
    await owners.add('vm-bbbbbbbbbbbbbbbb', 'bob')
  })
  const access = new SshAccess(await testDatabase())
  const app = createApp({
    version: 'test', region: 'ap-south-1', webDir: 'nowhere', readHost: async () => ({ configured: false }), clerkPublishableKey: null,
    vms: {
      hostd: { url: `http://127.0.0.1:${hostd.port}`, token: 'secret' },
      authenticate: async (req) => (req.headers.get('x-test-user') ? { id: req.headers.get('x-test-user')! } : null),
      owners, tickets: new Tickets(), maxVmsPerUser: 3, sshAccess: access,
    },
  })
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
  afterAll(() => { server.stop(true); hostd.stop(true) })
  const base = `http://127.0.0.1:${server.port}`
  const as = (user: string) => (path: string, init: RequestInit = {}) =>
    fetch(`${base}/api${path}`, { ...init, headers: { 'x-test-user': user, 'content-type': 'application/json' } })

  // Connects like ssh-proxy.mjs: the token first, then SSH's bytes.
  const connect = (target: string, token: string) => new Promise<{ code: number; reason: string; echoed: string }>((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ssh/connect/${target}`)
    ws.binaryType = 'arraybuffer'
    let echoed = ''
    ws.onopen = () => {
      ws.send(JSON.stringify({ token }))
      ws.send(new TextEncoder().encode('ssh-2.0-test'))
    }
    ws.onmessage = (event) => {
      echoed += typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
      ws.close(1000)
    }
    ws.onclose = (event) => resolve({ code: event.code, reason: event.reason, echoed })
  })

  test('keys on your account reach your VM, and SSH flows by name', async () => {
    const ann = as('ann')
    expect((await ann('/ssh/keys', { method: 'POST', body: JSON.stringify({ publicKey: 'nope' }) })).status).toBe(400)
    expect((await ann('/ssh/keys', { method: 'POST', body: JSON.stringify({ publicKey: KEY }) })).status).toBe(201)
    expect(((await (await ann('/ssh/keys')).json()) as unknown[]).length).toBe(1)
    const { token } = (await (await ann('/ssh/tokens', { method: 'POST', body: JSON.stringify({ name: 'laptop' }) })).json()) as { token: string }

    synced.length = 0
    const result = await connect('demo.substrate', token)
    expect(result.echoed).toBe('SSH-2.0-TEST')
    expect(synced).toEqual([{ id: 'vm-aaaaaaaaaaaaaaaa', body: { publicKeys: [KEY], start: true } }])
  })

  test('ssh-proxy.mjs, as OpenSSH runs it, carries the bytes both ways', async () => {
    if (!Bun.which('node')) return
    const proxy = join(import.meta.dir, '../../web/public/ssh-proxy.mjs')
    const home = await mkdtemp(join(tmpdir(), 'home-'))
    const { token } = (await access.createToken('ann', 'proxy'))
    const env = { PATH: process.env.PATH!, HOME: home, SUBSTRATE_URL: base, SUBSTRATE_TOKEN: token }
    const ok = Bun.spawn(['node', proxy, 'demo.substrate'], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    ok.stdin.write('ssh-2.0-proxy')
    ok.stdin.flush()
    const reader = ok.stdout.getReader()
    let out = ''
    while (!out.includes('SSH-2.0-PROXY')) {
      const { value, done } = await reader.read()
      if (done) break
      out += new TextDecoder().decode(value)
    }
    ok.kill()
    expect(out).toBe('SSH-2.0-PROXY')

    const bad = Bun.spawn(['node', proxy, 'demo'], { env: { ...env, SUBSTRATE_TOKEN: 'sbs_wrong' }, stdin: 'pipe', stderr: 'pipe' })
    expect(await bad.exited).toBe(1)
    expect(await new Response(bad.stderr).text()).toContain('wrong or revoked')
  })

  test("a wrong token, someone else's VM, or no keys are turned away", async () => {
    expect((await connect('demo', 'sbs_wrong')).code).toBe(4401)
    const { token: annToken } = (await access.createToken('ann', 'x'))
    expect((await connect('bobs', annToken)).code).toBe(4404)
    const { token: bobToken, id } = (await access.createToken('bob', 'x'))
    expect((await connect('bobs', bobToken)).code).toBe(4409)
    await access.revokeToken('bob', id)
    expect((await connect('bobs', bobToken)).code).toBe(4401)
  })

  test('keys and tokens need sign-in, and belong to their user', async () => {
    expect((await fetch(`${base}/api/ssh/keys`)).status).toBe(401)
    expect(await (await as('carol')('/ssh/keys')).json()).toEqual([])
    const [key] = (await (await as('ann')('/ssh/keys')).json()) as { id: string }[]
    expect((await as('carol')(`/ssh/keys/${key!.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  test("the desktop: its state passes through, and VNC needs a one-time ticket", async () => {
    const ann = as('ann')
    expect(await (await ann('/vms/vm-aaaaaaaaaaaaaaaa/gui')).json()).toEqual({ state: 'ready', available: true })
    expect((await as('bob')('/vms/vm-aaaaaaaaaaaaaaaa/gui')).status).toBe(404)
    const { ticket } = (await (await ann('/vms/vm-aaaaaaaaaaaaaaaa/gui/ticket', { method: 'POST' })).json()) as { ticket: string }
    const url = `${base.replace('http', 'ws')}/api/vms/vm-aaaaaaaaaaaaaaaa/gui/vnc?ticket=${ticket}`
    const echoed = await new Promise<string>((resolve) => {
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => ws.send(new TextEncoder().encode('rfb 003.008'))
      ws.onmessage = (event) => { resolve(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)); ws.close() }
    })
    expect(echoed).toBe('RFB 003.008')
    const reused = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url)
      ws.onopen = () => resolve(false)
      ws.onerror = () => resolve(true)
      ws.onclose = () => resolve(true)
    })
    expect(reused).toBe(true)
  })
})
