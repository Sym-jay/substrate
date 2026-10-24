import type { Db } from './db.ts'
import { withStoreLock } from './store-lock.ts'
import type { AccountSshKey, SshToken } from '@substrate/protocol'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const MAX_KEYS = 20
const MAX_TOKENS = 10
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

// OpenSSH's own fingerprint (as `ssh-keygen -lf` shows it).
export function fingerprint(publicKey: string) {
  const blob = Buffer.from(publicKey.split(' ')[1] ?? '', 'base64')
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

export class SshAccessError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message)
  }
}

// What lets a user SSH into their VMs: public keys on their account, which
// every VM of theirs trusts, and personal tokens for the SSH proxy, which
// reach the control box. Tokens are kept only as hashes.
export class SshAccess {
  constructor(private db: Db, private now = () => new Date()) {}

  async keys(userId: string): Promise<AccountSshKey[]> {
    return this.db`select id, name, fingerprint, public_key as "publicKey", created_at as "createdAt" from account_ssh_keys where user_id = ${userId} order by created_at`
  }

  async addKey(userId: string, { name, publicKey }: { name?: string; publicKey: string }): Promise<AccountSshKey> {
    return withStoreLock(this.db, `ssh-keys:${userId}`, async (tx) => {
      const print = fingerprint(publicKey)
      const existing = await tx`select fingerprint from account_ssh_keys where user_id = ${userId}`
      if (existing.some((k: { fingerprint: string }) => k.fingerprint === print)) throw new SshAccessError(409, 'That key is already on your account')
      if (existing.length >= MAX_KEYS) throw new SshAccessError(409, `You have ${MAX_KEYS} keys, the most an account may have. Remove one first.`)
      const key: AccountSshKey = { id: randomUUID(), name: name || publicKey.split(' ').slice(2).join(' ') || publicKey.split(' ')[0]!, fingerprint: print, publicKey, createdAt: this.now().toISOString() }
      await tx`insert into account_ssh_keys (id, user_id, name, public_key, fingerprint, created_at) values (${key.id}, ${userId}, ${key.name}, ${key.publicKey}, ${key.fingerprint}, ${key.createdAt})`
      return key
    })
  }

  async removeKey(userId: string, id: string) {
    if (!(await this.db`delete from account_ssh_keys where id = ${id} and user_id = ${userId} returning id`).length) throw new SshAccessError(404, 'No such key')
  }

  async tokens(userId: string): Promise<SshToken[]> {
    return this.db`select id, name, created_at as "createdAt", last_used_at as "lastUsedAt" from account_ssh_tokens where user_id = ${userId} order by created_at`
  }

  // The token itself is returned this once; the stored hash migrates unchanged.
  async createToken(userId: string, name: string) {
    return withStoreLock(this.db, `ssh-tokens:${userId}`, async (tx) => {
      const [count] = await tx`select cast(count(*) as integer) as n from account_ssh_tokens where user_id = ${userId}`
      if (count.n >= MAX_TOKENS) throw new SshAccessError(409, `You have ${MAX_TOKENS} SSH tokens, the most an account may have. Revoke one first.`)
      const token = `sbs_${randomBytes(32).toString('base64url')}`
      const info: SshToken = { id: randomUUID(), name, createdAt: this.now().toISOString(), lastUsedAt: null }
      await tx`insert into account_ssh_tokens (id, user_id, name, hash, created_at, last_used_at) values (${info.id}, ${userId}, ${name}, ${digest(token)}, ${info.createdAt}, null)`
      return { token, ...info }
    })
  }

  async revokeToken(userId: string, id: string) {
    if (!(await this.db`delete from account_ssh_tokens where id = ${id} and user_id = ${userId} returning id`).length) throw new SshAccessError(404, 'No such token')
  }

  async userForToken(token: string): Promise<string | null> {
    if (!token.startsWith('sbs_')) return null
    const [row] = await this.db`update account_ssh_tokens set last_used_at = ${this.now().toISOString()} where hash = ${digest(token)} returning user_id`
    return row?.user_id ?? null
  }
}
