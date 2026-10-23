import { Database } from 'bun:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CliDeviceInfo, CliSession, CliToken } from '@substrate/protocol'
import { HTTPException } from 'hono/http-exception'
import type { Authenticate } from './auth.ts'

const DEVICE_TTL = 10 * 60_000
const SESSION_TTL = 30 * 24 * 60 * 60_000
const PREFIX = 'sub_cli_'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const iso = (value: number) => new Date(value).toISOString()
const fail = (status: 400 | 403 | 404 | 409 | 410 | 429, message: string): never => { throw new HTTPException(status, { message }) }
type Device = { hash: string; code: string; name: string; expires: number; state: 'pending' | 'approved' | 'denied' | 'redeemed'; user_id: string | null; last_poll: number }
type Credential = { id: string; hash: string; user_id: string; name: string; created: number; expires: number; last_used: number | null }
const session = (row: Credential): CliSession => ({ id: row.id, name: row.name, createdAt: iso(row.created), expiresAt: iso(row.expires), lastUsedAt: row.last_used === null ? null : iso(row.last_used) })

// Only hashes of device secrets and bearer credentials reach disk. Browser
// approvals are separate from API-token authentication and never happen on GET.
export class CliCredentials {
  private db: Database
  constructor(path: string, private now = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true, strict: true })
    this.db.run('pragma journal_mode = wal')
    this.db.run('create table if not exists cli_devices (hash text primary key, code text unique not null, name text not null, expires integer not null, state text not null, user_id text, last_poll integer not null)')
    this.db.run('create table if not exists cli_credentials (id text primary key, hash text unique not null, user_id text not null, name text not null, created integer not null, expires integer not null, last_used integer)')
    this.db.run('create index if not exists cli_credentials_owner on cli_credentials(user_id)')
  }
  begin(name: string) {
    const now = this.now()
    this.db.query('delete from cli_devices where expires < ?').run(now)
    this.db.query('delete from cli_credentials where expires < ?').run(now)
    if ((this.db.query('select count(*) as n from cli_devices').get() as { n: number }).n >= 1024) fail(429, 'Too many pending CLI logins. Try again later.')
    const deviceCode = randomBytes(32).toString('base64url')
    // Forty bits, with ambiguous characters omitted; possession of this code
    // alone never redeems a credential (the CLI retains the 256-bit secret).
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const raw = [...randomBytes(8)].map((byte) => alphabet[byte & 31]).join('')
    const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`
    this.db.query("insert into cli_devices values (?, ?, ?, ?, 'pending', null, 0)").run(digest(deviceCode), userCode, name, now + DEVICE_TTL)
    return { deviceCode, userCode, expiresAt: iso(now + DEVICE_TTL), intervalSeconds: 2 }
  }
  private device(code: string) {
    const row = (this.db.query('select * from cli_devices where code = ?').get(code) as Device | null) ?? fail(404, 'CLI login not found. Run substrate login again.')
    if (row.expires <= this.now()) fail(410, 'This CLI login expired. Run substrate login again.')
    return row
  }
  inspect(code: string): CliDeviceInfo {
    const row = this.device(code)
    return { userCode: row.code, name: row.name, expiresAt: iso(row.expires), state: row.state }
  }
  decide(code: string, userId: string, approve: boolean) {
    const row = this.device(code)
    if (row.state !== 'pending') fail(409, 'This login request has already been answered.')
    this.db.query('update cli_devices set state = ?, user_id = ? where code = ?').run(approve ? 'approved' : 'denied', userId, code)
  }
  poll(deviceCode: string): CliToken | null {
    return this.db.transaction(() => this.pollOne(deviceCode))()
  }
  private pollOne(deviceCode: string): CliToken | null {
    const row = (this.db.query('select * from cli_devices where hash = ?').get(digest(deviceCode)) as Device | null) ?? fail(404, 'CLI login not found.')
    const now = this.now()
    if (row.expires <= now) fail(410, 'CLI login expired. Run substrate login again.')
    if (row.state === 'denied') fail(403, 'CLI login was declined.')
    if (row.state === 'redeemed') fail(409, 'This login was already redeemed. Run substrate login again.')
    if (row.state === 'pending') {
      if (row.last_poll && now - row.last_poll < 2000) fail(429, 'Wait two seconds before polling again.')
      this.db.query('update cli_devices set last_poll = ? where hash = ?').run(now, row.hash)
      return null
    }
    const userId = row.user_id!
    const token = PREFIX + randomBytes(32).toString('base64url')
    const record: Credential = { id: randomUUID(), hash: digest(token), user_id: userId, name: row.name, created: now, expires: now + SESSION_TTL, last_used: null }
    this.db.transaction(() => {
      const count = this.db.query('select count(*) as n from cli_credentials where user_id = ? and expires > ?').get(userId, now) as { n: number }
      if (count.n >= 20) fail(409, 'Revoke an old CLI session in Settings before signing in again.')
      this.db.query('insert into cli_credentials values (?, ?, ?, ?, ?, ?, null)').run(record.id, record.hash, userId, record.name, now, record.expires)
      this.db.query("update cli_devices set state = 'redeemed' where hash = ?").run(row.hash)
    })()
    return { token, userId, session: session(record) }
  }
  identify(token: string) {
    if (!token.startsWith(PREFIX) || token.length > 128) return null
    const row = this.db.query('select * from cli_credentials where hash = ? and expires > ?').get(digest(token), this.now()) as Credential | null
    return row ? { userId: row.user_id, session: session(row) } : null
  }
  touch(id: string) { this.db.query('update cli_credentials set last_used = ? where id = ? and (last_used is null or last_used < ?)').run(this.now(), id, this.now() - 60_000) }
  list(userId: string) { return (this.db.query('select * from cli_credentials where user_id = ? and expires > ? order by created desc').all(userId, this.now()) as Credential[]).map(session) }
  revoke(userId: string, id: string) { return this.db.query('delete from cli_credentials where user_id = ? and id = ?').run(userId, id).changes > 0 }
  close() { this.db.close() }
}

export const cliBearer = (request: Request) => /^Bearer (sub_cli_[A-Za-z0-9_-]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null

export function withCliAuthentication(browser: Authenticate, credentials: CliCredentials, allowedUser: (id: string) => Promise<boolean>): Authenticate {
  return async (request) => {
    const token = cliBearer(request)
    if (!token) return browser(request)
    const identity = credentials.identify(token)
    if (!identity || !await allowedUser(identity.userId)) return null
    if (!credentials.identify(token)) return null
    credentials.touch(identity.session.id)
    return { id: identity.userId }
  }
}
