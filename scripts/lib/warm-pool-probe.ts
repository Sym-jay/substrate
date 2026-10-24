// Runs on the host through SSM (see benchmark-warm-pool.ts). Claims VMs from
// the warm pool, times each claim and a first terminal command in it, and
// deletes them again. Reads hostd's token locally; prints timings and the
// test VMs' IDs only.
import { execFileSync } from 'node:child_process'
const input = JSON.parse(Buffer.from(process.argv[2]!, 'base64').toString()) as {
  vcpus: number; memMib: number; diskGib: number; count: number; parallel: boolean; marker: string
}
const token = (await Bun.file('/var/lib/substrate/hostd-token').text()).trim()
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const since = Math.floor(Date.now() / 1000) - 1
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:7070${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) })
  const data = response.status === 204 ? null : await response.json()
  return { status: response.status, data: data as any }
}
// Waits until the pool has this many of the size ready.
async function ready(count: number) {
  const end = Date.now() + 600_000
  for (;;) {
    const sizes = (await call('GET', '/pool')).data as { vcpus: number; memMib: number; diskGib: number; ready: number }[]
    const size = sizes.find((s) => s.vcpus === input.vcpus && s.memMib === input.memMib && s.diskGib === input.diskGib)
    if (!size) throw new Error('the warm pool has no VMs of this size; set SUBSTRATE_WARM_POOL')
    if (size.ready >= count) return
    if (Date.now() > end) throw new Error(`the pool didn't fill to ${count} in time (${size.ready} ready)`)
    await Bun.sleep(500)
  }
}
// A first command in a new session, start to answer.
// Its hostname, as the guest reports it, to check the rename took.
async function terminal(vmId: string) {
  const before = performance.now()
  const session = (await call('POST', `/vms/${vmId}/sessions`, {})).data as { id: string }
  const nonce = crypto.randomUUID()
  const socket = new WebSocket(`ws://127.0.0.1:7070/vms/${vmId}/sessions/${session.id}/terminal`, { headers })
  const hostname = await new Promise<string>((resolve, reject) => {
    let transcript = '', sent = false
    const timer = setTimeout(() => { socket.close(); reject(new Error('terminal timeout')) }, 15_000)
    socket.onerror = () => { clearTimeout(timer); reject(new Error('terminal failed')) }
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      transcript += message.type === 'ready' ? message.scrollback ?? '' : message.data ?? ''
      if (message.type === 'ready' && !sent) {
        sent = true
        // printf, so the command the terminal echoes back can't match: only
        // its output has the nonce right before the name.
        socket.send(JSON.stringify({ type: 'input', data: `printf 'WARM_%s_%s\\n' ${nonce} "$(hostname)"\r` }))
      }
      const match = new RegExp(`WARM_${nonce}_(\\S+)`).exec(transcript)
      if (match) { clearTimeout(timer); socket.onclose = null; socket.close(); resolve(match[1]!) }
    }
  })
  return { terminalMs: performance.now() - before, hostname }
}
const claimed: string[] = []
const samples: { claimMs: number; hit: boolean; terminalMs?: number; named?: boolean }[] = []
const check = async (r: { claimMs: number; hit: boolean; id: string | null }, i: number) => {
  if (!r.id) return { claimMs: r.claimMs, hit: false }
  const t = await terminal(r.id)
  return { claimMs: r.claimMs, hit: true, terminalMs: t.terminalMs, named: t.hostname === `warm-${input.marker}-${i}` }
}
const claim = async (i: number) => {
  const before = performance.now()
  const res = await call('POST', '/vms/claim', { name: `warm-${input.marker}-${i}`, vcpus: input.vcpus, memMib: input.memMib, diskGib: input.diskGib, claimedBy: `benchmark-${input.marker}` })
  const claimMs = performance.now() - before
  if (res.status === 201) claimed.push(res.data.id)
  return { claimMs, hit: res.status === 201, id: res.status === 201 ? res.data.id as string : null }
}
try {
  if (input.parallel) {
    await ready(input.count)
    const results = await Promise.all(Array.from({ length: input.count }, (_, i) => claim(i)))
    for (const [i, r] of results.entries()) samples.push(await check(r, i))
  } else {
    for (let i = 0; i < input.count; i++) {
      await ready(1)
      samples.push(await check(await claim(i), i))
    }
  }
} finally {
  for (const id of claimed) await call('DELETE', `/vms/${id}`).catch(() => {})
}
await Bun.sleep(100)
const logs = execFileSync('journalctl', ['-u', 'substrate-hostd', '--since', `@${since}`, '-o', 'cat', '--no-pager']).toString()
const profiles = logs.split('\n').filter((line) => line.startsWith('vm.lifecycle ')).map((line) => JSON.parse(line.slice(13)))
  .filter((row) => row.operation === 'claim' && claimed.includes(row.vmId))
console.log(JSON.stringify({ claimed, samples, profiles }))
