import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import type { NotificationPreferences, NotificationStatus } from '@substrate/protocol'
import type { Db } from './db.ts'
import type { NotificationKind } from './notification-events.ts'
import { withStoreLock } from './store-lock.ts'
import { Telegram, TelegramError } from './telegram.ts'

const LINK_TTL = 10 * 60_000, MAX_ATTEMPTS = 6, MAX_AGE = 24 * 60 * 60_000
const defaults: NotificationPreferences = { enabled: false, successes: true, failures: true, attention: true }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const iso = (now: number) => new Date(now).toISOString()
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 160)
type Settings = { user_id: string; enabled: number; successes: number; failures: number; attention: number; chat_id: string | null; chat_label: string | null; generation: string }
type Delivery = { id: string; user_id: string; task_id: string | null; title: string; kind: NotificationKind; generation: string; attempts: number; created_at: string; lease_token: string }
export type TelegramConfig = { token: string; username: string; webhookSecret: string }

export class Notifications {
  private busy = false
  private blockedUntil = 0
  constructor(private db: Db, private config: TelegramConfig | null, private publicUrl: string | null,
    private telegram = config ? new Telegram(config.token) : null, private now = Date.now) {}
  get available() {
    try { return !!this.config && !!this.telegram && !!this.publicUrl && new URL(this.publicUrl).protocol === 'https:' } catch { return false }
  }
  private ready() { if (!this.available) throw new HTTPException(503, { message: 'Telegram notifications are not configured on this server yet.' }) }
  private url(taskId: string | null) {
    const url = new URL(this.publicUrl!)
    url.hash = taskId ? `/inbox/task/${encodeURIComponent(taskId)}` : '/settings'
    return url.toString()
  }
  private async ensure(db: Db, userId: string) {
    await db`insert into notification_settings (user_id, enabled, successes, failures, attention, generation, updated_at)
      values (${userId}, 0, 1, 1, 1, ${randomUUID()}, ${iso(this.now())}) on conflict(user_id) do nothing`
  }
  async status(userId: string): Promise<NotificationStatus> {
    const [row] = await this.db`select * from notification_settings where user_id = ${userId}` as Settings[]
    const [link] = await this.db`select expires, chat_label from telegram_links where user_id = ${userId} and expires > ${this.now()}`
    const [last] = await this.db`select state, created_at, delivered_at, error_code from notification_outbox where user_id = ${userId} order by created_at desc, id desc limit 1`
    return { available: this.available, connected: !!row?.chat_id, chatLabel: row?.chat_label ?? null,
      preferences: row ? { enabled: !!row.enabled, successes: !!row.successes, failures: !!row.failures, attention: !!row.attention } : { ...defaults },
      pending: link ? { expiresAt: iso(Number(link.expires)), chatLabel: link.chat_label ?? null } : null,
      lastDelivery: last ? { state: last.state, at: last.delivered_at ?? last.created_at, error: last.error_code } : null }
  }
  async begin(userId: string) {
    this.ready()
    const code = `sub_${randomBytes(24).toString('base64url')}`, expires = this.now() + LINK_TTL
    await withStoreLock(this.db, 'telegram-connections', async (tx) => {
      await this.ensure(tx, userId)
      await tx`delete from telegram_links where user_id = ${userId} or expires <= ${this.now()}`
      await tx`insert into telegram_links (hash, user_id, expires) values (${hash(code)}, ${userId}, ${expires})`
    })
    return { url: `https://t.me/${this.config!.username}?start=${code}`, expiresAt: iso(expires) }
  }
  validWebhook(secret: string | undefined) {
    if (!this.available || !secret) return false
    const expected = Buffer.from(this.config!.webhookSecret), actual = Buffer.from(secret)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }
  // Only a private chat may propose a connection. The signed-in browser must
  // confirm it before it becomes a destination; Telegram never chooses a user ID.
  async receive(value: unknown): Promise<{ chatId: string } | null> {
    const update = value as { message?: { text?: unknown; date?: number; chat?: { id?: number; type?: string; username?: string; first_name?: string }; from?: { id?: number; is_bot?: boolean } } } | null
    const message = update?.message, chat = message?.chat
    if (!message || !chat || chat.type !== 'private' || !Number.isSafeInteger(chat.id) || chat.id! <= 0 ||
      message.from?.id !== chat.id || message.from?.is_bot || typeof message.text !== 'string') return null
    const code = /^\/start(?:@[A-Za-z0-9_]+)? (sub_[A-Za-z0-9_-]{32})$/.exec(message.text)?.[1]
    if (!code) return null
    return withStoreLock(this.db, 'telegram-connections', async (tx) => {
      const [link] = await tx`select * from telegram_links where hash = ${hash(code)} and expires > ${this.now()}`
      if (!link || (link.chat_id && link.chat_id !== String(chat.id))) return null
      const label = clean(chat.username ? `@${chat.username}` : chat.first_name || 'Private Telegram chat')
      await tx`update telegram_links set chat_id = ${String(chat.id)}, chat_label = ${label} where hash = ${hash(code)}`
      return { chatId: String(chat.id) }
    })
  }
  async confirm(userId: string) {
    this.ready()
    await withStoreLock(this.db, 'telegram-connections', async (tx) => {
      const [link] = await tx`select * from telegram_links where user_id = ${userId} and expires > ${this.now()}`
      if (!link?.chat_id) throw new HTTPException(409, { message: 'Open Telegram and press Start first, then confirm the connection here.' })
      const taken = await tx`select user_id from notification_settings where chat_id = ${link.chat_id} and user_id <> ${userId}`
      if (taken.length) throw new HTTPException(409, { message: 'This Telegram chat is connected to another account. Disconnect it there first.' })
      await this.ensure(tx, userId)
      await tx`update notification_settings set chat_id = ${link.chat_id}, chat_label = ${link.chat_label}, enabled = 1, generation = ${randomUUID()}, updated_at = ${iso(this.now())} where user_id = ${userId}`
      await tx`delete from telegram_links where user_id = ${userId}`
      await tx`update notification_outbox set state = 'skipped', error_code = 'connection_changed' where user_id = ${userId} and state in ('pending', 'sending')`
    })
    return this.status(userId)
  }
  async preferences(userId: string, input: NotificationPreferences) {
    await withStoreLock(this.db, 'telegram-connections', async (tx) => {
      await this.ensure(tx, userId)
      const [settings] = await tx`select chat_id from notification_settings where user_id = ${userId}`
      if (input.enabled && !settings?.chat_id) throw new HTTPException(409, { message: 'Connect Telegram before enabling notifications.' })
      await tx`update notification_settings set enabled = ${input.enabled ? 1 : 0}, successes = ${input.successes ? 1 : 0},
        failures = ${input.failures ? 1 : 0}, attention = ${input.attention ? 1 : 0}, updated_at = ${iso(this.now())} where user_id = ${userId}`
    })
    return this.status(userId)
  }
  async disconnect(userId: string) {
    await withStoreLock(this.db, 'telegram-connections', async (tx) => {
      await tx`update notification_settings set enabled = 0, chat_id = null, chat_label = null, generation = ${randomUUID()}, updated_at = ${iso(this.now())} where user_id = ${userId}`
      await tx`delete from telegram_links where user_id = ${userId}`
      await tx`update notification_outbox set state = 'skipped', error_code = 'disconnected' where user_id = ${userId} and state in ('pending', 'sending')`
    })
    return this.status(userId)
  }
  async test(userId: string) {
    this.ready()
    await withStoreLock(this.db, 'telegram-connections', async (tx) => {
      const [settings] = await tx`select * from notification_settings where user_id = ${userId}`
      if (!settings?.chat_id) throw new HTTPException(409, { message: 'Connect Telegram first.' })
      const recent = await tx`select id from notification_outbox where user_id = ${userId} and kind = 'test' and created_at > ${iso(this.now() - 30_000)} limit 1`
      if (recent.length) throw new HTTPException(429, { message: 'Wait 30 seconds before sending another test.' })
      const id = randomUUID()
      await tx`insert into notification_outbox (id, event_key, user_id, title, kind, generation, state, attempts, available_at, created_at)
        values (${id}, ${`test:${id}`}, ${userId}, 'Your Telegram notifications are connected.', 'test', ${settings.generation}, 'pending', 0, ${this.now()}, ${iso(this.now())})`
    })
    return this.status(userId)
  }
  async tick() {
    if (this.busy || !this.available || this.now() < this.blockedUntil) return
    this.busy = true
    try {
      for (let i = 0; i < 10; i++) {
        if (this.now() < this.blockedUntil) break
        const token = randomUUID(), now = this.now()
        // Atomic lease is shared by SQLite/Postgres and multiple control workers.
        const [row] = await this.db`update notification_outbox set state = 'sending', lease_token = ${token}, lease_until = ${now + 30_000}, attempts = attempts + 1
          where id = (select id from notification_outbox where (state = 'pending' and available_at <= ${now}) or (state = 'sending' and lease_until <= ${now}) order by available_at, id limit 1)
          and ((state = 'pending' and available_at <= ${now}) or (state = 'sending' and lease_until <= ${now})) returning *` as Delivery[]
        if (!row) break
        await this.deliver(row)
      }
      await this.db`delete from telegram_links where expires <= ${this.now()}`
      await this.db`delete from notification_outbox where state in ('sent', 'failed', 'skipped') and created_at < ${iso(this.now() - 30 * MAX_AGE)}`
    } finally { this.busy = false }
  }
  private async deliver(row: Delivery) {
    const finish = (state: string, error: string | null, next = this.now()) => this.db`update notification_outbox set state = ${state}, error_code = ${error},
      available_at = ${next}, lease_token = null, lease_until = null, delivered_at = ${state === 'sent' ? iso(this.now()) : null}
      where id = ${row.id} and state = 'sending' and lease_token = ${row.lease_token}`
    const [settings] = await this.db`select * from notification_settings where user_id = ${row.user_id}` as Settings[]
    const allowed = row.kind === 'test' || (settings?.enabled && settings[row.kind === 'success' ? 'successes' : row.kind === 'failure' ? 'failures' : 'attention'])
    if (!settings?.chat_id || settings.generation !== row.generation || !allowed) { await finish('skipped', 'preferences_changed'); return }
    if (this.now() - Date.parse(row.created_at) >= MAX_AGE || row.attempts > MAX_ATTEMPTS) { await finish('failed', 'delivery_expired'); return }
    const labels = { success: 'Task finished', failure: 'Task failed', attention: 'Task needs attention', test: 'Substrate test notification' }
    try {
      await this.telegram!.send(settings.chat_id, `${labels[row.kind]}\n${clean(row.title)}`, this.url(row.task_id))
      await finish('sent', null)
    } catch (error) {
      const problem = error instanceof TelegramError ? error : new TelegramError('telegram_unreachable')
      const delay = Math.max(problem.retryAfter * 1000, [15_000, 60_000, 300_000, 900_000, 3_600_000][Math.min(row.attempts - 1, 4)]!)
      if (problem.retryAfter) this.blockedUntil = this.now() + problem.retryAfter * 1000
      await finish(problem.permanent || row.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', problem.code, this.now() + delay)
    }
  }
  start() {
    const timer = setInterval(() => { void this.tick().catch(() => console.error('notification delivery: database unavailable; will retry')) }, 3000)
    timer.unref()
    return timer
  }
}
