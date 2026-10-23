import { AgentResume, TerminalInput, type AgentMode, type CreateSession, type Session, type TerminalOutput } from '@substrate/protocol'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

type Listener = (message: TerminalOutput) => void
// What counts as someone using the VM (see activity.ts).
export type ActivitySink = { touch(): void; input(): void }
const noActivity: ActivitySink = { touch() {}, input() {} }
const MAX_SCROLLBACK_BYTES = 1024 * 1024
const MAX_SESSIONS = 32

// Bun hands the process the PTY but doesn't make it its controlling terminal,
// so Ctrl+C and job control wouldn't work. setsid (util-linux) does that.
export const withControllingTerminal = (argv: string[]) => ['setsid', '--ctty', '--wait', ...argv]

// `runuser -l` gives the same login shell (PATH, HOME) as exec.ts. When an
// agent exits, a shell takes over, so the session stays usable.
export function sessionArgv({ agent, mode = 'ask' }: CreateSession, resume = false): string[] {
  const cwd = 'if [ -d /home/dev/workspace ]; then cd /home/dev/workspace; fi; '
  if (!agent) return withControllingTerminal(['runuser', '-l', 'dev', '-c', `${cwd}exec bash -l`])
  const commands = {
    claude: mode === 'auto' ? 'claude --dangerously-skip-permissions' : 'claude --permission-mode default',
    codex: mode === 'auto' ? 'codex --dangerously-bypass-approvals-and-sandbox' : 'codex --sandbox workspace-write --ask-for-approval on-request',
    opencode: mode === 'auto' ? 'opencode --auto' : `OPENCODE_CONFIG_CONTENT='{"permission":"ask"}' opencode`,
    agy: mode === 'auto' ? 'agy --dangerously-skip-permissions' : 'agy',
  }
  return withControllingTerminal(['runuser', '-l', 'dev', '-c', `${cwd}${resume ? commands[agent].replace(agent, AgentResume[agent]) : commands[agent]}; exec bash -l`])
}

// Where running sessions are listed, for `Sessions.start(true)`.
export const SESSIONS_FILE = '/var/lib/substrate-guestd/sessions.json'
type Saved = { id: string; agent: Session['agent']; createdAt: string; mode?: AgentMode; checkpointId?: string | null }

// One terminal: a process on a PTY plus its scrollback. It runs whether or not
// anyone is attached; every attach replays the scrollback first.
export class TerminalSession {
  readonly id: string
  readonly createdAt: string
  private readonly terminal: Bun.Terminal
  private readonly process: Bun.Subprocess
  private listeners = new Set<Listener>()
  private chunks: string[] = []
  private bytes = 0
  private truncated = false
  private cols = 80
  private rows = 24
  private exitCode: number | null = null

  constructor(
    readonly agent: Session['agent'],
    argv: string[],
    cwd: string,
    private readonly activity: ActivitySink = noActivity,
    readonly mode: AgentMode = 'ask',
    readonly checkpointId: string | null = null,
    // A session reopened after a restart keeps its ID, so open tabs reattach.
    reopened?: Saved & { notice: string },
  ) {
    this.id = reopened?.id ?? crypto.randomUUID()
    this.createdAt = reopened?.createdAt ?? new Date().toISOString()
    if (reopened) this.output(reopened.notice)
    const decoder = new TextDecoder()
    this.terminal = new Bun.Terminal({
      cols: this.cols,
      rows: this.rows,
      data: (_terminal, data) => {
        const text = decoder.decode(data, { stream: true })
        if (text) this.output(text)
      },
    })
    this.process = Bun.spawn(argv, {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8' },
      terminal: this.terminal,
    })
    void this.process.exited.then((code) => {
      this.exitCode = code
      this.broadcast({ type: 'exit', exitCode: code })
      this.terminal.close()
    })
  }

  get exited() {
    return this.process.exited
  }

  get state(): Session['state'] {
    return this.exitCode === null ? 'running' : 'exited'
  }

  get info(): Session {
    return { id: this.id, agent: this.agent, createdAt: this.createdAt, state: this.state, exitCode: this.exitCode, mode: this.mode, checkpointId: this.checkpointId }
  }

