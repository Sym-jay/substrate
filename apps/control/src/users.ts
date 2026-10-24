import { randomUUID } from 'node:crypto'
import type { AccountEvent } from '@substrate/protocol'
import type { Db } from './db.ts'

// Everyone who has signed in, and when they were last seen (at most every
// ten minutes, so a busy user isn't a write per request).
export class Users {
  private seen = new Map<string, number>()

  constructor(private readonly db: Db, private readonly now = Date.now) {}

  async touch(userId: string) {
    const last = this.seen.get(userId) ?? 0
    if (this.now() - last < 600_000) return
    this.seen.set(userId, this.now())
    const at = new Date(this.now()).toISOString()
    await this.db`insert into users (id, created_at, last_seen_at) values (${userId}, ${at}, ${at})
      on conflict (id) do update set last_seen_at = excluded.last_seen_at`
  }
}

// What happened, per user: VMs created and deleted, sessions started, keys
// changed, quota stops. The web app's activity log, and an audit trail.
export class Events {
  constructor(private readonly db: Db) {}

  async record(userId: string, kind: string, vmId: string | null = null, detail: Record<string, unknown> | null = null) {
    await this.db`insert into events (id, user_id, vm_id, kind, detail, at)
      values (${randomUUID()}, ${userId}, ${vmId}, ${kind}, ${detail ? JSON.stringify(detail) : null}, ${new Date().toISOString()})`
      .catch((err: Error) => console.error(`event ${kind}: ${err.message}`))
  }

  async list(userId: string, limit = 50): Promise<AccountEvent[]> {
    const rows = await this.db`select * from events where user_id = ${userId} order by at desc limit ${limit}`
    return rows.map((row: { id: string; vm_id: string | null; kind: string; detail: string | null; at: string }) => ({
      id: row.id, vmId: row.vm_id, kind: row.kind, detail: row.detail ? JSON.parse(row.detail) : null, at: row.at,
    }))
  }
}

export const sessionsTable = (db: Db) => ({
  async record(input: { id: string; vmId: string; userId: string; agent: string | null }) {
    await db`insert into sessions (id, vm_id, user_id, agent, created_at) values (${input.id}, ${input.vmId}, ${input.userId}, ${input.agent}, ${new Date().toISOString()})
      on conflict (id) do nothing`
  },
})
