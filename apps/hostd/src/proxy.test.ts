import { expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { tcpRelay } from './proxy.ts'

test('OpenSSH proxy transports arbitrary bytes over WebSocket to TCP', async () => {
  const echo = createServer((socket) => socket.pipe(socket))
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
  const port = (echo.address() as { port: number }).port
  const app = new Hono().get('/ssh', upgradeWebSocket(() => tcpRelay('127.0.0.1', port)))
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, websocket, fetch: app.fetch })
  const directory = await mkdtemp(join(tmpdir(), 'substrate-ssh-test-'))
  const config = join(directory, 'connection.json')
  await Bun.write(config, JSON.stringify({ url: `ws://127.0.0.1:${server.port}/ssh`, expiresAt: new Date(Date.now() + 60_000).toISOString() }))
  const child = Bun.spawn([process.execPath, new URL('../../../scripts/ssh-proxy.ts', import.meta.url).pathname, config], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  try {
    const bytes = new Uint8Array(Array.from({ length: 65536 }, (_, index) => index % 256))
    child.stdin.write(bytes)
    child.stdin.flush()
    const reader = child.stdout.getReader()
    const output: Uint8Array[] = []
    let size = 0
    while (size < bytes.length) {
      const item = await reader.read()
      if (item.done) throw new Error('SSH stream ended early')
      output.push(item.value); size += item.value.length
    }
    expect(Buffer.concat(output)).toEqual(Buffer.from(bytes))
    child.stdin.end()
    expect(await child.exited).toBe(0)
  } finally {
    child.kill()
    server.stop(true)
    await new Promise<void>((resolve) => echo.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)
