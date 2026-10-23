import { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

type Capability = { userId: string; vmId: string; kind: 'preview' | 'ssh'; port: number; expires: number }
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

// Scoped credentials for a separate preview origin and editor connections.
// These never grant control-API access. Only hashes are kept on disk.
export class Capabilities {
  private db: Database
  constructor(path: string, private now = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true, strict: true })
    this.db.run('pragma journal_mode = wal')
    this.db.run('create table if not exists vm_capabilities (hash text primary key, value text not null, expires integer not null)')
  }
  issue(input: Omit<Capability, 'expires'>, ttlMs = 3_600_000) {
    this.db.query('delete from vm_capabilities where expires <= ?').run(this.now())
    const token = randomBytes(32).toString('base64url')
    const value = { ...input, expires: this.now() + ttlMs }
    this.db.query('insert into vm_capabilities values (?, ?, ?)').run(digest(token), JSON.stringify(value), value.expires)
    return { token, expiresAt: new Date(value.expires).toISOString() }
  }
  read(token: string, kind: Capability['kind'], vmId: string, port: number) {
    const row = this.db.query('select value from vm_capabilities where hash = ? and expires > ?').get(digest(token), this.now()) as { value: string } | null
    if (!row) return null
    const value = JSON.parse(row.value) as Capability
    return value.kind === kind && value.vmId === vmId && value.port === port ? value : null
  }
  close() { this.db.close() }
}
