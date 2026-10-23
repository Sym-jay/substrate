import { GuestTask, TaskSpec, taskIsActive, type StartGuestTask } from '@substrate/protocol'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActivitySink } from './sessions.ts'

const OUTPUT_LIMIT = 128 * 1024
const MAX_RECORDS = 200
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

// Inputs are one quoted argument, never interpolated as shell instructions.
// Command tasks intentionally execute the owner's shell program as dev.
export function taskCommand(spec: TaskSpec) {
  const input = quote(spec.input)
  switch (spec.runner) {
    case 'command': return `bash -lc ${input}`
    case 'claude': return `claude -p --output-format json --permission-mode ${spec.mode === 'auto' ? 'bypassPermissions' : 'default'} -- ${input}`
    case 'codex': return `codex exec --skip-git-repo-check ${spec.mode === 'auto' ? '--dangerously-bypass-approvals-and-sandbox' : '--sandbox workspace-write'} -- ${input}`
    case 'opencode': return `OPENCODE_CONFIG_CONTENT=${quote(JSON.stringify({ permission: spec.mode === 'auto' ? 'allow' : {
      '*': 'deny', read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' }, glob: 'allow', grep: 'allow',
    } }))} opencode run -- ${input}`
  }
}

type Active = { child?: ChildProcess; cancelled: boolean; timedOut: boolean; done: Promise<void> }
type Options = {
  directory: string
  cwd?: string
  // Tests execute in an isolated local directory; production always uses dev.
  argv?: (command: string) => string[]
  activity?: Pick<ActivitySink, 'touch'>
}

// Tasks belong to guestd, not an HTTP request or browser. Saved results survive
// restarts. Interrupted tasks are never automatically replayed.
export class Tasks {
  private records = new Map<string, GuestTask>()
  private active = new Map<string, Active>()
  private saving = Promise.resolve()
  private dirty = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private creating = Promise.resolve()
  constructor(private options: Options) {}

