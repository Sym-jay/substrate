import { afterAll, expect, test } from 'bun:test'
import { TaskSpec, type Task, type GuestTask } from '@substrate/protocol'
import { testDatabase } from './db.ts'
import { Notifications } from './notifications.ts'
import { notificationRoutes } from './notification-routes.ts'
import { Telegram, TelegramError, type TelegramFetch } from './telegram.ts'
import { WorkflowStore } from './workflow-store.ts'
import { createApp } from './app.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterAll(async () => { for (const close of cleanup) await close() })
const config = { token: '123456:PRIVATE_BOT_TOKEN', username: 'substrate_test_bot', webhookSecret: 'test-webhook-secret-unguessable-value' }
const origin = 'https://substrate.example'
const post = (body: unknown = {}): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
function task(state?: GuestTask['state']): Task {
  const spec = TaskSpec.parse({ title: 'Check repository', runner: 'command', input: 'PRIVATE_PROMPT', verificationCommand: 'PRIVATE_VERIFY' })
  const id = crypto.randomUUID(), createdAt = new Date().toISOString()
  return { id, spec, vmId: 'vm-a', createdAt, reviewedAt: null, comparisonId: null, error: null, dispatchUncertain: false,
    run: state ? { id, spec, state, createdAt, startedAt: createdAt, finishedAt: createdAt, stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR', outputTruncated: false,
      result: 'PRIVATE_RESULT', exitCode: 0, verification: null, changes: 'PRIVATE_DIFF', error: null } : null }
}
async function rig() {
  const db = await testDatabase(); cleanup.push(() => db.close())
  let now = Date.now(), failure: TelegramError | null = null, gate: Promise<void> | null = null
  const sends: { chat_id: string; text: string; reply_markup: { inline_keyboard: { url: string }[][] } }[] = []
  const client = new Telegram(config.token, (async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (gate) await gate
    if (failure) throw failure
    sends.push(body)
    return Response.json({ ok: true, result: { message_id: sends.length } })
  }) as TelegramFetch)
  const service = new Notifications(db, config, origin, client, () => now)
  const store = new WorkflowStore(db, false, () => now)
  const app = notificationRoutes(async (request) => request.headers.has('x-user') ? { id: request.headers.get('x-user')! } : null, service)
  const call = (user: string | null, path: string, input: RequestInit = {}) => app.request(path, { ...input, headers: { ...input.headers, ...(user ? { 'x-user': user } : {}) } })
  const receive = (code: string, id = 123, type = 'private') => service.receive({ message: { text: `/start ${code}`, chat: { id, type, username: `person${id}` }, from: { id, is_bot: false } } })
  async function connect(user: string, id = 123) {
    const link = await service.begin(user), code = new URL(link.url).searchParams.get('start')!
    await receive(code, id); await service.confirm(user)
    return code
  }
  async function complete(user: string, state: GuestTask['state'] = 'succeeded') {
    const t = task(state), run = t.run; t.run = null
    await store.saveTask(user, t); t.run = run; await store.saveTask(user, t)
    return t
  }
  return { db, service, store, client, app, call, receive, connect, complete, sends, time: () => now,
    advance: (ms: number) => { now += ms }, gate: (promise: Promise<void> | null) => { gate = promise },
    fail: (error: TelegramError | null) => { failure = error },
    worker: () => new Notifications(db, config, origin, client, () => now) }
}

test('linking requires the authenticated owner, a secret webhook, a private chat and browser confirmation', async () => {
  const r = await rig()
  for (const [path, init] of [['/notifications', {}], ['/notifications', { ...post(), method: 'PUT' }], ['/notifications/telegram', { method: 'DELETE' }], ['/notifications/telegram/connect', post()], ['/notifications/telegram/confirm', post()], ['/notifications/test', post()]] as const) {
    expect((await r.call(null, path, init)).status).toBe(401)
  }
  const result = await r.call('alice', '/notifications/telegram/connect', post())
  expect(result.headers.get('cache-control')).toBe('no-store')
  const link = await result.json() as { url: string }, code = new URL(link.url).searchParams.get('start')!
  expect(code.length).toBeLessThanOrEqual(64)
  const rows = JSON.stringify(await r.db`select * from telegram_links`)
  expect(rows).not.toContain(code)
  const input = { message: { text: `/start ${code}`, chat: { id: 123, type: 'private', username: 'alice' }, from: { id: 123 } } }
  expect((await r.call(null, '/telegram/webhook', post(input))).status).toBe(404)
  expect((await r.call(null, '/telegram/webhook', { ...post(input), headers: { 'x-telegram-bot-api-secret-token': 'forged' } })).status).toBe(404)
  expect(await r.receive(code, 123, 'group')).toBeNull()
  expect((await r.call('alice', '/notifications/telegram/confirm', post())).status).toBe(409)
  expect((await r.call(null, '/telegram/webhook', { ...post(input), headers: { 'x-telegram-bot-api-secret-token': config.webhookSecret } })).status).toBe(200)
  expect((await r.call(null, '/telegram/webhook', { ...post({ ...input, padding: 'x'.repeat(65_536) }), headers: { 'x-telegram-bot-api-secret-token': config.webhookSecret } })).status).toBe(413)
  expect((await r.service.status('alice')).connected).toBe(false)
  expect((await r.call('bob', '/notifications/telegram/confirm', post())).status).toBe(409)
  expect((await r.call('alice', '/notifications/telegram/confirm', post())).status).toBe(200)
  expect(await r.receive(code)).toBeNull()
  expect((await r.service.status('alice')).chatLabel).toBe('@alice')
  expect((await r.service.status('bob')).connected).toBe(false)
  expect(JSON.stringify(await r.service.status('alice'))).not.toContain('chat_id')
  const duplicate = await r.service.begin('bob'); await r.receive(new URL(duplicate.url).searchParams.get('start')!)
  await expect(r.service.confirm('bob')).rejects.toThrow('another account')
})

