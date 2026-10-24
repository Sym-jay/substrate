import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { CliDeviceInfo, CliSession, CliToken } from '@substrate/protocol'
import { HTTPException } from 'hono/http-exception'
import type { Authenticate } from './auth.ts'
import type { Db } from './db.ts'
import { withStoreLock } from './store-lock.ts'

const DEVICE_TTL = 10 * 60_000
const SESSION_TTL = 30 * 24 * 60 * 60_000
const PREFIX = 'sub_cli_'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const iso = (value: number) => new Date(value).toISOString()
const fail = (status: 400 | 403 | 404 | 409 | 410 | 429, message: string): never => { throw new HTTPException(status, { message }) }
type Device = { hash: string; code: string; name: string; expires: number; state: 'pending' | 'approved' | 'denied' | 'redeemed'; user_id: string | null; last_poll: number }
type Credential = { id: string; hash: string; user_id: string; name: string; created: number; expires: number; last_used: number | null }
const session = (row: Credential): CliSession => ({ id: row.id, name: row.name, createdAt: iso(row.created), expiresAt: iso(row.expires), lastUsedAt: row.last_used === null ? null : iso(row.last_used) })

// Only hashes reach the database. Browser approvals are explicit, never on GET.
export class CliCredentials {
  constructor(private db: Db, private now = Date.now) {}
  async begin(name: string) {
    return withStoreLock(this.db, 'cli-device-creation', async (tx) => {
      const now = this.now()
      await tx`delete from cli_auth_devices where expires < ${now}`
      await tx`delete from cli_auth_credentials where expires < ${now}`
      const [count] = await tx`select cast(count(*) as integer) as n from cli_auth_devices`
      if (count.n >= 1024) fail(429, 'Too many pending CLI logins. Try again later.')
      const deviceCode = randomBytes(32).toString('base64url')
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
      const raw = [...randomBytes(8)].map((byte) => alphabet[byte & 31]).join('')
      const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`
      await tx`insert into cli_auth_devices (hash, code, name, expires, state, user_id, last_poll)
        values (${digest(deviceCode)}, ${userCode}, ${name}, ${now + DEVICE_TTL}, 'pending', null, 0)`
      return { deviceCode, userCode, expiresAt: iso(now + DEVICE_TTL), intervalSeconds: 2 }
    })
  }
  private async device(code: string): Promise<Device> {
    const [row] = await this.db`select * from cli_auth_devices where code = ${code}` as Device[]
    if (!row) return fail(404, 'CLI login not found. Run substrate login again.')
    if (row.expires <= this.now()) fail(410, 'This CLI login expired. Run substrate login again.')
    return row
  }
  async inspect(code: string): Promise<CliDeviceInfo> {
    const row = await this.device(code)
    return { userCode: row.code, name: row.name, expiresAt: iso(row.expires), state: row.state }
  }
  async decide(code: string, userId: string, approve: boolean) {
    await this.device(code)
    const rows = await this.db`update cli_auth_devices set state = ${approve ? 'approved' : 'denied'}, user_id = ${userId}
      where code = ${code} and state = 'pending' and expires > ${this.now()} returning hash`
    if (!rows.length) fail(409, 'This login request has already been answered or expired.')
  }
  async poll(deviceCode: string): Promise<CliToken | null> {
    return this.db.begin(async (tx) => {
      // A conditional write locks this device until commit on both adapters,
      // preventing two polls from redeeming the same approved request.
      const [row] = await tx`update cli_auth_devices set hash = hash where hash = ${digest(deviceCode)} returning *` as Device[]
      if (!row) return fail(404, 'CLI login not found.')
      const now = this.now()
      if (row.expires <= now) fail(410, 'CLI login expired. Run substrate login again.')
      if (row.state === 'denied') fail(403, 'CLI login was declined.')
      if (row.state === 'redeemed') fail(409, 'This login was already redeemed. Run substrate login again.')
      if (row.state === 'pending') {
        if (row.last_poll && now - row.last_poll < 2000) fail(429, 'Wait two seconds before polling again.')
        await tx`update cli_auth_devices set last_poll = ${now} where hash = ${row.hash}`
        return null
      }
      const userId = row.user_id!
      await tx`insert into store_locks (id) values (${`cli-sessions:${userId}`}) on conflict(id) do update set id = excluded.id`
      const [count] = await tx`select cast(count(*) as integer) as n from cli_auth_credentials where user_id = ${userId} and expires > ${now}`
      if (count.n >= 20) fail(409, 'Revoke an old CLI session in Settings before signing in again.')
      const token = PREFIX + randomBytes(32).toString('base64url')
      const record: Credential = { id: randomUUID(), hash: digest(token), user_id: userId, name: row.name, created: now, expires: now + SESSION_TTL, last_used: null }
      await tx`insert into cli_auth_credentials (id, hash, user_id, name, created, expires, last_used)
        values (${record.id}, ${record.hash}, ${userId}, ${record.name}, ${now}, ${record.expires}, null)`
      await tx`update cli_auth_devices set state = 'redeemed' where hash = ${row.hash}`
      return { token, userId, session: session(record) }
    })
  }
  async identify(token: string) {
    if (!token.startsWith(PREFIX) || token.length > 128) return null
    const [row] = await this.db`select * from cli_auth_credentials where hash = ${digest(token)} and expires > ${this.now()}` as Credential[]
    return row ? { userId: row.user_id, session: session(row) } : null
  }
  async touch(id: string) { await this.db`update cli_auth_credentials set last_used = ${this.now()} where id = ${id} and (last_used is null or last_used < ${this.now() - 60_000})` }
  async list(userId: string): Promise<CliSession[]> { return (await this.db`select * from cli_auth_credentials where user_id = ${userId} and expires > ${this.now()} order by created desc` as Credential[]).map(session) }
  async revoke(userId: string, id: string) { return (await this.db`delete from cli_auth_credentials where user_id = ${userId} and id = ${id} returning id`).length > 0 }
}

export const cliBearer = (request: Request) => /^Bearer (sub_cli_[A-Za-z0-9_-]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null

export function withCliAuthentication(browser: Authenticate, credentials: CliCredentials, allowedUser: (id: string) => Promise<boolean>): Authenticate {
  return async (request) => {
    const token = cliBearer(request)
    if (!token) return browser(request)
    const identity = await credentials.identify(token)
    if (!identity || !await allowedUser(identity.userId)) return null
    if (!await credentials.identify(token)) return null
    await credentials.touch(identity.session.id)
    return { id: identity.userId }
  }
}