  async start() {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.options.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
      try {
        const run = GuestTask.parse(JSON.parse(await readFile(join(this.options.directory, name), 'utf8')))
        if (name !== `${run.id}.json`) continue
        if (taskIsActive(run.state)) {
          run.state = 'interrupted'
          run.finishedAt = new Date().toISOString()
          run.error = 'The workspace restarted while this task was running. Inspect its output before starting a new task.'
        }
        this.records.set(run.id, run)
        this.dirty.add(run.id)
      } catch (error) { console.error(`could not restore task ${name}:`, error instanceof Error ? error.message : 'invalid task') }
    }
    await this.flush()
    this.timer = setInterval(() => {
      // An agent waiting on a model is still doing a task, even with low CPU.
      if (this.active.size) this.options.activity?.touch()
      void this.flush().catch((error) => console.error('task persistence:', error))
    }, 1000)
    this.timer.unref()
  }

  list() { return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
  get(id: string) { return this.records.get(id) ?? null }

  create(input: StartGuestTask) {
    const result = this.creating.then(() => this.createOne(input))
    this.creating = result.then(() => {}, () => {})
    return result
  }

  private async createOne({ id, spec }: StartGuestTask) {
    const previous = this.get(id)
    if (previous) {
      if (JSON.stringify(previous.spec) !== JSON.stringify(spec)) throw new Error('This task ID already has a different request')
      return previous
    }
    if (this.active.size) throw new Error('A task is already running in this workspace. Wait or cancel it before starting another.')
    if (this.records.size >= MAX_RECORDS) {
      const oldest = this.list().reverse().find((run) => !taskIsActive(run.state))
      if (oldest) { this.records.delete(oldest.id); await rm(this.path(oldest.id), { force: true }) }
    }
    const run: GuestTask = { id, spec, state: 'queued', createdAt: new Date().toISOString(), startedAt: null,
      finishedAt: null, stdout: '', stderr: '', result: '', outputTruncated: false, exitCode: null,
      verification: null, changes: '', error: null }
    this.records.set(id, run)
    this.dirty.add(id)
    // Publish before executing: a transport retry uses this ID, never reruns it.
    try { await this.flush() }
    catch (error) { this.records.delete(id); throw error }
    const active: Active = { cancelled: false, timedOut: false, done: Promise.resolve() }
    this.active.set(id, active)
    active.done = this.execute(run, active)
    return run
  }

  cancel(id: string, spec?: TaskSpec) {
    const result = this.creating.then(() => this.cancelOne(id, spec))
    this.creating = result.then(() => {}, () => {})
    return result
  }

  private async cancelOne(id: string, spec?: TaskSpec) {
    const run = this.get(id)
    if (!run) {
      if (!spec) return null
      // A cancellation can beat a delayed start request. Persist a tombstone
      // with the same ID so that eventual request cannot execute later.
      const cancelled: GuestTask = { id, spec, state: 'cancelled', createdAt: new Date().toISOString(),
        startedAt: null, finishedAt: new Date().toISOString(), stdout: '', stderr: '', result: '',
        exitCode: null, outputTruncated: false, verification: null, changes: '', error: 'Cancelled before execution was confirmed.' }
      this.records.set(id, cancelled); this.dirty.add(id); await this.flush()
      return cancelled
    }
    const active = this.active.get(id)
    if (active) { active.cancelled = true; this.kill(active); await active.done }
    return run
  }

  async close() {
    if (this.timer) clearInterval(this.timer)
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id)))
    await this.flush()
  }

  private path(id: string) { return join(this.options.directory, `${id}.json`) }
  private flush() {
    const values = [...this.dirty].map((id) => this.records.get(id)).filter((run): run is GuestTask => !!run)
      .map((run) => ({ id: run.id, text: JSON.stringify(run) }))
    this.dirty.clear()
    const next = this.saving.catch(() => {}).then(async () => {
      for (const { id, text } of values) {
        try {
          await writeFile(`${this.path(id)}.tmp`, text, { mode: 0o600 })
          await rename(`${this.path(id)}.tmp`, this.path(id))
        } catch (error) { this.dirty.add(id); throw error }
      }
    })
    this.saving = next
    return next
  }

  private kill(active: Active) {
    if (active.child?.pid) {
      try { process.kill(-active.child.pid, 'SIGKILL') } catch { active.child.kill('SIGKILL') }
    }
  }

  private command(command: string, active: Active, output: (text: string, stderr: boolean) => void) {
    const argv = this.options.argv?.(command) ?? ['runuser', '-l', 'dev', '-c',
      `if [ -d /home/dev/workspace ]; then cd /home/dev/workspace; fi; exec bash -lc ${quote(command)}`]
    return new Promise<number | null>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd: this.options.cwd, detached: true,
        env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'] })
      active.child = child
      child.stdout!.setEncoding('utf8').on('data', (data: string) => output(data, false))
      child.stderr!.setEncoding('utf8').on('data', (data: string) => output(data, true))
      child.once('error', reject)
      child.once('close', (code) => { if (active.child === child) active.child = undefined; resolve(code) })
      if (active.cancelled || active.timedOut) this.kill(active)
    })
  }

  private async execute(run: GuestTask, active: Active) {
    let outcome: GuestTask['state'] = 'succeeded'
    const timeout = setTimeout(() => { active.timedOut = true; this.kill(active) }, run.spec.timeoutSeconds * 1000)
    const append = (field: 'stdout' | 'stderr', text: string) => {
      const combined = run[field] + text
      run.outputTruncated ||= combined.length > OUTPUT_LIMIT
      run[field] = combined.slice(-OUTPUT_LIMIT)
      this.dirty.add(run.id)
      this.options.activity?.touch()
    }
    try {
      run.state = 'running'
      run.startedAt = new Date().toISOString()
      this.dirty.add(run.id)
      await this.flush()
      run.exitCode = await this.command(taskCommand(run.spec), active, (text, stderr) => append(stderr ? 'stderr' : 'stdout', text))
      run.result = run.stdout
      outcome = run.exitCode === 0 ? 'succeeded' : 'failed'
      if (run.spec.runner === 'claude') {
        try {
          const data = JSON.parse(run.stdout) as { result?: string; is_error?: boolean; permission_denials?: unknown[] }
          if (typeof data.result === 'string') run.result = data.result.slice(-OUTPUT_LIMIT)
          if (data.is_error) outcome = 'failed'
          if (data.permission_denials?.length) { outcome = 'needs_input'; run.error = 'The agent could not perform a restricted action. Inspect its result and continue in the workspace terminal, or create a task with different permissions.' }
        } catch { /* The complete raw output remains available. */ }
      }
      if (outcome === 'succeeded' && run.spec.verificationCommand && !active.cancelled && !active.timedOut) {
        run.verification = { command: run.spec.verificationCommand, output: '', exitCode: null }
        run.verification.exitCode = await this.command(run.spec.verificationCommand, active, (text) => {
          const combined = run.verification!.output + text
          run.outputTruncated ||= combined.length > OUTPUT_LIMIT
          run.verification!.output = combined.slice(-OUTPUT_LIMIT)
          this.dirty.add(run.id)
          this.options.activity?.touch()
        })
        if (run.verification.exitCode !== 0) outcome = 'failed'
      }
      if (!active.cancelled && !active.timedOut) {
        await this.command('git -c core.fsmonitor=false --no-pager diff --no-ext-diff --stat HEAD; git -c core.fsmonitor=false status --short', active,
          (text, stderr) => { if (!stderr) run.changes = (run.changes + text).slice(-32_768) })
      }
    } catch (error) { outcome = 'failed'; run.error = error instanceof Error ? error.message : 'Task execution failed' }
    finally {
      clearTimeout(timeout)
      run.state = outcome
      if (active.cancelled) { run.state = 'cancelled'; run.error = 'Cancelled by the owner.' }
      if (active.timedOut) { run.state = 'failed'; run.error = `Reached the ${run.spec.timeoutSeconds} second task limit.` }
      run.finishedAt = new Date().toISOString()
      this.dirty.add(run.id)
      this.active.delete(run.id)
      await this.flush().catch((error) => console.error('could not save task result:', error))
    }
  }
}
