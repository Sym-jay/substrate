import type { Task, Vm } from '@substrate/protocol'
import { taskIsPending } from '@substrate/protocol'

export const clean = (value: unknown) => Bun.stripANSI(String(value ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
export function table(headers: string[], rows: unknown[][]) {
  if (!rows.length) return 'No entries.'
  const cells = [headers, ...rows].map((row) => row.map((value) => clean(value).replace(/[\n\t]/g, ' ')))
  const widths = headers.map((_, i) => Math.max(...cells.map((row) => row[i]?.length ?? 0)))
  return cells.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n')
}
export const workspaceTable = (vms: Vm[]) => table(['ID', 'NAME', 'STATE', 'VCPU', 'RAM GiB', 'DISK GiB'], vms.map((vm) => [vm.id, vm.name, vm.state, vm.vcpus, vm.memMib / 1024, vm.diskGib]))
export const taskState = (task: Task) => task.dispatchUncertain ? 'unconfirmed' : task.error ? 'preparation failed' : task.run?.state ?? 'queued'
export const taskTable = (tasks: Task[]) => table(['ID', 'NAME', 'STATE', 'WORKSPACE', 'REVIEW'], tasks.map((task) => [task.id, task.spec.title, taskState(task), task.vmId, task.reviewedAt ? 'reviewed' : taskIsPending(task) ? '' : 'needs review']))
export function taskResult(task: Task) {
  const run = task.run
  return [
    `${clean(task.spec.title)} (${task.id})`, `State: ${taskState(task)} · workspace: ${task.vmId}`,
    task.error || run?.error,
    run && `Exit: ${run.exitCode ?? '—'} · verification: ${run.verification ? run.verification.exitCode === 0 ? 'passed' : run.verification.exitCode === null ? 'running' : 'failed' : 'not run'}`,
    run?.result || run?.stdout || run?.stderr,
    run?.verification && `Verification output:\n${run.verification.output || '(empty)'}`,
    run?.outputTruncated && 'Output capped; recent output retained.',
  ].filter(Boolean).map(clean).join('\n')
}
export const taskExit = (task: Task) => taskIsPending(task) ? 0 : task.error || task.run?.state !== 'succeeded' ? 1 : 0
