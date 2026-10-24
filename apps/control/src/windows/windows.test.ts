import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { testDatabase } from '../db.ts'
import { Tickets } from '../tickets.ts'
import type { InstanceInfo, WindowsCloud } from './cloud.ts'
import { windowsRoutes } from './routes.ts'
import { WindowsStore } from './store.ts'
import { WindowsTerminals } from './terminals.ts'
import { windowsUserData } from './user-data.ts'
import { makePassword, WindowsError, WindowsWorkspaces } from './workspaces.ts'

const MINUTE = 60_000

function fakeCloud() {
  const instances = new Map<string, InstanceInfo>()
  const calls: string[] = []
  const userData: string[] = []
  let next = 0
  const cloud: WindowsCloud & { instances: typeof instances; calls: string[]; userData: string[]; busy: number | null } = {
    instances, calls, userData, busy: null,
    async launch(input) {
      const id = `i-${++next}`
      calls.push(`launch ${input.name} as ${input.instanceType}`)
      userData.push(input.userData)
      instances.set(id, { state: 'pending', privateIp: `10.40.0.${100 + next}` })
      return id
    },
    async describe(ids) {
      return new Map(ids.filter((id) => instances.has(id)).map((id) => [id, { ...instances.get(id)! }]))
    },
    async start(id) {
      calls.push(`start ${id}`)
      instances.get(id)!.state = 'pending'
    },
    async stop(id) {
      calls.push(`stop ${id}`)
      instances.get(id)!.state = 'stopping'
    },
    async terminate(id) {
      calls.push(`terminate ${id}`)
      instances.get(id)!.state = 'shutting-down'
    },
    async cpu() {
      return cloud.busy
    },
  }
  return cloud
}

async function setup({ maxRunning = 1, maxPerUser = 2, ready = true, vncPort = 5900 } = {}) {
  let now = Date.parse('2026-10-24T00:00:00Z')
  const store = new WindowsStore(await testDatabase())
  const cloud = fakeCloud()
  const ssh = {
    isReady: ready,
    async publicKey() { return 'ssh-ed25519 AAAAkey substrate-control' },
    async ready() { return ssh.isReady },
    async forget() {},
    argv: (_id: string, ip: string) => ['ssh', `Administrator@${ip}`],
  }
  const workspaces = new WindowsWorkspaces({
    store, cloud, ssh, terminals: new WindowsTerminals(),
    instanceType: 'm8i.4xlarge', maxRunning, maxPerUser, idleStopMinutes: 30,
    // A local shell stands in for ssh into Windows.
    shell: () => ['/bin/sh'],
    vncPort,
    now: () => now,
    log: () => {},
  })
  return { store, cloud, ssh, workspaces, advance: (ms: number) => (now += ms) }
}

// Creates a workspace and brings it to running.
async function running(s: Awaited<ReturnType<typeof setup>>, owner = 'ann', name = 'one') {
  const w = await s.workspaces.create(owner, { name })
  s.cloud.instances.get((await s.store.get(w.id))!.instanceId!)!.state = 'running'
  await s.workspaces.tick()
  return (await s.store.get(w.id))!
}

