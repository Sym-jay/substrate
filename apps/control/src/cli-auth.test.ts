import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { CliCredentials, withCliAuthentication } from './cli-auth.ts'
import { cliRoutes } from './cli-routes.ts'
import { createApp } from './app.ts'

const cleanups: (() => Promise<void>)[] = []
afterAll(async () => { for (const clean of cleanups.reverse()) await clean() })
const post = (body: unknown = {}): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const browser = async (request: Request) => ['alice', 'bob'].includes(request.headers.get('authorization')?.slice(7) ?? '') ? { id: request.headers.get('authorization')!.slice(7) } : null

test('device approval is explicit, secret-bound, single-use, durable, and stores only hashes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'substrate-cli-auth-')), path = join(directory, 'state.db')
  let now = 10_000, store = new CliCredentials(path, () => now)
  cleanups.push(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
  const grant = store.begin('My laptop')
  expect(store.inspect(grant.userCode).state).toBe('pending')
  expect(store.poll(grant.deviceCode)).toBeNull()
  expect(() => store.poll(grant.deviceCode)).toThrow('two seconds')
  expect(() => store.poll(grant.userCode)).toThrow('not found')
  store.decide(grant.userCode, 'alice', true)
  expect(() => store.decide(grant.userCode, 'bob', true)).toThrow('already been answered')
  const token = store.poll(grant.deviceCode)!
  expect(token.userId).toBe('alice')
  expect(() => store.poll(grant.deviceCode)).toThrow('already redeemed')
  expect(store.list('bob')).toEqual([])
  expect(store.list('alice')[0]?.id).toBe(token.session.id)
  store.close(); store = new CliCredentials(path, () => now)
  expect(store.identify(token.token)?.userId).toBe('alice')
  for (const file of [path, path + '-wal']) {
    const contents = await readFile(file).catch(() => Buffer.from(''))
    expect(contents.includes(token.token)).toBe(false)
    expect(contents.includes(grant.deviceCode)).toBe(false)
  }
  expect(store.revoke('bob', token.session.id)).toBe(false)
  expect(store.revoke('alice', token.session.id)).toBe(true)
  expect(store.identify(token.token)).toBeNull()
  const denied = store.begin('Declined'); store.decide(denied.userCode, 'alice', false)
  expect(() => store.poll(denied.deviceCode)).toThrow('declined')
  const expired = store.begin('Expired'); now += 10 * 60_000
  expect(() => store.inspect(expired.userCode)).toThrow('expired')
  expect(() => store.poll(expired.deviceCode)).toThrow('expired')
  const last = store.begin('Session expiry'); store.decide(last.userCode, 'alice', true)
  const long = store.poll(last.deviceCode)!; now += 30 * 24 * 60 * 60_000
  expect(store.identify(long.token)).toBeNull()
})

test('CLI auth preserves owner identity, checks account access, and rejects revocation during an access check', async () => {
  const store = new CliCredentials(':memory:'); cleanups.push(async () => store.close())
  const grant = store.begin('Test'); store.decide(grant.userCode, 'alice', true)
  const token = store.poll(grant.deviceCode)!
  let allowed = true
  const auth = withCliAuthentication(browser, store, async () => allowed)
  const request = new Request('https://test/api/vms', { headers: { authorization: `Bearer ${token.token}` } })
  expect(await auth(request)).toEqual({ id: 'alice' })
  allowed = false; expect(await auth(request)).toBeNull()
  const revokeWhileChecking = withCliAuthentication(browser, store, async () => { store.revoke('alice', token.session.id); return true })
  expect(await revokeWhileChecking(request)).toBeNull()
  expect(await auth(new Request('https://test', { headers: { authorization: 'Bearer alice' } }))).toEqual({ id: 'alice' })
})

test('CLI routes reject cookie-only approval, credential self-approval, foreign revocation, and replay', async () => {
  const credentials = new CliCredentials(':memory:'); cleanups.push(async () => credentials.close())
  const authenticate = withCliAuthentication(browser, credentials, async () => true)
  const app = new Hono().route('/api', cliRoutes({ credentials, browserAuthenticate: browser, authenticate }))
  const call = (path: string, init: RequestInit = {}, token?: string) => app.request('/api/cli' + path, { ...init, headers: { ...init.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } })
  const created = await call('/device', post({ name: 'Laptop' })), grant = await created.json() as { deviceCode: string; userCode: string }
  expect(created.status).toBe(201); expect(created.headers.get('cache-control')).toBe('no-store')
  expect((await call(`/device/${grant.userCode}`)).status).toBe(401)
  expect((await call(`/device/${grant.userCode}/approve`, { ...post(), headers: { cookie: '__session=alice' } })).status).toBe(401)
  expect((await call(`/device/${grant.userCode}`, {}, 'alice')).status).toBe(200)
  expect((await call('/device/token', post({ deviceCode: grant.deviceCode }))).status).toBe(202)
  expect((await call(`/device/${grant.userCode}/approve`, post(), 'alice')).status).toBe(204)
  const token = await (await call('/device/token', post({ deviceCode: grant.deviceCode }))).json() as { token: string; session: { id: string } }
  expect((await call('/device/token', post({ deviceCode: grant.deviceCode }))).status).toBe(409)
  expect((await call('/whoami', {}, token.token)).status).toBe(200)
  expect((await call('/sessions', {}, token.token)).status).toBe(401)
  const other = credentials.begin('Another login')
  expect((await call(`/device/${other.userCode}/approve`, post(), token.token)).status).toBe(401)
  expect((await call('/sessions/' + token.session.id, { method: 'DELETE' }, 'bob')).status).toBe(404)
  expect((await call('/sessions/' + token.session.id, { method: 'DELETE' }, 'alice')).status).toBe(204)
  expect((await call('/whoami', {}, token.token)).status).toBe(401)
  expect((await call('/sessions', {}, 'alice')).headers.get('cache-control')).toBe('no-store')
})

test('anonymous login creation and outstanding device records are bounded', async () => {
  const credentials = new CliCredentials(':memory:'); cleanups.push(async () => credentials.close())
  const app = new Hono().route('/api', cliRoutes({ credentials, browserAuthenticate: browser, authenticate: browser }))
  for (let i = 0; i < 10; i++) expect((await app.request('/api/cli/device', post({ name: 'test' }))).status).toBe(201)
  const limited = await app.request('/api/cli/device', post({ name: 'test' }))
  expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60')
  for (let i = 10; i < 1024; i++) credentials.begin('test')
  expect(() => credentials.begin('overflow')).toThrow('Too many pending')
})

test('the preview origin cannot initialize, redeem, or inspect CLI credentials', async () => {
  const credentials = new CliCredentials(':memory:'); cleanups.push(async () => credentials.close())
  const app = createApp({ version: 'test', region: 'test', webDir: 'missing', readHost: async () => ({ configured: false }), clerkPublishableKey: null,
    vms: { unavailable: 'test' }, cli: cliRoutes({ credentials, browserAuthenticate: browser, authenticate: browser }) })
  for (const path of ['/api/cli/device', '/api/cli/device/token', '/api/cli/sessions', '/api/cli/whoami']) {
    const reply = await app.request(path, { ...post({ name: 'test', deviceCode: 'not-a-secret' }), headers: { 'x-substrate-preview': '1', authorization: 'Bearer alice' } })
    expect(reply.status).toBe(404)
    expect(await reply.text()).not.toContain('deviceCode')
  }
})
