import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile, rm, mkdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GuestTask, TaskSpec, taskIsActive } from '@substrate/protocol'
import { Tasks, taskCommand } from './tasks.ts'

const directories: string[] = []
const managers: Tasks[] = []
afterAll(async () => { for (const manager of managers) await manager.close(); for (const path of directories) await rm(path, { recursive: true, force: true }) })
async function rig() {
  const directory = await mkdtemp(join(tmpdir(), 'substrate-tasks-'))
  directories.push(directory)
  const options = { directory: join(directory, 'runs'), cwd: directory, argv: (command: string) => ['/bin/bash', '-c', command] }
  const tasks = new Tasks(options)
  managers.push(tasks)
  await tasks.start()
  return { directory, options, tasks }
}
const spec = (input: string, extra: Partial<TaskSpec> = {}) => TaskSpec.parse({ title: 'Test task', runner: 'command', input, ...extra })
async function finished(tasks: Tasks, id: string) {
  for (let i = 0; i < 400; i++) {
    const run = tasks.get(id)!
    if (!taskIsActive(run.state)) return run
    await Bun.sleep(10)
  }
  throw new Error('task did not finish')
}

test('a detached task returns immediately, records verification, and survives a new manager', async () => {
  const { tasks, options } = await rig()
  const id = crypto.randomUUID()
  const task = await tasks.create({ id, spec: spec('sleep 0.1; printf "a result"; printf "progress" >&2', { verificationCommand: 'printf "verified"; exit 0' }) })
  expect(taskIsActive(task.state)).toBe(true)
  const result = await finished(tasks, id)
  expect(result.state).toBe('succeeded')
  expect(result.result).toBe('a result')
  expect(result.stderr).toBe('progress')
  expect(result.verification).toEqual({ command: 'printf "verified"; exit 0', output: 'verified', exitCode: 0 })
  await tasks.close()
  const recovered = new Tasks(options); managers.push(recovered); await recovered.start()
  expect(recovered.get(id)).toEqual(result)
})

test('verification failures stay distinct from a successful task exit', async () => {
  const { tasks } = await rig()
  const id = crypto.randomUUID()
  await tasks.create({ id, spec: spec('printf done', { verificationCommand: 'printf "assertion failed"; exit 7' }) })
  const run = await finished(tasks, id)
  expect(run.state).toBe('failed')
  expect(run.exitCode).toBe(0)
  expect(run.verification?.exitCode).toBe(7)
  expect(run.verification?.output).toBe('assertion failed')
})

test('task IDs are idempotent and concurrent requests cannot start two workspace tasks', async () => {
  const { tasks, directory } = await rig()
  const id = crypto.randomUUID(), input = spec('printf x >> executions; sleep 0.15')
  const first = await tasks.create({ id, spec: input })
  const retry = await tasks.create({ id, spec: input })
  expect(retry).toBe(first)
  await expect(tasks.create({ id, spec: spec('printf changed') })).rejects.toThrow('different request')
  const attempts = await Promise.allSettled([tasks.create({ id: crypto.randomUUID(), spec: input }), tasks.create({ id: crypto.randomUUID(), spec: input })])
  expect(attempts.map((attempt) => attempt.status)).toEqual(['rejected', 'rejected'])
  await finished(tasks, id)
  expect(await readFile(join(directory, 'executions'), 'utf8')).toBe('x')
  const concurrent = await Promise.allSettled([tasks.create({ id: crypto.randomUUID(), spec: spec('sleep 0.2') }), tasks.create({ id: crypto.randomUUID(), spec: spec('sleep 0.2') })])
  expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
})

test('cancel kills children and preserves output for review', async () => {
  const { tasks, directory } = await rig()
  const id = crypto.randomUUID()
  await tasks.create({ id, spec: spec('printf started; (sleep 0.3; printf leaked > child-finished) & wait') })
  for (let i = 0; !tasks.get(id)?.stdout.includes('started') && i < 100; i++) await Bun.sleep(10)
  const run = await tasks.cancel(id)
  expect(run?.state).toBe('cancelled')
  expect(run?.stdout).toContain('started')
  await Bun.sleep(400)
  expect(await Bun.file(join(directory, 'child-finished')).exists()).toBe(false)
})

