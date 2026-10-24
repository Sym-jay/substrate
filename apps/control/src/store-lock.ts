import type { TransactionSQL } from 'bun'
import type { Db } from './db.ts'

// A row lock shared by both adapters. SQLite serializes writers; Postgres
// locks this row until commit. Keeps bounded credential/key creation atomic.
export function withStoreLock<T>(db: Db, name: string, work: (tx: TransactionSQL) => Promise<T>) {
  return db.begin(async (tx) => {
    await tx`insert into store_locks (id) values (${name}) on conflict(id) do update set id = excluded.id`
    return work(tx)
  })
}
