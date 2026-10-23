// OpenSSH ProxyCommand: binary stdin/stdout over the control box's WSS relay.
// Download a scoped config from the workspace's SSH controls first.
import { chmod } from 'node:fs/promises'

const path = process.argv[2]
if (!path) throw new Error('usage: bun scripts/ssh-proxy.ts <downloaded-connection.json>')
await chmod(path, 0o600)
const config = await Bun.file(path).json() as { url?: string; expiresAt?: string }
const url = new URL(config.url ?? '')
if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('SSH needs WSS or a localhost development URL')
if (!config.expiresAt || Date.parse(config.expiresAt) <= Date.now()) throw new Error('SSH access expired. Download a new connection from Substrate.')
const ws = new WebSocket(url)
ws.binaryType = 'arraybuffer'
process.stdin.pause()
let drain: ReturnType<typeof setInterval> | undefined
ws.onopen = () => {
  process.stdin.on('data', (data) => {
    ws.send(data)
    if (ws.bufferedAmount > 1_048_576) {
      process.stdin.pause()
      drain ??= setInterval(() => {
        if (ws.bufferedAmount < 262_144) { clearInterval(drain); drain = undefined; process.stdin.resume() }
      }, 10)
    }
  })
  process.stdin.on('end', () => ws.close())
  process.stdin.resume()
}
ws.onmessage = (event) => {
  if (process.stdout.writableLength > 8_388_608) { ws.close(1013, 'SSH output is not being consumed'); return }
  process.stdout.write(typeof event.data === 'string' ? Buffer.from(event.data) : Buffer.from(event.data as ArrayBuffer))
}
ws.onerror = () => { console.error('SSH relay could not connect. Check the connection expiry and workspace.'); process.exitCode = 1 }
ws.onclose = () => { clearInterval(drain); process.stdin.destroy() }
