// Executed on the sandbox host by check-m3, through SSM. Tokens stay on-host.
// Uses hostd's terminal relay, just like the browser, to prove shell memory and
// scrollback survived. The same PID alone wouldn't prove a restored process.
export {}
const [vmId, sessionId, phase, marker] = process.argv.slice(2)
if (!vmId || !sessionId || !marker || !['seed', 'verify'].includes(phase ?? '')) throw new Error('invalid probe arguments')
const token = (await Bun.file('/var/lib/substrate/hostd-token').text()).trim()
const ws = new WebSocket(`ws://127.0.0.1:7070/vms/${encodeURIComponent(vmId)}/sessions/${encodeURIComponent(sessionId)}/terminal`, {
  headers: { Authorization: `Bearer ${token}` },
})
let transcript = ''
let scrollback = ''
let sent = false
// Every verification needs fresh output, never a match from old scrollback.
const nonce = crypto.randomUUID()
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { ws.close(); reject(new Error(`terminal ${phase} timed out`)) }, 15_000)
  const fail = (message: string) => { clearTimeout(timer); reject(new Error(message)) }
  ws.onerror = () => fail('terminal connection failed')
  ws.onclose = () => fail('terminal closed before completing the probe')
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { type: string; scrollback?: string; data?: string }
    if (message.type === 'ready') scrollback = message.scrollback ?? ''
    transcript += message.type === 'ready' ? scrollback : message.data ?? ''
    if (message.type === 'ready' && !sent) {
      sent = true
      const command = phase === 'seed'
        ? `M3_MEMORY_MARKER=${marker}; printf %s "$M3_MEMORY_MARKER" > ~/m3-check.txt; printf '\\nM3_SEED:%s:%s\\n' "$M3_MEMORY_MARKER" "$$"\r`
        : `printf '\\nM3_VERIFY:${nonce}:%s:%s\\n' "$M3_MEMORY_MARKER" "$$"; printf '\\nM3_DISK:${nonce}:%s\\n' "$(cat ~/m3-check.txt)"\r`
      ws.send(JSON.stringify({ type: 'input', data: command }))
    }
    const prefix = phase === 'seed' ? `M3_SEED:${marker}` : `M3_VERIFY:${nonce}:${marker}`
    const pid = new RegExp(`${prefix}:(\\d+)`).exec(transcript)?.[1]
    if (pid && (phase === 'seed' || transcript.includes(`M3_DISK:${nonce}:${marker}`))) {
      clearTimeout(timer)
      ws.onclose = null
      ws.close()
      console.log(JSON.stringify({ pid: Number(pid), memory: true, disk: true, scrollback: scrollback.includes(`M3_SEED:${marker}:`) }))
      resolve()
    }
  }
})
