import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { workspaceApi } from './api.ts'
import { connectTerminal, type ConnectionState } from './connection.ts'

const labels: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
  exited: 'Session ended',
  error: 'Connection error',
}
const keys = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['Up', '\x1b[A'],
  ['Down', '\x1b[B'], ['Left', '\x1b[D'], ['Right', '\x1b[C'],
] as const

// Why there's no connection: the VM is being saved, is paused, or is waking up.
export type Asleep = 'pausing' | 'paused' | 'waking'
const asleepLabels: Record<Asleep, string> = { pausing: 'Saving…', paused: 'Paused', waking: 'Waking…' }

type Props = {
  path: string
  title: string
  // Fill the pane it's in (the Workspaces page) rather than a fixed height.
  fill?: boolean
  asleep?: Asleep
  // Called once when someone types into a paused terminal.
  onWake?: () => void
}

export function TerminalView({ path, title, fill, asleep, onWake }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const screen = useRef<{ term: Terminal; fit: FitAddon } | null>(null)
  const connected = useRef(false)
  const wake = useRef(onWake)
  const input = useRef<(data: string) => void>(() => {})
  const ctrl = useRef(false)
  const [controlHeld, setControlHeld] = useState(false)
  const [state, setState] = useState<ConnectionState>('connecting')
  const [detail, setDetail] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    wake.current = onWake
  })

  // The screen outlives connections, so a paused session keeps showing its
  // last output.
  useEffect(() => {
    if (!container.current) return
    let frame = 0
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 14,
      lineHeight: 1.3,
      scrollback: 10_000,
      screenReaderMode: true,
      theme: {
        background: '#000000', foreground: '#eceef1', cursor: '#d9dce1',
        selectionBackground: '#3a3a3a', black: '#1a1a1a', brightBlack: '#8d8d8d',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container.current)
    fit.fit()
    screen.current = { term, fit }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { if (connected.current) fit.fit() })
    })
    observer.observe(container.current)
    return () => {
      screen.current = null
      cancelAnimationFrame(frame)
      observer.disconnect()
      term.dispose()
    }
  }, [path])

  useEffect(() => {
    if (!screen.current) return
    const { term, fit } = screen.current
    if (asleep) {
      // The first key typed into a paused (or pausing) terminal wakes the VM.
      // It isn't sent on: you can't see yet what it would be answering.
      term.options.disableStdin = asleep === 'waking'
      const typing = term.onData(() => {
        typing.dispose()
        wake.current?.()
      })
      return () => typing.dispose()
    }

    let disposed = false
    const connection = connectTerminal({
      url: () => workspaceApi.terminalUrl(path),
      onState(next, message) {
        if (disposed) return
        connected.current = next === 'connected'
        term.options.disableStdin = !connected.current
        setState(next)
        setDetail(message ?? '')
      },
      onMessage(message) {
        if (disposed) return
        if (message.type === 'ready') {
          term.reset()
          term.resize(message.cols, message.rows)
          const notice = message.truncated ? '[Earlier scrollback was trimmed]\r\n' : ''
          term.write(notice + message.scrollback, () => {
            if (disposed) return
            fit.fit()
            connection.send({ type: 'resize', cols: term.cols, rows: term.rows })
          })
          if (message.state === 'exited') term.write(`\r\n[Process exited: ${message.exitCode ?? 'unknown'}]\r\n`)
        } else if (message.type === 'output') {
          term.write(message.data)
        } else {
          term.write(`\r\n[Process exited: ${message.exitCode}]\r\n`)
        }
      },
    })

    const sendInput = (data: string) => {
      if (ctrl.current) {
        if (data.length === 1 && /[a-z@\[\]\\^_?]/i.test(data)) {
          data = data === '?' ? '\x7f' : String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31)
        }
        ctrl.current = false
        setControlHeld(false)
      }
      connection.send({ type: 'input', data })
    }
    input.current = (data) => { sendInput(data); term.focus() }
    const typing = term.onData(sendInput)
    const resize = term.onResize(({ cols, rows }) => connection.send({ type: 'resize', cols, rows }))

    return () => {
      disposed = true
      connected.current = false
      ctrl.current = false
      setControlHeld(false)
      input.current = () => {}
      typing.dispose()
      resize.dispose()
      connection.dispose()
    }
  }, [path, retry, asleep])

  return (
    <section aria-label={`${title} terminal`} className={`terminal-panel ${fill ? 'is-fill' : ''}`}>
      <div className="terminal-heading">
        <h3>{title}</h3>
        <span role="status" className="terminal-status">
          <span className={`status-dot ${!asleep && state === 'connected' ? 'is-running' : ''}`} />
          {asleep ? asleepLabels[asleep] : labels[state]}
        </span>
      </div>
      <div ref={container} className="terminal-screen" />
      <div className="terminal-keys" aria-label="Terminal keyboard shortcuts">
        <button
          type="button" aria-pressed={controlHeld} disabled={!!asleep || state !== 'connected'}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => { ctrl.current = !ctrl.current; setControlHeld(ctrl.current) }}
        >Ctrl</button>
        {keys.map(([label, data]) => (
          <button
            key={label} type="button" disabled={!!asleep || state !== 'connected'}
            aria-label={`Send ${label}`} onPointerDown={(e) => e.preventDefault()}
            onClick={() => input.current(data)}
          >{label}</button>
        ))}
      </div>
      {asleep === 'paused' && <p className="terminal-note" role="status">This workspace is paused, with everything saved. Type anything here to wake it.</p>}
      {asleep === 'pausing' && <p className="terminal-note" role="status">Saving this workspace so it can pause. Typing here wakes it once that’s done.</p>}
      {!asleep && state === 'reconnecting' && <p className="terminal-note" role="status">Reattaching to your session. The process keeps running.</p>}
      {!asleep && state === 'exited' && <p className="terminal-note">This process has ended. Start a new session to continue.</p>}
      {!asleep && state === 'error' && <p className="terminal-note" role="alert">{detail}</p>}
      {!asleep && (state === 'error' || state === 'reconnecting') && (
        <button type="button" className="workspace-button secondary terminal-retry" onClick={() => setRetry((n) => n + 1)}>Reconnect now</button>
      )}
    </section>
  )
}
