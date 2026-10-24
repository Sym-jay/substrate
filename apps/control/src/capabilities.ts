import { createHash, randomBytes } from 'node:crypto'
import type { Db } from './db.ts'

type Capability = { userId: string; vmId: string; kind: 'preview' | 'ssh'; port: number; expires: number }
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

// Scoped credentials for a separate preview origin and editor connections.
// These never grant control-API access. Only hashes are kept.
export class Capabilities {
  constructor(private readonly db: Db, private now = Date.now) {}

  async issue(input: Omit<Capability, 'expires'>, ttlMs = 3_600_000) {
    await this.db`delete from capabilities where expires <= ${this.now()}`
    const token = randomBytes(32).toString('base64url')
    const value = { ...input, expires: this.now() + ttlMs }
    await this.db`insert into capabilities (hash, value, expires) values (${digest(token)}, ${JSON.stringify(value)}, ${value.expires})`
    return { token, expiresAt: new Date(value.expires).toISOString() }
  }

  async read(token: string, kind: Capability['kind'], vmId: string, port: number) {
    const [row] = await this.db`select value from capabilities where hash = ${digest(token)} and expires > ${this.now()}`
    if (!row) return null
    const value = JSON.parse(row.value) as Capability
    return value.kind === kind && value.vmId === vmId && value.port === port ? value : null
  }
}
