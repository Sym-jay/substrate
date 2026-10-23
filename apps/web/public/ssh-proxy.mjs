#!/usr/bin/env node
// Substrate's SSH proxy. It carries an SSH connection to one of your
// workspaces over the control box's WebSocket, so nothing needs an open port.
// SSH itself still runs end to end with your own key. Use it as OpenSSH's
// ProxyCommand (Substrate shows this under SSH access):
//
//   Host *.substrate
//     User dev
//     ProxyCommand node ~/.substrate/ssh-proxy.mjs %h
//
// then `ssh my-workspace.substrate`. It reads ~/.substrate/config.json,
// {"url": "https://…", "token": "sbs_…"}, or SUBSTRATE_URL and SUBSTRATE_TOKEN.
// Needs Node 22 or later, or Bun.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const fail = (message) => { process.stderr.write(`substrate ssh: ${message}\n`); process.exit(1) }
const target = process.argv[2]
if (!target) fail('usage: ssh-proxy.mjs <workspace>[.substrate]')
if (typeof WebSocket === 'undefined') fail('this needs Node 22 or later (or Bun)')

let config = {}
try { config = JSON.parse(readFileSync(join(homedir(), '.substrate', 'config.json'), 'utf8')) } catch {}
const base = process.env.SUBSTRATE_URL ?? config.url
const token = process.env.SUBSTRATE_TOKEN ?? config.token
if (!base || !token) fail('set url and token in ~/.substrate/config.json (Substrate shows both under SSH access)')

const url = new URL(`/api/ssh/connect/${encodeURIComponent(target.replace(/\.substrate$/, ''))}`, base)
url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
const reasons = {
  4401: 'that SSH token is wrong or revoked; make a new one in Substrate',
  4404: `you have no workspace called ${target}`,
  4409: 'add your SSH public key to your Substrate account first',
}

const ws = new WebSocket(url)
ws.binaryType = 'arraybuffer'
let drain
ws.onopen = () => {
  // The token goes first, so it's never in a URL or a log.
  ws.send(JSON.stringify({ token }))
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
}
ws.onmessage = (event) => {
  process.stdout.write(typeof event.data === 'string' ? Buffer.from(event.data) : Buffer.from(event.data))
}
ws.onclose = (event) => {
  clearInterval(drain)
  const reason = reasons[event.code] ?? (event.code !== 1000 && event.code !== 1005 ? event.reason || `connection closed (${event.code})` : null)
  if (reason) process.stderr.write(`substrate ssh: ${reason}\n`)
  process.exit(reason ? 1 : 0)
}
ws.onerror = () => {}
