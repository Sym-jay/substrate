import { ExecResult, GuestHealth } from '@substrate/protocol'
import { describe, expect, test } from 'bun:test'
import { createApp } from './app.ts'
import { exec, shellFor, withTimeout } from './exec.ts'

const token = 't'.repeat(40)
const auth = { Authorization: `Bearer ${token}` }

describe('guestd API', () => {
  const app = createApp({
    vmId: 'vm-test',
    token,
    version: 'test',
    run: async (req) => ({ exitCode: 0, stdout: req.command, stderr: '', durationMs: 1, timedOut: false }),
  })

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
