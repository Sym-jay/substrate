import type { Socket } from 'bun'
import type { WSEvents } from 'hono/ws'

// The desktop: relays a browser's WebSocket (noVNC) to the workspace's VNC
// server, byte for byte, like websockify. The browser's input (keys, mouse)
// counts as using the workspace.
export function desktopRelay({ host, port = 5900, onInput = () => {} }: { host: string; port?: number; onInput?: () => void }): WSEvents {
  let socket: Socket | null = null
  let closed = false
  // What the browser sent before the VNC connection was up, or while it was full.
  const queue: Uint8Array[] = []
  const flush = () => {
    while (socket && queue.length) {
      const chunk = queue[0]!
      const written = socket.write(chunk)
      if (written < chunk.length) {
        queue[0] = chunk.subarray(Math.max(written, 0))
        return
      }
      queue.shift()
    }
  }

  return {
    onOpen: (_event, ws) => {
      Bun.connect({
        hostname: host,
        port,
        socket: {
          open(s) {
            if (closed) return void s.end()
            socket = s
            flush()
          },
          data(_s, data) {
            ws.send(new Uint8Array(data))
          },
          drain: flush,
          close() {
            if (!closed) ws.close(1000, 'the desktop closed')
          },
          error() {
            ws.close(1011, 'lost the desktop')
          },
        },
      }).catch(() => ws.close(1011, "couldn't reach the desktop"))
    },
    onMessage: (event) => {
      onInput()
      const { data } = event
      queue.push(typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as unknown as ArrayBufferLike))
      flush()
    },
    onClose: () => {
      closed = true
      socket?.end()
    },
  }
}
