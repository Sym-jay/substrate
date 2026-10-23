// M2's "done when", end to end on this machine: browser → control → hostd →
// guestd, with a real shell on a PTY. Only the VM itself is faked.
import { Session, TerminalOutput, type Vm } from '@substrate/protocol'
import { afterAll, expect, test } from 'bun:test'
import { websocket } from 'hono/bun'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp as createGuestd } from '../../guestd/src/app.ts'
import { Sessions } from '../../guestd/src/sessions.ts'
import { createApp as createHostd } from '../../hostd/src/app.ts'
import { guestClient } from '../../hostd/src/guest.ts'
import type { VmService } from '../../hostd/src/vms.ts'
import { createApp } from './app.ts'

const guestToken = 'g'.repeat(64)
const hostdToken = 'h'.repeat(64)
const shell = () => ['/bin/bash', '--noprofile', '--norc', '-i']

const guestd = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  websocket,
  fetch: createGuestd({
    vmId: 'vm-abc',
    token: guestToken,
    version: 'test',
    run: async () => {
      throw new Error('unused')
    },
    sessions: new Sessions(shell, mkdtempSync(join(tmpdir(), 'substrate-test-'))),
  }).fetch,
})

const unused = async (): Promise<never> => {
  throw new Error('unused')
}
const vms: VmService = {
  list: async () => [] as Vm[],
  get: unused,
  create: unused,
  start: unused,
  stop: unused,
  pause: unused,
  resume: unused,
  remove: unused,
  exec: unused,
  capacity: unused,
  guest: async () => guestClient('127.0.0.1', guestToken, guestd.port),
}
const hostd = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  websocket,
  fetch: createHostd({ token: hostdToken, version: 'test', image: async () => null, vms }).fetch,
})

const control = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  websocket,
  fetch: createApp({
    version: 'test',
    region: 'ap-south-1',
    webDir: 'does-not-exist',
    readHost: async () => ({ configured: false }),
    hostd: { url: `http://127.0.0.1:${hostd.port}`, token: hostdToken },
  }).fetch,
})

afterAll(() => {
  for (const server of [control, hostd, guestd]) server.stop(true)
})

// A browser tab: collects everything the terminal sends.
function open(sessionId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${control.port}/api/vms/vm-abc/sessions/${sessionId}/terminal`)
  const messages: TerminalOutput[] = []
  ws.onmessage = (event) => messages.push(TerminalOutput.parse(JSON.parse(String(event.data))))
  const text = () => messages.map((m) => (m.type === 'ready' ? m.scrollback : m.type === 'output' ? m.data : '')).join('')
  const until = async (done: () => boolean) => {
    for (let i = 0; !done(); i++) {
      if (i > 200) throw new Error(`timed out; got: ${text()}`)
      await Bun.sleep(25)
    }
  }
  const send = (data: string) => ws.send(JSON.stringify({ type: 'input', data }))
  return { ws, messages, text, until, send }
}

const ticks = (text: string) => Math.max(0, ...[...text.matchAll(/tick-(\d+)/g)].map((m) => Number(m[1])))

test('a session survives the tab closing, with its scrollback, and keeps running', async () => {
  const res = await fetch(`http://127.0.0.1:${control.port}/api/vms/vm-abc/sessions`, { method: 'POST', body: '{}' })
  expect(res.status).toBe(201)
  const session = Session.parse(await res.json())

  const first = open(session.id)
  await first.until(() => first.messages[0]?.type === 'ready')
  first.send('echo marker-$((6*7)); for i in $(seq 1 40); do echo tick-$i; sleep 0.05; done\r')
  await first.until(() => first.text().includes('marker-42') && ticks(first.text()) >= 2)
  first.ws.close()
  const seen = ticks(first.text())

  await Bun.sleep(500)

  // Another device opens the same session later.
  const second = open(session.id)
  await second.until(() => second.messages[0]?.type === 'ready')
  const ready = second.messages[0]!
  expect(ready.type === 'ready' && ready.state).toBe('running')
  const scrollback = ready.type === 'ready' ? ready.scrollback : ''
  expect(scrollback).toContain('marker-42')
  // Ticks printed while nobody was attached: the process kept running.
  expect(ticks(scrollback)).toBeGreaterThan(seen + 3)

  // And it still takes input.
  await second.until(() => second.text().includes('tick-40'))
  second.send('echo back-$((1+1))\r')
  await second.until(() => second.text().includes('back-2'))
  second.ws.close()

  const list = Session.array().parse(
    await (await fetch(`http://127.0.0.1:${control.port}/api/vms/vm-abc/sessions`)).json(),
  )
  expect(list.map((s) => [s.id, s.state])).toEqual([[session.id, 'running']])
}, 20_000)

test('a session that does not exist closes the socket', async () => {
  const tab = open('nope')
  const closed = await new Promise<number>((resolve) => tab.ws.addEventListener('close', (e) => resolve(e.code)))
  expect(closed).not.toBe(1000)
})