test('links expire, a new link invalidates the old one, and the first private claimant cannot be overwritten', async () => {
  const r = await rig(), a = await r.service.begin('alice'), b = await r.service.begin('alice')
  expect(await r.receive(new URL(a.url).searchParams.get('start')!)).toBeNull()
  const code = new URL(b.url).searchParams.get('start')!
  expect(await r.receive(code)).not.toBeNull()
  expect(await r.receive(code, 456)).toBeNull()
  r.advance(600_001)
  await expect(r.service.confirm('alice')).rejects.toThrow('press Start')
  expect(await r.receive(code)).toBeNull()
})

test('task transition and notification intent commit together, with no historical replay or duplicate refresh alerts', async () => {
  const r = await rig(); await r.connect('alice')
  const old = task('succeeded'); await r.store.saveTask('alice', old)
  expect((await r.db`select * from notification_outbox`).length).toBe(0)
  const pending = task(), finished = { ...pending, run: { ...old.run!, id: pending.id, spec: pending.spec } }
  await r.store.saveTask('alice', pending)
  await expect(r.db.begin(async (tx) => { await new WorkflowStore(tx, true, r.time).saveTask('alice', finished); throw new Error('rollback') })).rejects.toThrow('rollback')
  expect((await r.store.task('alice', pending.id))?.run).toBeNull()
  expect((await r.db`select * from notification_outbox`).length).toBe(0)
  await r.store.saveTask('alice', finished); await r.store.saveTask('alice', finished)
  expect((await r.db`select * from notification_outbox`).length).toBe(1)
  await r.service.tick(); await r.service.tick()
  expect(r.sends.length).toBe(1)
  expect(r.sends[0]!.chat_id).toBe('123')
  expect(r.sends[0]!.text).toBe('Task finished\nCheck repository')
  expect(r.sends[0]!.reply_markup.inline_keyboard[0]![0]!.url).toBe(`${origin}/#/inbox/task/${pending.id}`)
  expect(JSON.stringify(await r.db`select * from notification_outbox`)).not.toContain('PRIVATE_')
  expect(JSON.stringify(r.sends)).not.toContain('PRIVATE_')
  await r.connect('bob', 456)
  await r.store.saveTask('bob', finished)
  expect((await r.db`select * from notification_outbox`).length).toBe(1)
})

test('event preferences and task state distinguish failure, attention, cancellation and uncertain dispatch', async () => {
  const r = await rig(); await r.connect('alice')
  await r.service.preferences('alice', { enabled: true, successes: false, failures: true, attention: true })
  await r.complete('alice'); await r.complete('alice', 'cancelled')
  await r.complete('alice', 'failed'); await r.complete('alice', 'interrupted'); await r.complete('alice', 'needs_input')
  const unknown = task(); await r.store.saveTask('alice', unknown)
  unknown.error = 'Unconfirmed'; unknown.dispatchUncertain = true; await r.store.saveTask('alice', unknown)
  const kinds = (await r.db`select kind from notification_outbox`).map((x: { kind: string }) => x.kind).sort()
  expect(kinds).toEqual(['attention', 'attention', 'failure'])
  await r.service.tick(); expect(r.sends.length).toBe(3)
})

test('disabling, disconnecting or replacing a connection prevents queued alerts from being redirected or replayed', async () => {
  const r = await rig(); await r.connect('alice'); await r.complete('alice')
  await r.service.preferences('alice', { enabled: false, successes: true, failures: true, attention: true })
  await r.service.tick(); expect(r.sends.length).toBe(0)
  await r.service.preferences('alice', { enabled: true, successes: true, failures: true, attention: true })
  await r.complete('alice'); await r.service.disconnect('alice'); await r.connect('alice', 456)
  await r.service.tick(); expect(r.sends.length).toBe(0)
  await r.complete('alice'); await r.service.tick()
  expect(r.sends.map((row) => row.chat_id)).toEqual(['456'])
})

