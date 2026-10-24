import type { WindowsWorkspace, WindowsWorkspaceState } from '@substrate/protocol'
import type { Db } from '../db.ts'

export type WindowsRow = {
  id: string
  owner: string
  name: string
  instanceId: string | null
  instanceType: string
  state: WindowsWorkspaceState
  privateIp: string | null
  password: string
  vncPassword: string
  createdAt: string
  lastActiveAt: string
  idleStopMinutes: number | null
  error: string | null
}

export const toWorkspace = ({ id, name, state, instanceType, createdAt, idleStopMinutes, error }: WindowsRow): WindowsWorkspace =>
  ({ id, name, state, instanceType, createdAt, idleStopMinutes, error })

const columns = { name: 'name', instanceId: 'instance_id', instanceType: 'instance_type', state: 'state', privateIp: 'private_ip',
  password: 'password', vncPassword: 'vnc_password', createdAt: 'created_at', lastActiveAt: 'last_active_at', idleStopMinutes: 'idle_stop_minutes', error: 'error' } as const
const selectColumns = 'id, owner, name, instance_id as "instanceId", instance_type as "instanceType", state, private_ip as "privateIp", password, vnc_password as "vncPassword", created_at as "createdAt", last_active_at as "lastActiveAt", idle_stop_minutes as "idleStopMinutes", error'

// Windows records share the control database: encrypted RDS in production,
// local SQLite in development. Passwords are never included in list responses.
export class WindowsStore {
  constructor(private db: Db) {}
  async all(): Promise<WindowsRow[]> {
    return this.db.unsafe(`select ${selectColumns} from windows_records order by created_at`)
  }
  async get(id: string): Promise<WindowsRow | null> {
    const [row] = await this.db.unsafe(`select ${selectColumns} from windows_records where id = $1`, [id])
    return row ?? null
  }
  async of(owner: string): Promise<WindowsRow[]> {
    return this.db.unsafe(`select ${selectColumns} from windows_records where owner = $1 order by created_at`, [owner])
  }
  async add(row: WindowsRow) {
    await this.db`insert into windows_records (id, owner, name, instance_id, instance_type, state, private_ip, password, vnc_password, created_at, last_active_at, idle_stop_minutes, error)
      values (${row.id}, ${row.owner}, ${row.name}, ${row.instanceId}, ${row.instanceType}, ${row.state}, ${row.privateIp}, ${row.password}, ${row.vncPassword}, ${row.createdAt}, ${row.lastActiveAt}, ${row.idleStopMinutes}, ${row.error})`
  }
  async update(id: string, fields: Partial<Omit<WindowsRow, 'id' | 'owner'>>) {
    const changes: Record<string, string | number | null> = {}
    for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
      if (fields[key] !== undefined) changes[columns[key]] = fields[key]!
    }
    if (Object.keys(changes).length) await this.db`update windows_records set ${this.db(changes)} where id = ${id}`
  }
  async remove(id: string) { await this.db`delete from windows_records where id = ${id}` }
}
