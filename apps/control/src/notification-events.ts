import { taskIsPending, type Task } from '@substrate/protocol'
import type { Db } from './db.ts'

export type NotificationKind = 'success' | 'failure' | 'attention' | 'test'
export function notificationKind(task: Task): Exclude<NotificationKind, 'test'> | null {
  if (taskIsPending(task) || task.run?.state === 'cancelled') return null
  if (task.error || task.run?.state === 'interrupted' || task.run?.state === 'needs_input') return 'attention'
  if (task.run?.state === 'failed' || (task.run?.verification && task.run.verification.exitCode !== 0)) return 'failure'
  return task.run?.state === 'succeeded' ? 'success' : null
}

// Called in the same transaction that commits an active -> terminal task.
// This never reads task output/prompts or sends a request to Telegram.
export async function enqueueTaskNotification(db: Db, userId: string, task: Task, now = Date.now()) {
  const kind = notificationKind(task)
  if (!kind) return
  const [settings] = await db`select * from notification_settings where user_id = ${userId}`
  if (!settings?.enabled || !settings.chat_id || !settings[kind === 'success' ? 'successes' : kind === 'failure' ? 'failures' : 'attention']) return
  await db`insert into notification_outbox (id, event_key, user_id, task_id, title, kind, generation, state, attempts, available_at, created_at)
    values (${crypto.randomUUID()}, ${`task:${task.id}`}, ${userId}, ${task.id}, ${task.spec.title}, ${kind}, ${settings.generation}, 'pending', 0, ${now}, ${new Date(now).toISOString()})
    on conflict(event_key) do nothing`
}
