import { TerminalOutput, type TerminalInput } from '@substrate/protocol'

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'exited' | 'error'
type Socket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'>
type Options = {
  url: string
  onMessage: (message: TerminalOutput) => void
  onState: (state: ConnectionState, detail?: string) => void
  socket?: (url: string) => Socket
  retryMs?: number
}

// Reconnection attaches to the same session; it never creates a new shell.
// A ready message replaces the screen with the server's scrollback on every attach.
export function connectTerminal({ url, onMessage, onState, socket = (url) => new WebSocket(url), retryMs = 1_000 }: Options) {
  let current: Socket | undefined
  let stopped = false
  let ready = false
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let unbind = () => {}

  const connect = () => {
    if (stopped) return
    ready = false
    onState(attempts ? 'reconnecting' : 'connecting')
    const ws = socket(url)
    current = ws
    const message = (event: Event) => {
      const parsed = TerminalOutput.safeParse(parseJson((event as MessageEvent).data))
      if (!parsed.success) {
        stopped = true
        ready = false
        onState('error', 'The terminal sent an invalid response. Reconnect to try again.')
        unbind()
        ws.close()
        return
      }
      if (parsed.data.type === 'ready') {
        ready = parsed.data.state === 'running'
        attempts = 0
        if (!ready) stopped = true
        onMessage(parsed.data)
        onState(ready ? 'connected' : 'exited')
      } else if (parsed.data.type === 'exit') {
        ready = false
        stopped = true
        onMessage(parsed.data)
        onState('exited')
      } else {
        onMessage(parsed.data)
      }
    }
    const close = () => {
      unbind()
      ready = false
      if (stopped) return
      attempts++
      onState('reconnecting')
      timer = setTimeout(connect, Math.min(retryMs * 2 ** Math.min(attempts - 1, 4), 15_000))
    }
    ws.addEventListener('message', message)
    ws.addEventListener('close', close)
    // WebSocket errors are followed by close; retry in exactly one place.
    unbind = () => {
      ws.removeEventListener('message', message)
      ws.removeEventListener('close', close)
    }
  }
  connect()

  return {
    send(message: TerminalInput) {
      if (!ready || current?.readyState !== WebSocket.OPEN) return false
      current.send(JSON.stringify(message))
      return true
    },
    dispose() {
      stopped = true
      ready = false
      clearTimeout(timer)
      unbind()
      current?.close()
    },
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return null
  try { return JSON.parse(value) } catch { return null }
}
