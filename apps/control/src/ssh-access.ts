import { Database } from 'bun:sqlite'
import type { AccountSshKey, SshToken } from '@substrate/protocol'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

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
  private db: Database

  constructor(path: string, private now = () => new Date()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true, strict: true })
    this.db.run('pragma journal_mode = wal')
    this.db.run(`create table if not exists ssh_keys (
      id text primary key, userId text not null, name text not null, publicKey text not null,
      fingerprint text not null, createdAt text not null, unique (userId, fingerprint)
    )`)
    this.db.run(`create table if not exists ssh_tokens (
      id text primary key, userId text not null, name text not null, hash text not null unique,
      createdAt text not null, lastUsedAt text
    )`)
  }

  keys(userId: string): AccountSshKey[] {
    return this.db.query('select id, name, fingerprint, publicKey, createdAt from ssh_keys where userId = ? order by createdAt').all(userId) as AccountSshKey[]
  }

  addKey(userId: string, { name, publicKey }: { name?: string; publicKey: string }): AccountSshKey {
    const print = fingerprint(publicKey)
    const existing = this.keys(userId)
    if (existing.some((k) => k.fingerprint === print)) throw new SshAccessError(409, 'That key is already on your account')
    if (existing.length >= MAX_KEYS) throw new SshAccessError(409, `You have ${MAX_KEYS} keys, the most an account may have. Remove one first.`)
    const key: AccountSshKey = {
      id: randomUUID(),
      // The key's own comment (often user@machine) makes a fine default name.
      name: name || publicKey.split(' ').slice(2).join(' ') || publicKey.split(' ')[0]!,
      fingerprint: print,
      publicKey,
      createdAt: this.now().toISOString(),
    }
    this.db.query('insert into ssh_keys values (?, ?, ?, ?, ?, ?)').run(key.id, userId, key.name, key.publicKey, key.fingerprint, key.createdAt)
    return key
  }

  removeKey(userId: string, id: string) {
    if (!this.db.query('delete from ssh_keys where id = ? and userId = ?').run(id, userId).changes) throw new SshAccessError(404, 'No such key')
  }

  tokens(userId: string): SshToken[] {
    return this.db.query('select id, name, createdAt, lastUsedAt from ssh_tokens where userId = ? order by createdAt').all(userId) as SshToken[]
  }

  // The token itself is returned this once.
  createToken(userId: string, name: string) {
    if (this.tokens(userId).length >= MAX_TOKENS) throw new SshAccessError(409, `You have ${MAX_TOKENS} SSH tokens, the most an account may have. Revoke one first.`)
    const token = `sbs_${randomBytes(32).toString('base64url')}`
    const info: SshToken = { id: randomUUID(), name, createdAt: this.now().toISOString(), lastUsedAt: null }
    this.db.query('insert into ssh_tokens values (?, ?, ?, ?, ?, null)').run(info.id, userId, name, digest(token), info.createdAt)
    return { token, ...info }
  }

  revokeToken(userId: string, id: string) {
    if (!this.db.query('delete from ssh_tokens where id = ? and userId = ?').run(id, userId).changes) throw new SshAccessError(404, 'No such token')
  }

  // Whose token this is, if anyone's.
  userForToken(token: string): string | null {
    if (!token.startsWith('sbs_')) return null
    const row = this.db.query('select id, userId from ssh_tokens where hash = ?').get(digest(token)) as { id: string; userId: string } | null
    if (!row) return null
    this.db.query('update ssh_tokens set lastUsedAt = ? where id = ?').run(this.now().toISOString(), row.id)
    return row.userId
  }
}