test('a failed delivery survives a worker restart and resumes only when due', async () => {
  const r = await rig(); await r.connect('alice'); await r.complete('alice')
  r.fail(new TelegramError('network_failure'))
  await r.service.tick()
  let [row] = await r.db`select state, attempts from notification_outbox`
  expect(row).toMatchObject({ state: 'pending', attempts: 1 })
  r.fail(null); await r.worker().tick(); expect(r.sends.length).toBe(0)
  r.advance(15_001); await r.worker().tick()
  ;[row] = await r.db`select state, attempts from notification_outbox`
  expect(row).toMatchObject({ state: 'sent', attempts: 2 })
  expect(r.sends.length).toBe(1)
})

test('multiple workers lease a delivery once; abandoned leases are recovered after restart', async () => {
  const r = await rig(); await r.connect('alice'); await r.complete('alice')
  let release!: () => void
  r.gate(new Promise<void>((resolve) => { release = resolve }))
  const first = r.service.tick()
  for (let i = 0; i < 100; i++) { if ((await r.db`select state from notification_outbox`)[0]?.state === 'sending') break; await Bun.sleep(5) }
  await r.worker().tick(); release(); await first
  expect(r.sends.length).toBe(1)
  r.gate(null); await r.complete('alice')
  await r.db`update notification_outbox set state = 'sending', lease_token = 'lost-process', lease_until = ${r.time() + 30_000} where state = 'pending'`
  await r.worker().tick(); expect(r.sends.length).toBe(1)
  r.advance(30_001); await r.worker().tick(); expect(r.sends.length).toBe(2)
})

test('Telegram flood control honors retry_after, permanent errors stop, and test messages are rate-limited', async () => {
  const r = await rig(); await r.connect('alice')
  await r.service.test('alice'); await expect(r.service.test('alice')).rejects.toThrow('30 seconds')
  const flood = new Telegram(config.token, (async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 60 } }, { status: 429 })) as TelegramFetch)
  await new Notifications(r.db, config, origin, flood, r.time).tick()
  expect((await r.db`select available_at from notification_outbox`)[0]!.available_at).toBe(r.time() + 60_000)
  r.advance(59_999); await r.service.tick(); expect(r.sends.length).toBe(0)
  r.advance(2); await r.service.tick(); expect(r.sends.length).toBe(1)
  await r.complete('alice')
  const forbidden = new Telegram(config.token, (async () => Response.json({ ok: false, error_code: 403 }, { status: 403 })) as TelegramFetch)
  await new Notifications(r.db, config, origin, forbidden, r.time).tick()
  expect((await r.db`select state from notification_outbox where kind <> 'test'`)[0]!.state).toBe('failed')
  await r.service.tick(); expect(r.sends.length).toBe(1)
})

test('unconfigured notifications are explicit and preview origin never exposes settings or webhook', async () => {
  const r = await rig(), disabled = new Notifications(r.db, null, origin)
  expect((await disabled.status('alice')).available).toBe(false)
  await expect(disabled.begin('alice')).rejects.toThrow('not configured')
  const app = createApp({ version: 'test', region: 'test', webDir: 'missing', clerkPublishableKey: null,
    readHost: async () => ({ configured: false }), vms: { unavailable: 'off' }, notifications: r.app })
  for (const path of ['/api/notifications', '/api/telegram/webhook']) expect((await app.request(path, { method: path.includes('webhook') ? 'POST' : 'GET', headers: { 'x-substrate-preview': '1' } })).status).toBe(404)
})

test('Telegram errors never expose a token-bearing URL, response description or transport exception', async () => {
  for (const transport of [async () => { throw new Error(`https://api.telegram.org/bot${config.token}/sendMessage`) },
    async () => Response.json({ ok: false, error_code: 401, description: config.token }, { status: 401 })]) {
    const client = new Telegram(config.token, transport as TelegramFetch)
    try { await client.send('123', 'test', origin); throw new Error('expected failure') }
    catch (error) { expect(String(error)).not.toContain(config.token) }
  }
})

test('persistent transport failures stop after six attempts and old alerts expire without sending', async () => {
  const r = await rig(); await r.connect('alice'); await r.complete('alice')
  r.fail(new TelegramError('unavailable'))
  for (let i = 0; i < 6; i++) { await r.service.tick(); r.advance(3_600_001) }
  expect((await r.db`select state, attempts from notification_outbox`)[0]).toMatchObject({ state: 'failed', attempts: 6 })
  r.fail(null); await r.service.tick(); expect(r.sends.length).toBe(0)
  await r.complete('alice'); r.advance(24 * 3_600_000 + 1); await r.worker().tick()
  expect(r.sends.length).toBe(0)
  expect((await r.db`select state from notification_outbox where error_code = 'delivery_expired'`).length).toBe(1)
})
