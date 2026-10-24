import type { Db } from './db.ts'

// Which user owns which VM. hostd knows nothing about users, so the control
// API keeps this and only shows each user their own VMs.
export class Owners {
  constructor(private readonly db: Db) {}

  async owner(vmId: string): Promise<string | null> {
    const [row] = await this.db`select user_id from vms where id = ${vmId} and deleted_at is null`
    return row?.user_id ?? null
  }

  async vmsOf(userId: string): Promise<string[]> {
    return (await this.db`select id from vms where user_id = ${userId} and deleted_at is null`).map((row: { id: string }) => row.id)
  }

  async add(vmId: string, userId: string) {
    await this.db`insert into vms (id, user_id, created_at, deleted_at) values (${vmId}, ${userId}, ${new Date().toISOString()}, null)
      on conflict (id) do update set user_id = excluded.user_id, deleted_at = null`
  }

  // Kept, marked deleted: its usage still belongs to its owner.
  async remove(vmId: string) {
    await this.db`update vms set deleted_at = ${new Date().toISOString()} where id = ${vmId}`
  }
}
