import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// Which user owns which VM. hostd knows nothing about users, so the control
// API keeps this and only shows each user their own VMs.
export class Owners {
  private db: Database

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true, strict: true })
    this.db.run('pragma journal_mode = wal')
    this.db.run(`create table if not exists vm_owners (
      vm_id text primary key,
      user_id text not null,
      created_at text not null
    )`)
  }

  owner(vmId: string): string | null {
    const row = this.db.query('select user_id from vm_owners where vm_id = $vmId').get({ vmId }) as
      | { user_id: string }
      | null
    return row?.user_id ?? null
  }

  vmsOf(userId: string): string[] {
    const rows = this.db.query('select vm_id from vm_owners where user_id = $userId').all({ userId }) as {
      vm_id: string
    }[]
    return rows.map((r) => r.vm_id)
  }

  add(vmId: string, userId: string) {
    this.db
      .query('insert or replace into vm_owners (vm_id, user_id, created_at) values ($vmId, $userId, $at)')
      .run({ vmId, userId, at: new Date().toISOString() })
  }

  remove(vmId: string) {
    this.db.query('delete from vm_owners where vm_id = $vmId').run({ vmId })
  }
}
