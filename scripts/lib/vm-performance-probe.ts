// Runs on the host through SSM. Reads its bearer token locally; outputs only
// performance results and test VM/session IDs. No production VM is modified.
import { execFileSync } from 'node:child_process'
const input = JSON.parse(Buffer.from(process.argv[2]!, 'base64').toString()) as {
  action: 'create' | 'warm' | 'cold' | 'diagnose'; id: string; size?: string; marker: string; sessionId?: string; expectedPid?: number; iterations?: number
}
const token = (await Bun.file('/var/lib/substrate/hostd-token').text()).trim()
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const since = Math.floor(Date.now() / 1000) - 1
async function call(path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:7070${path}`, { method: body === undefined ? 'GET' : 'POST', headers,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(360_000) })
  const data = await response.json()
  if (!response.ok) throw new Error(`hostd ${response.status}: ${(data as { error: string }).error}`)
  return data as any
}
async function terminal(sessionId: string, phase: 'seed' | 'verify') {
  const nonce = crypto.randomUUID()
  const socket = new WebSocket(`ws://127.0.0.1:7070/vms/${input.id}/sessions/${sessionId}/terminal`, { headers })
  return new Promise<{ pid: number; retained: boolean }>((resolve, reject) => {
    let transcript = '', history = '', sent = false
    const timer = setTimeout(() => { socket.close(); reject(new Error('terminal readiness timeout')) }, 15_000)
    const fail = () => { clearTimeout(timer); reject(new Error('terminal disconnected')) }
    socket.onerror = fail; socket.onclose = fail
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.type === 'ready') history = message.scrollback ?? ''
      transcript += message.type === 'ready' ? history : message.data ?? ''
      if (message.type === 'ready' && !sent) {
        sent = true
        const command = phase === 'seed'
          ? `PERF_MEMORY=${input.marker}; printf %s "$PERF_MEMORY" > ~/perf-marker; printf '\\nPERF_SEED:${input.marker}:%s\\n' "$$"\r`
          : `printf '\\nPERF_VERIFY:${nonce}:%s:%s:%s\\n' "$PERF_MEMORY" "$$" "$(cat ~/perf-marker)"\r`
        socket.send(JSON.stringify({ type: 'input', data: command }))
      }
      const match = phase === 'seed' ? new RegExp(`PERF_SEED:${input.marker}:(\\d+)`).exec(transcript)
        : new RegExp(`PERF_VERIFY:${nonce}:${input.marker}:(\\d+):${input.marker}`).exec(transcript)
      if (!match) return
      clearTimeout(timer); socket.onclose = null; socket.close()
      resolve({ pid: Number(match[1]), retained: phase === 'seed' || history.includes(`PERF_SEED:${input.marker}:`) })
    }
  })
}
const samples: unknown[] = []
let sessionId = input.sessionId
if (input.action === 'create') {
  const before = performance.now()
  const vm = await call('/vms', { targetId: input.id, name: `perf-${input.marker}-${input.size}-${input.id.slice(-4)}`, size: input.size, diskGib: 8 })
  const requestMs = performance.now() - before
  if (vm.state !== 'running' || vm.lastError) throw new Error('new VM is not healthy')
  const terminalBefore = performance.now()
  const session = await call(`/vms/${input.id}/sessions`, {})
  sessionId = session.id
  const proof = await terminal(session.id, 'seed')
  samples.push({ kind: 'create', image: vm.image, requestMs, terminalMs: performance.now() - terminalBefore, bootMs: vm.bootMs, proof })
} else if (input.action === 'warm' || input.action === 'cold') {
  if (!sessionId) throw new Error('missing retained session ID')
  for (let i = 0; i < (input.iterations ?? 1); i++) {
    if (input.action === 'warm') await call(`/vms/${input.id}/pause`, {})
    const before = performance.now(), vm = await call(`/vms/${input.id}/resume`, {})
    const requestMs = performance.now() - before
    if (vm.state !== 'running' || vm.lastError) throw new Error('restored VM is not healthy')
    const terminalBefore = performance.now(), proof = await terminal(sessionId, 'verify')
    if (!proof.retained || (input.expectedPid && proof.pid !== input.expectedPid)) throw new Error('saved process or scrollback was lost')
    samples.push({ kind: input.action, requestMs, terminalMs: performance.now() - terminalBefore, resumeMs: vm.resumeMs, pauseMs: vm.pauseMs, proof })
  }
} else {
  const result = await call(`/vms/${input.id}/exec`, { user: 'root', timeoutMs: 20_000,
    command: "systemd-analyze time; systemd-analyze critical-chain substrate-guestd.service; journalctl -b -u substrate-guestd -o short-monotonic --no-pager; cat /run/substrate-boot-profile.json 2>/dev/null || true; dmesg | tail -25" })
  samples.push({ kind: 'diagnose', stdout: result.stdout, exitCode: result.exitCode })
}
await Bun.sleep(100)
const logs = execFileSync('journalctl', ['-u', 'substrate-hostd', '--since', `@${since}`, '-o', 'cat', '--no-pager']).toString()
const profiles = logs.split('\n').filter(line => line.startsWith('vm.lifecycle ')).map(line => JSON.parse(line.slice(13))).filter(row => row.vmId === input.id)
console.log(JSON.stringify({ vmId: input.id, sessionId, samples, profiles }))
