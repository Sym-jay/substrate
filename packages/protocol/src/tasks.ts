import { z } from 'zod'
import { AgentMode } from './github.ts'

export const TaskId = z.string().uuid()
export const TaskRunner = z.enum(['command', 'claude', 'codex', 'opencode'])
export type TaskRunner = z.infer<typeof TaskRunner>
export const TaskSpec = z.object({
  title: z.string().trim().min(1).max(160),
  runner: TaskRunner,
  input: z.string().trim().min(1).max(32_000),
  mode: AgentMode.default('ask'),
  verificationCommand: z.string().trim().max(8_000).default(''),
  timeoutSeconds: z.number().int().min(10).max(86_400).default(3600),
})
export type TaskSpec = z.infer<typeof TaskSpec>
export const TaskState = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'needs_input'])
export type TaskState = z.infer<typeof TaskState>
export const TaskVerification = z.object({ command: z.string(), exitCode: z.number().int().nullable(), output: z.string() })
export const GuestTask = z.object({
  id: TaskId,
  spec: TaskSpec,
  state: TaskState,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  outputTruncated: z.boolean(),
  result: z.string(),
  exitCode: z.number().int().nullable(),
  verification: TaskVerification.nullable(),
  changes: z.string(),
  error: z.string().nullable(),
})
export type GuestTask = z.infer<typeof GuestTask>
export const StartGuestTask = z.object({ id: TaskId, spec: TaskSpec })
export const CancelGuestTask = z.object({ spec: TaskSpec.optional() })
export type StartGuestTask = z.infer<typeof StartGuestTask>
export const Task = z.object({
  id: TaskId,
  vmId: z.string(),
  spec: TaskSpec,
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  comparisonId: TaskId.nullable(),
  run: GuestTask.nullable(),
  error: z.string().nullable(),
  dispatchUncertain: z.boolean().default(false),
})
export type Task = z.infer<typeof Task>
export const CreateTask = z.object({ vmId: z.string().min(1), spec: TaskSpec })
export const ReviewTask = z.object({ reviewed: z.boolean() })
export const SelectApproach = z.object({ taskId: TaskId })
export const CreateComparison = z.object({
  sourceVmId: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  approaches: z.tuple([TaskSpec, TaskSpec]),
})
export type CreateComparison = z.infer<typeof CreateComparison>
export const Comparison = z.object({
  id: TaskId,
  sourceVmId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  state: z.enum(['preparing', 'ready', 'failed']),
  sourceCheckpointId: z.string().nullable(),
  taskIds: z.tuple([TaskId, TaskId]),
  vmIds: z.tuple([z.string(), z.string()]),
  selectedTaskId: TaskId.nullable(),
  error: z.string().nullable(),
})
export type Comparison = z.infer<typeof Comparison>
export const ForkPair = z.object({
  children: z.tuple([
    z.object({ id: z.string().regex(/^vm-[a-f0-9]{16}$/), name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/) }),
    z.object({ id: z.string().regex(/^vm-[a-f0-9]{16}$/), name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/) }),
  ]),
}).refine(({ children }) => children[0].id !== children[1].id && children[0].name !== children[1].name, 'Use two distinct fork destinations')
export type ForkPair = z.infer<typeof ForkPair>
export const taskIsActive = (state: TaskState) => state === 'queued' || state === 'running'
export const taskIsPending = (task: Task) => task.dispatchUncertain || (!task.error && (!task.run || taskIsActive(task.run.state)))
