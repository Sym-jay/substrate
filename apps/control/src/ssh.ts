import { AddAccountSshKey, CreateSshToken, type Vm } from '@substrate/protocol'
import { relayTo } from '@substrate/protocol/relay'
import { Hono, type MiddlewareHandler } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import type { WSEvents } from 'hono/ws'
import type { Authenticate, User } from './auth.ts'
import type { Owners } from './owners.ts'
import { SshAccessError, type SshAccess } from './ssh-access.ts'

type Env = { Variables: { user: User } }
type Frame = string | ArrayBuffer | Uint8Array

type Options = {
  hostd: { url: string; token: string }
  authenticate: Authenticate
  owners: Owners
  access: SshAccess
}

// How long a client has to send its token after connecting.
const AUTH_TIMEOUT_MS = 10_000

// SSH into your VMs with your own keys: the keys on your account, the tokens
// the SSH proxy (ssh-proxy.mjs) uses, and the connection itself.
export function sshRoutes({ hostd, authenticate, owners, access }: Options) {
  const app = new Hono<Env>()
  const auth = { Authorization: `Bearer ${hostd.token}` }
  const callHostd = (path: string, init: RequestInit = {}) =>
    fetch(`${hostd.url}${path}`, { ...init, headers: { ...auth, 'content-type': 'application/json' } }).catch(() => null)

  const ownVms = async (userId: string) => {
    const res = await callHostd('/vms')
    if (!res?.ok) return null
    const mine = new Set(owners.vmsOf(userId))
    return ((await res.json()) as Vm[]).filter((vm) => mine.has(vm.id))
  }

  // Puts the account's keys on each of the user's running VMs, so a removed
  // key stops working now rather than at the next connection.
  const pushKeys = async (userId: string) => {
    const publicKeys = access.keys(userId).map((k) => k.publicKey)
    for (const vm of (await ownVms(userId)) ?? []) {
      if (vm.state !== 'running') continue
      await callHostd(`/vms/${vm.id}/ssh/keys`, { method: 'PUT', body: JSON.stringify({ publicKeys }) })
    }
  }

  // ── The connection: a WebSocket carrying SSH's bytes to the VM ──
  // The token comes as the first message ({"token": "sbs_…"}), or in an
  // Authorization header from clients that can send one. `target` is a VM's
  // ID or name, with or without `.substrate`.
  app.get('/ssh/connect/:target', upgradeWebSocket((c) => {
    const header = c.req.header('authorization')?.replace(/^Bearer /, '') ?? null
    return connection(c.req.param('target')!.replace(/\.substrate$/, ''), header)
  }))

  function connection(target: string, headerToken: string | null): WSEvents {
    let relay: ReturnType<typeof relayTo> | null = null
    let state: 'auth' | 'connecting' | 'open' | 'closed' = 'auth'
    const closed = () => state === 'closed'
    let timer: ReturnType<typeof setTimeout> | undefined
    const early: Frame[] = []
    let earlyBytes = 0

    const start = async (token: string, client: Parameters<NonNullable<WSEvents['onOpen']>>[1]) => {
      state = 'connecting'
      clearTimeout(timer)
      const fail = (code: number, reason: string) => { state = 'closed'; client.close(code, reason) }
      const userId = access.userForToken(token)
      if (!userId) return fail(4401, 'invalid or revoked SSH token')
      const vms = await ownVms(userId)
      if (!vms) return fail(1011, "can't reach the sandbox host")
      const vm = vms.find((v) => v.id === target) ?? vms.find((v) => v.name === target)
      if (!vm) return fail(4404, `you have no workspace called ${target}`)
      const publicKeys = access.keys(userId).map((k) => k.publicKey)
      if (!publicKeys.length) return fail(4409, 'add an SSH key to your account first')
      // Starts (or resumes) it if need be, and makes sure it trusts your keys.
      const synced = await callHostd(`/vms/${vm.id}/ssh/keys`, { method: 'PUT', body: JSON.stringify({ publicKeys, start: true }) })
      if (!synced?.ok) return fail(1011, `couldn't prepare ${vm.name} for SSH`)
      // The client may have gone while the VM was being prepared.
      if (closed()) return
      relay = relayTo(`${hostd.url.replace(/^http/, 'ws')}/vms/${vm.id}/ssh`, auth)
      relay.onOpen(new Event('open'), client)
      state = 'open'
      for (const data of early.splice(0)) relay.onMessage({ data } as MessageEvent, client)
    }

    return {
      onOpen(_event, client) {
        if (headerToken) void start(headerToken, client)
        else timer = setTimeout(() => { state = 'closed'; client.close(4401, 'no SSH token sent') }, AUTH_TIMEOUT_MS)
      },
      onMessage(event, client) {
        if (state === 'auth') {
          let token = ''
          try { token = String((JSON.parse(String(event.data)) as { token?: unknown }).token ?? '') } catch {}
          void start(token, client)
          return
        }
        if (state === 'open' && relay) return relay.onMessage(event, client)
        if (state !== 'connecting') return
        // SSH's first bytes, while the VM is being prepared.
        const data = event.data as Frame
        earlyBytes += typeof data === 'string' ? data.length : data.byteLength
        if (earlyBytes > 1_048_576) { state = 'closed'; client.close(1013, 'too much sent before the connection was up') }
        else early.push(data)
      },
      onClose() {
        state = 'closed'
        clearTimeout(timer)
        relay?.onClose()
      },
    }
  }

  // ── Keys and tokens: signed in ──
  const signedIn: MiddlewareHandler<Env> = async (c, next) => {
    const user = await authenticate(c.req.raw)
    if (!user) return c.json({ error: 'sign in first' }, 401)
    c.set('user', user)
    await next()
  }
  for (const path of ['/ssh/keys', '/ssh/keys/*', '/ssh/tokens', '/ssh/tokens/*']) app.use(path, signedIn)

  app.get('/ssh/keys', (c) => c.json(access.keys(c.var.user.id)))
  app.post('/ssh/keys', async (c) => {
    const input = AddAccountSshKey.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: input.error.issues[0]?.message ?? 'Use an OpenSSH public key' }, 400)
    const key = access.addKey(c.var.user.id, input.data)
    void pushKeys(c.var.user.id)
    return c.json(key, 201)
  })
  app.delete('/ssh/keys/:id', (c) => {
    access.removeKey(c.var.user.id, c.req.param('id'))
    void pushKeys(c.var.user.id)
    return c.body(null, 204)
  })

  app.get('/ssh/tokens', (c) => c.json(access.tokens(c.var.user.id)))
  app.post('/ssh/tokens', async (c) => {
    const input = CreateSshToken.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: 'Name the token (where it will be used)' }, 400)
    c.header('cache-control', 'no-store')
    return c.json(access.createToken(c.var.user.id, input.data.name), 201)
  })
  app.delete('/ssh/tokens/:id', (c) => {
    access.revokeToken(c.var.user.id, c.req.param('id'))
    return c.body(null, 204)
  })

  app.onError((err, c) => {
    if (err instanceof SshAccessError) return c.json({ error: err.message }, err.status)
    console.error(`${c.req.method} ${c.req.path}: ${err.message}`)
    return c.json({ error: err.message }, 500)
  })

  return app
}
