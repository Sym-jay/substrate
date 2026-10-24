import type { Task } from '@substrate/protocol'

export const taskSummary = (task: Task): Task => ({ ...task, run: task.run ? { ...task.run,
  stdout: '', stderr: '', changes: '', result: task.run.result.slice(0, 240),
  verification: task.run.verification ? { ...task.run.verification, output: '' } : null } : null })