test('running records become interrupted after guest restart and are never replayed', async () => {
  const r = await rig()
  const id = crypto.randomUUID()
  const saved = GuestTask.parse({ id, spec: spec('printf must-not-run > replayed'), state: 'running',
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null,
    stdout: 'saved progress', stderr: '', result: '', outputTruncated: false, exitCode: null,
    verification: null, changes: '', error: null })
  await writeFile(join(r.options.directory, `${id}.json`), JSON.stringify(saved))
  const recovered = new Tasks(r.options); managers.push(recovered); await recovered.start()
  expect(recovered.get(id)?.state).toBe('interrupted')
  expect(recovered.get(id)?.stdout).toBe('saved progress')
  await recovered.create({ id, spec: saved.spec })
  expect(await Bun.file(join(r.directory, 'replayed')).exists()).toBe(false)
})

test('large stdout is bounded and the retained result is marked truncated', async () => {
  const { tasks } = await rig()
  const id = crypto.randomUUID()
  await tasks.create({ id, spec: spec('head -c 300000 /dev/zero | tr "\\0" x') })
  const run = await finished(tasks, id)
  expect(run.stdout.length).toBeLessThanOrEqual(128 * 1024)
  expect(run.outputTruncated).toBe(true)
})

test('agent prompts reach the executable as one literal argument, including shell syntax', async () => {
  const { directory } = await rig()
  const bin = join(directory, 'bin'); await mkdir(bin)
  for (const runner of ['claude', 'codex', 'opencode'] as const) {
    const file = join(bin, runner)
    await writeFile(file, '#!/bin/sh\nfor arg in "$@"; do printf "%s\\0" "$arg"; done\n')
    await chmod(file, 0o755)
    const input = "literal ' $(touch injected) `touch injected2`\n--help"
    const proc = Bun.spawn(['/bin/bash', '-c', taskCommand(spec(input, { runner }))], { cwd: directory, env: { PATH: `${bin}:/usr/bin:/bin` } })
    const output = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(output.split('\0').at(-2)).toBe(input)
    expect(await Bun.file(join(directory, 'injected')).exists()).toBe(false)
    expect(await Bun.file(join(directory, 'injected2')).exists()).toBe(false)
  }
})

test('Claude permission denials are actionable results instead of successful work', async () => {
  const r = await rig()
  const tasks = new Tasks({ ...r.options, argv: () => ['/bin/bash', '-c', `printf '%s' '{"result":"Need permission","permission_denials":[{"tool":"Bash"}]}'`] })
  managers.push(tasks); await tasks.start()
  const id = crypto.randomUUID()
  await tasks.create({ id, spec: spec('a task', { runner: 'claude', verificationCommand: 'exit 0' }) })
  const run = await finished(tasks, id)
  expect(run.state).toBe('needs_input')
  expect(run.result).toBe('Need permission')
  expect(run.verification).toBeNull()
})

test('a cancellation arriving before a delayed start prevents that ID from executing', async () => {
  const { tasks, directory } = await rig()
  const id = crypto.randomUUID(), input = spec('printf late > late-start')
  expect((await tasks.cancel(id, input))?.state).toBe('cancelled')
  const late = await tasks.create({ id, spec: input })
  expect(late.state).toBe('cancelled')
  expect(await Bun.file(join(directory, 'late-start')).exists()).toBe(false)
})

test('the runtime deadline ends the process group and records a bounded failure', async () => {
  const { tasks } = await rig()
  const id = crypto.randomUUID()
  // Shortened internal clock budget; HTTP input validation requires >= 10 s.
  await tasks.create({ id, spec: { ...spec('sleep 3; printf too-late'), timeoutSeconds: .05 } })
  const run = await finished(tasks, id)
  expect(run.state).toBe('failed')
  expect(run.error).toContain('task limit')
  expect(run.stdout).not.toContain('too-late')
})
