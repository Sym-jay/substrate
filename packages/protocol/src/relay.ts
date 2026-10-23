// Relays a WebSocket to an upstream one, frame for frame: control → hostd → guestd.
// Returns Hono `upgradeWebSocket` events. Bun-only (WebSocket headers).

type Peer = { send(data: string): void; close(code?: number, reason?: string): void }

// Codes that only describe a close and can't be sent in one.
const unsendable = new Set([1005, 1006, 1015])

export function relayTo(url: string, headers: Record<string, string>) {
  let upstream: WebSocket | undefined
  // Frames from the client before the upstream is open.
  const pending: string[] = []

  return {
    onOpen(_event: Event, client: Peer) {
      const ws = new WebSocket(url, { headers })
      upstream = ws
      ws.onopen = () => {
        for (const data of pending.splice(0)) ws.send(data)
      }
      ws.onmessage = (event) => client.send(String(event.data))
      ws.onclose = (event) => client.close(unsendable.has(event.code) ? 1011 : event.code, event.reason)
    },
    onMessage(event: MessageEvent, _client: Peer) {
      const data = String(event.data)
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(data)
      else pending.push(data)
    },
    onClose() {
      upstream?.close()
    },
  }
}
