import { ExecResult, GuestHealth } from '@substrate/protocol'
import { describe, expect, test } from 'bun:test'
import { createApp } from './app.ts'
import { exec, shellFor, withTimeout } from './exec.ts'
import { Sessions, TerminalSession, sessionArgv, withControllingTerminal } from './sessions.ts'

const token = 't'.repeat(40)
const auth = { Authorization: `Bearer ${token}` }

const app = createApp({
  vmId: 'vm-test',
  token,
  version: 'test',
  run: async (req) => ({ exitCode: 0, stdout: req.command, stderr: '', durationMs: 1, timedOut: false }),
  sessions: new Sessions(),
})

describe('guestd API', () => {
  test('rejects requests without the token', async () => {
    expect((await app.request('/health')).status).toBe(401)
    expect((await app.request('/health', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
  })

  test('health identifies the VM', async () => {
    const res = await app.request('/health', { headers: auth })
    expect(GuestHealth.parse(await res.json()).vmId).toBe('vm-test')
  })

  test('exec validates and runs the command', async () => {
    const res = await app.request('/exec', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'echo hi' }),
    })
    expect(ExecResult.parse(await res.json()).stdout).toBe('echo hi')

    const bad = await app.request('/exec', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ command: '' }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('sessions', () => {
  test('run as dev in a login shell, agents falling back to a shell', () => {
    const ctty = ['setsid', '--ctty', '--wait']
    expect(sessionArgv({})).toEqual([...ctty, 'runuser', '-l', 'dev'])
    expect(sessionArgv({ agent: 'claude' })).toEqual([...ctty, 'runuser', '-l', 'dev', '-c', 'claude; exec bash -l'])
  })

  test('reject unknown agents and missing sessions', async () => {
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'vim' }),
    })
    expect(res.status).toBe(400)
    expect((await app.request('/sessions/nope/terminal', { headers: auth })).status).toBe(404)
  })
})

// Linux only: macOS has no setsid(1), and guestd only runs in Linux VMs.
test.skipIf(process.platform !== 'linux')('Ctrl+C interrupts the foreground command', async () => {
  const session = new TerminalSession(null, withControllingTerminal(['bash', '--noprofile', '--norc', '-i']), '/tmp')
  let out = ''
  session.attach((m) => {
    if (m.type === 'output') out += m.data
  })
  const until = async (text: string) => {
    for (let i = 0; !out.includes(text); i++) {
      if (i > 200) throw new Error(`no ${text} in: ${out}`)
      await Bun.sleep(25)
    }
  }
  session.receive({ type: 'input', data: 'sleep 30\r' })
  await Bun.sleep(300)
  session.receive({ type: 'input', data: '\x03' })
  await Bun.sleep(200)
  session.receive({ type: 'input', data: 'echo after-$((2*3))\r' })
  await until('after-6')
  expect(out).not.toContain('no job control')
  session.stop()
})

describe('exec', () => {
  test('dev commands run through a login shell as dev', () => {
    expect(shellFor({ command: 'id', user: 'dev' })).toEqual(['runuser', '-l', 'dev', '-c', 'id'])
    expect(shellFor({ command: 'id', user: 'root' })).toEqual(['bash', '-lc', 'id'])
    expect(withTimeout(['true'], 1500)).toEqual(['timeout', '--kill-after=2', '1.5', 'true'])
  })

  test('captures output and exit code', async () => {
    const result = await exec(
      { command: '', user: 'root', timeoutMs: 5_000 },
      ['bash', '-c', 'echo out; echo err >&2; exit 3'],
    )
    expect(result).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false })
  })

  test('a command that overruns is killed', async () => {
    const result = await exec({ command: '', user: 'root', timeoutMs: 100 }, ['sleep', '30'])
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  }, 10_000)
})
