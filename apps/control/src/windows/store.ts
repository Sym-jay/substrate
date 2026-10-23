import { Database } from 'bun:sqlite'
import type { WindowsWorkspace, WindowsWorkspaceState } from '@substrate/protocol'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type WindowsRow = {
  id: string
  owner: string
  name: string
  instanceId: string | null
  instanceType: string
  state: WindowsWorkspaceState
  privateIp: string | null
  // Administrator's, for the desktop's sign-in, and TightVNC's (8 characters).
  password: string
  vncPassword: string
  createdAt: string
  lastActiveAt: string
  idleStopMinutes: number | null
  error: string | null
}

export const toWorkspace = ({ id, name, state, instanceType, createdAt, idleStopMinutes, error }: WindowsRow): WindowsWorkspace =>
  ({ id, name, state, instanceType, createdAt, idleStopMinutes, error })

// Windows workspaces, in the control box's SQLite database. Their passwords
// are here too: the database is the control box's alone.
export class WindowsStore {
  private db: Database

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true, strict: true })
    this.db.run('pragma journal_mode = wal')
    this.db.run(`create table if not exists windows_workspaces (
      id text primary key, owner text not null, name text not null, instanceId text, instanceType text not null,
      state text not null, privateIp text, password text not null, vncPassword text not null,
      createdAt text not null, lastActiveAt text not null, idleStopMinutes integer, error text
    )`)
  }

  all(): WindowsRow[] {
    return this.db.query('select * from windows_workspaces order by createdAt').all() as WindowsRow[]
  }

  get(id: string) {
    return this.db.query('select * from windows_workspaces where id = ?').get(id) as WindowsRow | null
  }

  of(owner: string) {
    return this.db.query('select * from windows_workspaces where owner = ? order by createdAt').all(owner) as WindowsRow[]
  }

  add(row: WindowsRow) {
    this.db
      .query(`insert into windows_workspaces values ($id, $owner, $name, $instanceId, $instanceType, $state, $privateIp,
        $password, $vncPassword, $createdAt, $lastActiveAt, $idleStopMinutes, $error)`)
      .run(row)
  }

  update(id: string, fields: Partial<Omit<WindowsRow, 'id' | 'owner'>>) {
    for (const [key, value] of Object.entries(fields)) {
      this.db.query(`update windows_workspaces set ${key} = ? where id = ?`).run(value as string | number | null, id)
    }
  }

  remove(id: string) {
    this.db.query('delete from windows_workspaces where id = ?').run(id)
  }
}
