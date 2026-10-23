import { TerminalInput, type Session, type TerminalOutput } from '@substrate/protocol'

type Listener = (message: TerminalOutput) => void
const MAX_SCROLLBACK_BYTES = 1024 * 1024
const MAX_PER_WORKSPACE = 16

// Bun hands the process the PTY but doesn't make it its controlling terminal,
// so ssh wouldn't hear about resizes. setsid (util-linux) does that.
export const withControllingTerminal = (argv: string[]) => ['setsid', '--ctty', '--wait', ...argv]

// One terminal: ssh into the workspace (PowerShell 7) on a PTY, plus its
// scrollback. It runs whether or not anyone is attached; every attach replays
// the scrollback first.
export class WindowsTerminal {
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

  // `onActivity` hears input and output, which keep the workspace from
  // stopping as idle.
  constructor(argv: string[], private readonly onActivity: () => void = () => {}) {
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
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', TERM: 'xterm-256color', LANG: 'C.UTF-8' },
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
    return { id: this.id, agent: null, createdAt: this.createdAt, state: this.state, exitCode: this.exitCode }
  }

  attach(listener: Listener) {
    listener({ type: 'ready', scrollback: this.chunks.join(''), truncated: this.truncated, cols: this.cols, rows: this.rows, state: this.state, exitCode: this.exitCode })
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
      this.onActivity()
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
    this.onActivity()
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

// Each workspace's terminals. They end when the workspace stops, and when the
// control box restarts.
export class WindowsTerminals {
  private byWorkspace = new Map<string, Map<string, WindowsTerminal>>()

  list(id: string) {
    return [...(this.byWorkspace.get(id)?.values() ?? [])].map((t) => t.info)
  }

  get(id: string, terminalId: string) {
    return this.byWorkspace.get(id)?.get(terminalId)
  }

  create(id: string, argv: string[], onActivity?: () => void) {
    const terminals = this.byWorkspace.get(id) ?? new Map<string, WindowsTerminal>()
    if (terminals.size >= MAX_PER_WORKSPACE) {
      // Make room by forgetting the oldest one that has ended.
      const ended = [...terminals.values()].find((t) => t.state === 'exited')
      if (!ended) throw new Error(`this workspace already has ${MAX_PER_WORKSPACE} terminals`)
      terminals.delete(ended.id)
    }
    const terminal = new WindowsTerminal(argv, onActivity)
    terminals.set(terminal.id, terminal)
    this.byWorkspace.set(id, terminals)
    return terminal
  }

  stopAll(id: string) {
    for (const terminal of this.byWorkspace.get(id)?.values() ?? []) terminal.stop()
    this.byWorkspace.delete(id)
  }
}
