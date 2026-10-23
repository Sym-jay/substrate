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

export function TerminalView({ path, title }: { path: string; title: string }) {
  const container = useRef<HTMLDivElement>(null)
  const input = useRef<(data: string) => void>(() => {})
  const ctrl = useRef(false)
  const [controlHeld, setControlHeld] = useState(false)
  const [state, setState] = useState<ConnectionState>('connecting')
  const [detail, setDetail] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!container.current) return
    let disposed = false
    let frame = 0
    let connected = false
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 14,
      lineHeight: 1.3,
      scrollback: 10_000,
      screenReaderMode: true,
      theme: {
        background: '#18181b', foreground: '#f4f4f5', cursor: '#f4f4f5',
        selectionBackground: '#52525b', black: '#27272a', brightBlack: '#a1a1aa',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container.current)
    fit.fit()

    const connection = connectTerminal({
      url: () => workspaceApi.terminalUrl(path),
      onState(next, message) {
        if (disposed) return
        connected = next === 'connected'
        term.options.disableStdin = !connected
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
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { if (!disposed && connected) fit.fit() })
    })
    observer.observe(container.current)

    return () => {
      disposed = true
      ctrl.current = false
      input.current = () => {}
      cancelAnimationFrame(frame)
      observer.disconnect()
      typing.dispose()
      resize.dispose()
      connection.dispose()
      term.dispose()
    }
  }, [path, retry])

  return (
    <section aria-label={`${title} terminal`} className="terminal-panel">
      <div className="terminal-heading">
        <h3>{title}</h3>
        <span role="status" className="terminal-status">
          <span className={`status-dot ${state === 'connected' ? 'is-running' : ''}`} />
          {labels[state]}
        </span>
      </div>
      <div ref={container} className="terminal-screen" />
      <div className="terminal-keys" aria-label="Terminal keyboard shortcuts">
        <button
          type="button" aria-pressed={controlHeld} disabled={state !== 'connected'}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => { ctrl.current = !ctrl.current; setControlHeld(ctrl.current) }}
        >Ctrl</button>
        {keys.map(([label, data]) => (
          <button
            key={label} type="button" disabled={state !== 'connected'}
            aria-label={`Send ${label}`} onPointerDown={(e) => e.preventDefault()}
            onClick={() => input.current(data)}
          >{label}</button>
        ))}
      </div>
      {state === 'reconnecting' && <p className="terminal-note" role="status">Reattaching to your session. The process keeps running.</p>}
      {state === 'exited' && <p className="terminal-note">This process has ended. Start a new session to continue.</p>}
      {state === 'error' && <p className="terminal-note" role="alert">{detail}</p>}
      {(state === 'error' || state === 'reconnecting') && (
        <button type="button" className="workspace-button secondary terminal-retry" onClick={() => setRetry((n) => n + 1)}>Reconnect now</button>
      )}
    </section>
  )
}