describe('Windows workspaces', () => {
  test('creating one starts an instance whose first boot has its own passwords and our key', async () => {
    const s = (await setup())
    const w = await s.workspaces.create('ann', { name: 'one' })
    expect(w).toMatchObject({ name: 'one', state: 'creating', instanceType: 'm8i.4xlarge', idleStopMinutes: 30 })
    const row = (await s.store.get(w.id))!
    expect(row.instanceId).toBe('i-1')
    expect(s.cloud.userData[0]).toContain(row.password)
    expect(s.cloud.userData[0]).toContain(`VALUE_OF_PASSWORD=${row.vncPassword}`)
    expect(s.cloud.userData[0]).toContain('ssh-ed25519 AAAAkey substrate-control')
    // Its passwords never go out with the workspace.
    expect(JSON.stringify(w)).not.toContain(row.password)
  })

  test('each size is a size of the configured family; large by default', async () => {
    const s = (await setup({ maxRunning: 3 }))
    expect(await s.workspaces.create('ann', { name: 'big' })).toMatchObject({ instanceType: 'm8i.4xlarge', size: 'large' })
    expect(await s.workspaces.create('bob', { name: 'small', size: 'small' })).toMatchObject({ instanceType: 'm8i.xlarge', size: 'small' })
    expect(await s.workspaces.create('cat', { name: 'mid', size: 'medium' })).toMatchObject({ instanceType: 'm8i.2xlarge', size: 'medium' })
    expect(s.cloud.calls.filter((c) => c.startsWith('launch'))).toEqual(['launch big as m8i.4xlarge', 'launch small as m8i.xlarge', 'launch mid as m8i.2xlarge'])
  })

  test("it's running once its first boot says it's ready", async () => {
    const s = (await setup({ ready: false }))
    const w = await s.workspaces.create('ann', { name: 'one' })
    s.cloud.instances.get('i-1')!.state = 'running'
    await s.workspaces.tick()
    expect((await s.store.get(w.id))!.state).toBe('creating')
    s.ssh.isReady = true
    await s.workspaces.tick()
    expect((await s.store.get(w.id))).toMatchObject({ state: 'running', privateIp: '10.40.0.101' })
  })

  test('a first boot that never finishes fails, and its instance is stopped', async () => {
    const s = (await setup({ ready: false }))
    const w = await s.workspaces.create('ann', { name: 'one' })
    s.cloud.instances.get('i-1')!.state = 'running'
    s.advance(31 * MINUTE)
    await s.workspaces.tick()
    expect((await s.store.get(w.id))).toMatchObject({ state: 'failed', error: "its first boot didn't finish within 30 minutes" })
    await s.workspaces.tick()
    expect(s.cloud.calls).toContain('stop i-1')
  })

  test('only one is on at a time, and each user has a limit', async () => {
    const s = (await setup({ maxRunning: 1, maxPerUser: 2 }))
    const first = await running(s)
    const err = await s.workspaces.create('bob', { name: 'two' }).catch((e) => e)
    expect(err).toBeInstanceOf(WindowsError)
    expect(err.status).toBe(409)
    expect(err.message).toContain('already on')

    await s.workspaces.stop('ann', first.id)
    s.cloud.instances.get('i-1')!.state = 'stopped'
    await s.workspaces.tick()
    expect((await s.store.get(first.id))!.state).toBe('stopped')
    await s.workspaces.create('ann', { name: 'two' })
    expect((await s.workspaces.create('ann', { name: 'three' }).catch((e) => e)).message).toContain('the most each user may have')
    expect((await s.workspaces.start('ann', first.id).catch((e) => e)).message).toContain('already on')
  })

  test("running out of the account's vCPUs says so plainly", async () => {
    const s = (await setup())
    s.cloud.launch = async () => { throw Object.assign(new Error('You have requested more vCPU capacity than your current vCPU limit'), { name: 'VcpuLimitExceeded' }) }
    const err = await s.workspaces.create('ann', { name: 'one' }).catch((e) => e)
    expect(err.status).toBe(409)
    expect(err.message).toContain('may still be shutting down')
    expect((await s.workspaces.list('ann'))).toEqual([])
  })

  test('a stopped one starts again', async () => {
    const s = (await setup())
    const w = await running(s)
    await s.workspaces.stop('ann', w.id)
    s.cloud.instances.get('i-1')!.state = 'stopped'
    await s.workspaces.tick()
    expect((await s.workspaces.start('ann', w.id)).state).toBe('starting')
    s.cloud.instances.get('i-1')!.state = 'running'
    await s.workspaces.tick()
    expect((await s.store.get(w.id))!.state).toBe('running')
  })

  test('an idle one stops itself, unless its CPU is busy or someone is typing', async () => {
    const s = (await setup())
    const w = await running(s)
    s.advance(20 * MINUTE)
    await s.workspaces.tick()
    expect(s.cloud.calls).not.toContain('stop i-1')

    // Busy CPU: an agent is working, so it counts as used.
    s.advance(15 * MINUTE)
    s.cloud.busy = 40
    await s.workspaces.tick()
    expect(s.cloud.calls).not.toContain('stop i-1')

    s.cloud.busy = 1
    s.advance(29 * MINUTE)
    s.workspaces.touch(w.id)
    await s.workspaces.tick()
    expect(s.cloud.calls).not.toContain('stop i-1')

    s.advance(31 * MINUTE)
    await s.workspaces.tick()
    expect(s.cloud.calls).toContain('stop i-1')
    expect((await s.store.get(w.id))!.state).toBe('stopping')
  })

  test('idle stop can be turned off', async () => {
    const s = (await setup())
    const w = await running(s)
    await s.workspaces.update('ann', w.id, { idleStopMinutes: null })
    s.advance(10 * 60 * MINUTE)
    await s.workspaces.tick()
    expect(s.cloud.calls).not.toContain('stop i-1')
  })

  test("deleting one terminates its instance; others' workspaces look like they don't exist", async () => {
    const s = (await setup())
    const w = await running(s)
    await expect(s.workspaces.own('bob', w.id)).rejects.toThrow('no Windows workspace')
    await s.workspaces.remove('ann', w.id)
    expect(s.cloud.calls).toContain('terminate i-1')
    expect((await s.workspaces.list('ann'))).toEqual([])
  })

  test('an instance that disappears fails its workspace', async () => {
    const s = (await setup())
    const w = await running(s)
    s.cloud.instances.delete('i-1')
    await s.workspaces.tick()
    expect((await s.store.get(w.id))).toMatchObject({ state: 'failed', error: 'its instance is gone' })
  })

  test('passwords are long and mixed, and the first boot takes nothing odd', () => {
    for (let i = 0; i < 50; i++) expect(makePassword()).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])[A-Za-z0-9]{20}$/)
    const script = windowsUserData({ password: 'Abc123', vncPassword: 'vncvnc12', publicKey: 'ssh-ed25519 AAAA x' })
    expect(script).toStartWith('<powershell>')
    expect(script).toContain("ConvertTo-SecureString 'Abc123'")
    expect(script).not.toContain('net.exe user')
    // EC2's network is a public one to Windows; sshd's rule must cover it.
    expect(script).toContain("Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Profile Any")
    expect(script).toContain("@('PasswordAuthentication no', 'KbdInteractiveAuthentication no')")
    expect(() => windowsUserData({ password: "x'; Remove-Item C:\\", vncPassword: 'v', publicKey: 'k' })).toThrow()
  })
})

