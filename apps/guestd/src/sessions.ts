import { Agents, TerminalInput, type CreateSession, type Session, type TerminalOutput } from '@substrate/protocol'

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
export function sessionArgv({ agent }: CreateSession): string[] {
  return withControllingTerminal(
    agent ? ['runuser', '-l', 'dev', '-c', `${Agents[agent]}; exec bash -l`] : ['runuser', '-l', 'dev'],
  )
}

// One terminal: a process on a PTY plus its scrollback. It runs whether or not
// anyone is attached; every attach replays the scrollback first.
export class TerminalSession {
  readonly id = crypto.randomUUID()
  readonly createdAt = new Date().toISOString()
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
  ) {
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

  get state(): Session['state'] {
    return this.exitCode === null ? 'running' : 'exited'
  }

  get info(): Session {
    return { id: this.id, agent: this.agent, createdAt: this.createdAt, state: this.state, exitCode: this.exitCode }
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
  ) {}

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
    const session = new TerminalSession(req.agent ?? null, this.argv(req), this.cwd, this.activity)
    this.sessions.set(session.id, session)
    return session
  }
}
