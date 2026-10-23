import { connect, type Socket } from 'node:net'
import type { WSEvents } from 'hono/ws'

const hopHeaders = ['authorization', 'host', 'connection', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'x-substrate-preview', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions']
export function appHeaders(input: Headers) {
  const headers = new Headers(input)
  for (const key of hopHeaders) headers.delete(key)
  return headers
}

export async function proxyHttp(request: Request, target: URL, prefix = '', onActivity?: () => void) {
  const response = await fetch(target, {
    method: request.method, headers: appHeaders(request.headers),
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual', signal: AbortSignal.timeout(30_000),
  })
  const headers = appHeaders(response.headers)
  const location = headers.get('location')
  if (prefix && location?.startsWith('/') && !location.startsWith('//') && !location.startsWith(prefix)) headers.set('location', prefix + location)
  headers.set('cache-control', 'private, no-store')
  const body = onActivity && response.body ? response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
    onActivity(); controller.enqueue(chunk)
  } })) : response.body
  return new Response(body, { status: response.status, headers })
}

// A WebSocket carrying raw TCP bytes (SSH, VNC). No public port is opened on either box.
export function tcpRelay(host: string, port: number, onActivity?: () => void, unavailable = 'SSH is not available; add your public key first'): WSEvents {
  let socket: Socket | undefined
  return {
    onOpen(_event, peer) {
      onActivity?.()
      socket = connect({ host, port })
      socket.on('data', (data) => {
        onActivity?.()
        if (peer.raw && (peer.raw as { getBufferedAmount?: () => number }).getBufferedAmount?.()! > 1_048_576) {
          peer.close(1013, 'client is too slow'); socket?.destroy(); return
        }
        peer.send(typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data))
      })
      socket.on('error', () => peer.close(1011, unavailable))
      socket.on('end', () => peer.close(1000))
    },
    onMessage(event, peer) {
      onActivity?.()
      if (!socket || socket.writableLength > 1_048_576) { peer.close(1013, 'connection is too slow'); return }
      const data = event.data
      socket.write(typeof data === 'string' ? Buffer.from(data) : Buffer.from(data as ArrayBuffer))
    },
    onClose() { socket?.destroy() },
    onError() { socket?.destroy() },
  }
}