describe('Windows routes, end to end', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  async function serve(s: Awaited<ReturnType<typeof setup>>) {
    const tickets = new Tickets()
    const authenticate = async (req: Request) => {
      const user = req.headers.get('authorization')?.replace(/^Bearer /, '')
      return user ? { id: user } : null
    }
    const app = new Hono().route('/api', windowsRoutes({ authenticate, workspaces: s.workspaces, tickets }))
    const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
    cleanups.push(() => server.stop(true))
    const base = server.url.href.replace(/\/$/, '')
    const api = (path: string, user = 'ann', init: RequestInit = {}) =>
      fetch(`${base}/api${path}`, { ...init, headers: { ...(user && { authorization: `Bearer ${user}` }), 'content-type': 'application/json' } })
    return { base, api }
  }

  async function until(check: () => boolean, ms = 5_000) {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out waiting')
      await Bun.sleep(10)
    }
  }

  test('create, a terminal, credentials, and delete', async () => {
    const s = (await setup())
    const { base, api } = await serve(s)
    expect((await api('/windows', '')).status).toBe(401)
    expect((await api('/windows', 'ann', { method: 'POST', body: JSON.stringify({ name: 'odd', size: 'huge' }) })).status).toBe(400)
    const created = await api('/windows', 'ann', { method: 'POST', body: JSON.stringify({ name: 'one' }) })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    expect((await api(`/windows/${id}/terminals`, 'ann', { method: 'POST' })).status).toBe(409)

    s.cloud.instances.get('i-1')!.state = 'running'
    await s.workspaces.tick()
    expect(await (await api(`/windows/${id}/credentials`)).json()).toEqual({ username: 'Administrator', password: (await s.store.get(id))!.password })
    expect((await api(`/windows/${id}/credentials`, 'bob')).status).toBe(404)

    const terminal = (await (await api(`/windows/${id}/terminals`, 'ann', { method: 'POST' })).json()) as { id: string }
    const { ticket } = (await (await api(`/windows/${id}/terminals/${terminal.id}/ticket`, 'ann', { method: 'POST' })).json()) as { ticket: string }
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/windows/${id}/terminals/${terminal.id}?ticket=${ticket}`)
    cleanups.push(() => ws.close())
    let output = ''
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.type === 'output') output += message.data
    })
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'input', data: 'echo win-$((6*7))\n' })))
    await until(() => output.includes('win-42'))

    expect((await api(`/windows/${id}`, 'ann', { method: 'DELETE' })).status).toBe(204)
    expect(s.cloud.calls).toContain('terminate i-1')
  })

  test('the desktop relays bytes to VNC both ways, and counts as use', async () => {
    // A stand-in VNC server that echoes what it gets, upper-cased.
    const vnc = Bun.listen({
      hostname: '127.0.0.1', port: 0,
      socket: { data(socket, data) { socket.write(Buffer.from(data).toString().toUpperCase()) } },
    })
    cleanups.push(() => vnc.stop(true))
    const s = (await setup({ vncPort: vnc.port }))
    const { base, api } = await serve(s)
    const created = (await (await api('/windows', 'ann', { method: 'POST', body: JSON.stringify({ name: 'one' }) })).json()) as { id: string }
    s.cloud.instances.get('i-1')!.state = 'running'
    s.cloud.instances.get('i-1')!.privateIp = '127.0.0.1'
    await s.workspaces.tick()

    const { ticket, password } = (await (await api(`/windows/${created.id}/desktop/ticket`, 'ann', { method: 'POST' })).json()) as { ticket: string; password: string }
    // noVNC signs in with it.
    expect(password).toBe((await s.store.get(created.id))!.vncPassword)

    s.advance(20 * MINUTE)
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/windows/${created.id}/desktop?ticket=${ticket}`)
    cleanups.push(() => ws.close())
    ws.binaryType = 'arraybuffer'
    let received = ''
    ws.addEventListener('message', (event) => (received += new TextDecoder().decode(event.data as ArrayBuffer)))
    ws.addEventListener('open', () => ws.send(new TextEncoder().encode('rfb 003.008')))
    await until(() => received === 'RFB 003.008')

    // Input at 20 minutes: at 45, it has been idle 25, so it stays on...
    s.advance(25 * MINUTE)
    await s.workspaces.tick()
    expect(s.cloud.calls).not.toContain('stop i-1')
    // ...and at 51 it has been idle 31, so it stops.
    s.advance(6 * MINUTE)
    await s.workspaces.tick()
    expect(s.cloud.calls).toContain('stop i-1')
  })
})