  attach(listener: Listener) {
    this.activity.touch()
    listener({
      type: 'ready',
      scrollback: this.chunks.join(''),
      truncated: this.truncated,
      cols: this.cols,
      rows: this.rows,
      state: this.state,
      exitCode: this.exitCode,
    })
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // False for a message that isn't valid terminal input.
  receive(value: unknown) {
    const message = TerminalInput.safeParse(value)
    if (!message.success) return false
    if (this.state === 'exited') return true
    if (message.data.type === 'input') {
      this.activity.input()
      this.terminal.write(message.data.data)
    } else {
      this.cols = message.data.cols
      this.rows = message.data.rows
      this.terminal.resize(this.cols, this.rows)
    }
    return true
  }

  stop() {
    this.listeners.clear()
    if (this.state === 'running') this.process.kill('SIGKILL')
  }

  private output(data: string) {
    this.activity.touch()
    this.chunks.push(data)
    this.bytes += Buffer.byteLength(data)
    while (this.bytes > MAX_SCROLLBACK_BYTES && this.chunks.length > 1) {
      this.bytes -= Buffer.byteLength(this.chunks.shift()!)
      this.truncated = true
    }
    this.broadcast({ type: 'output', data })
  }

  private broadcast(message: TerminalOutput) {
    for (const listener of this.listeners) listener(message)
  }
}

export class Sessions {
  private sessions = new Map<string, TerminalSession>()

  constructor(
    private argv = sessionArgv,
    private cwd = '/home/dev',
    private activity: ActivitySink = noActivity,
    // Null keeps nothing on disk (tests).
    private file: string | null = null,
  ) {}

  // At guestd's start. With `reopen`, the sessions that were running before
  // come back under the same IDs, agents continuing their last conversation;
  // otherwise the old list is cleared, so a later crash can't bring back
  // sessions from before this boot.
  async start(reopen: boolean) {
    if (reopen && this.file) {
      const saved = await readFile(this.file, 'utf8').then((text) => JSON.parse(text) as Saved[], () => [])
      for (const s of saved.slice(0, MAX_SESSIONS)) {
        const notice = `[Substrate restarted this VM.${s.agent ? ` Continuing ${s.agent}'s last conversation.` : ''}]\r\n`
        this.add(new TerminalSession(s.agent, this.argv({ agent: s.agent ?? undefined, mode: s.mode ?? 'ask' }, true), this.cwd, this.activity, s.mode ?? 'ask', s.checkpointId ?? null, { ...s, notice }))
      }
    }
    await this.save()
  }

  list() {
    return [...this.sessions.values()].map((s) => s.info)
  }

  get(id: string) {
    return this.sessions.get(id)
  }

  // Null when the VM already has as many sessions as it may keep.
  create(req: CreateSession) {
    if (this.sessions.size >= MAX_SESSIONS) {
      // Make room by forgetting the oldest session that has ended.
      const ended = [...this.sessions.values()].find((s) => s.state === 'exited')
      if (!ended) return null
      this.sessions.delete(ended.id)
    }
    return this.add(new TerminalSession(req.agent ?? null, this.argv(req), this.cwd, this.activity, req.mode ?? 'ask', req.agent ? req.checkpointId ?? null : null))
  }

  private add(session: TerminalSession) {
    this.sessions.set(session.id, session)
    void this.save()
    void session.exited.then(() => this.save())
    return session
  }

  // Writes are queued, so the file always ends up with the latest list.
  private saving = Promise.resolve()
  private save() {
    const file = this.file
    if (!file) return this.saving
    this.saving = this.saving.then(async () => {
      const running = [...this.sessions.values()].filter((s) => s.state === 'running')
      const saved: Saved[] = running.map(({ id, agent, createdAt, mode, checkpointId }) => ({ id, agent, createdAt, mode, checkpointId }))
      await mkdir(dirname(file), { recursive: true })
      await writeFile(`${file}.tmp`, JSON.stringify(saved))
      await rename(`${file}.tmp`, file)
    }).catch((err) => console.error(`couldn't save the session list: ${err}`))
    return this.saving
  }
}
