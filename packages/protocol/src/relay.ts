// Relays a WebSocket to an upstream one, frame for frame: control → hostd → guestd.
// Returns Hono `upgradeWebSocket` events. Bun-only (WebSocket headers).

type Frame = string | ArrayBuffer | Uint8Array
type Peer = { send(data: Frame): void; close(code?: number, reason?: string): void }

// Codes that only describe a close and can't be sent in one.
const unsendable = new Set([1005, 1006, 1015])

export function relayTo(url: string, headers: Record<string, string>) {
  let upstream: WebSocket | undefined
  // Frames from the client before the upstream is open.
  const pending: Frame[] = []
  let pendingBytes = 0
  let closed = false
  const bytes = (data: Frame) => typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
  const limit = 8 * 1024 * 1024

  return {
    onOpen(_event: Event, client: Peer) {
      const ws = new WebSocket(url, { headers })
      ws.binaryType = 'arraybuffer'
      upstream = ws
      ws.onopen = () => {
        if (closed) { ws.close(); return }
        for (const data of pending.splice(0)) ws.send(data)
        pendingBytes = 0
      }
      ws.onmessage = (event) => client.send(event.data as Frame)
      ws.onclose = (event) => client.close(unsendable.has(event.code) ? 1011 : event.code, event.reason)
      ws.onerror = () => client.close(1011, 'upstream connection failed')
    },
    onMessage(event: MessageEvent, client: Peer) {
      const data = event.data as Frame
      if (closed) return
      if (pendingBytes + (upstream?.bufferedAmount ?? 0) + bytes(data) > limit) {
        closed = true
        client.close(1013, 'connection is too slow')
        upstream?.close()
        pending.length = 0
        return
      }
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(data)
      else { pending.push(data); pendingBytes += bytes(data) }
    },
    onClose() {
      closed = true
      pending.length = 0
      upstream?.close()
    },
  }
}
