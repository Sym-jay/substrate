import { ExecResult, GuestActivity, GuestHealth } from '@substrate/protocol'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Activity, cpuSampler } from './activity.ts'
import { createApp } from './app.ts'
import { interpret, sendEvent, serveEvents } from './events.ts'
import { exec, shellFor, withTimeout } from './exec.ts'
import { Sessions, TerminalSession, sessionArgv, withControllingTerminal } from './sessions.ts'

const token = 't'.repeat(40)
const auth = { Authorization: `Bearer ${token}` }

const agentEnvs: unknown[] = []
const app = createApp({
  vmId: 'vm-test',
  token,
  version: 'test',
  run: async (req) => ({ exitCode: 0, stdout: req.command, stderr: '', durationMs: 1, timedOut: false }),
  sessions: new Sessions(),
  activity: new Activity(),
  agentEnv: async (env) => { agentEnvs.push(env) },
})

describe('agent keys', () => {
  const put = (body: unknown) => app.request('/agent-env', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  test('only the agent key variables, with key-like values', async () => {
    expect((await put({ ANTHROPIC_API_KEY: 'sk-ant-api03-abc_DEF-123' })).status).toBe(204)
    expect(agentEnvs.at(-1)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api03-abc_DEF-123' })
    expect((await put({ LD_PRELOAD: '/tmp/x.so' })).status).toBe(400)
    expect((await put({ OPENAI_API_KEY: "sk-x'; rm -rf ~; '" })).status).toBe(400)
    expect((await app.request('/agent-env', { method: 'PUT', body: '{}' })).status).toBe(401)
  })
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
    expect(sessionArgv({}).slice(0, 5)).toEqual([...ctty, 'runuser', '-l'])
    expect(sessionArgv({ agent: 'claude' }).at(-1)).toContain('claude --permission-mode default; exec bash -l')
    expect(sessionArgv({ agent: 'claude', mode: 'auto' }).at(-1)).toContain('--dangerously-skip-permissions')
    expect(sessionArgv({ agent: 'codex', mode: 'auto' }).at(-1)).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(sessionArgv({ agent: 'codex' }).at(-1)).toContain('--ask-for-approval on-request')
    expect(sessionArgv({ agent: 'opencode' }).at(-1)).toContain('"permission":"ask"')
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

test('closing a session ends it and forgets it', async () => {
  const sessions = new Sessions(() => ['sleep', '30'], '/tmp')
  const session = sessions.create({})!
  expect(sessions.list()).toHaveLength(1)
  expect(sessions.close(session.id)).toBe(true)
  expect(sessions.list()).toEqual([])
  expect(await session.exited).not.toBe(0)
  expect(sessions.close(session.id)).toBe(false)
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

describe('activity', () => {
  test('idle time restarts on activity, and events record how long nobody typed', () => {
    let now = 1_000
    const activity = new Activity(() => now)
    now += 60_000
    expect(activity.report().idleMs).toBe(60_000)
    activity.record({ agent: 'claude', kind: 'start', message: null })
    activity.input()
    now += 5_000
    activity.touch()
    now += 30_000
    activity.record({ agent: 'claude', kind: 'stop', message: null })
    now += 1_000
    const report = activity.report()
    expect(report.idleMs).toBe(1_000)
    // Nobody had typed before the first event.
    expect(report.events).toMatchObject([{ seq: 1, inputIdleMs: null }, { seq: 2, agent: 'claude', kind: 'stop', inputIdleMs: 35_000 }])
  })

  test('keeps only the latest events', () => {
    const activity = new Activity()
    for (let i = 0; i < 60; i++) activity.record({ agent: 'codex', kind: 'stop', message: null })
    const { events } = activity.report()
    expect(events).toHaveLength(50)
    expect(events[0]!.seq).toBe(11)
    expect(events[0]!.inputIdleMs).toBeNull()
  })

  test('is served to hostd with the token', async () => {
    expect((await app.request('/activity')).status).toBe(401)
    const res = await app.request('/activity', { headers: auth })
    expect(GuestActivity.parse(await res.json()).events).toEqual([])
  })
})

test('the CPU sampler counts busy CPUs since the last sample', async () => {
  // user nice system idle iowait irq softirq steal, then two CPUs.
  const stats = ['cpu  100 0 100 800 0 0 0 0\ncpu0 x\ncpu1 x\n', 'cpu  150 0 100 1150 0 0 0 100\ncpu0 x\ncpu1 x\n']
  const sample = cpuSampler(async () => stats.shift()!)
  expect(await sample()).toBe(0)
  // 50 busy of 500 jiffies, over 2 CPUs; stolen time isn't the VM's work.
  expect(await sample()).toBeCloseTo(0.2)
})

describe('agent events', () => {
  test('Claude Code alerts only for notifications that need you', () => {
    const attention = (payload: unknown) => interpret({ agent: 'claude', kind: 'attention', payload })
    expect(attention({ notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }))
      .toEqual({ agent: 'claude', kind: 'attention', message: 'Claude needs your permission to use Bash' })
    expect(attention({ notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })).toBeNull()
    expect(attention({ message: 'x'.repeat(500) })?.message).toHaveLength(200)
    expect(interpret({ agent: 'claude', kind: 'stop', payload: { last_assistant_message: 'secret' } }))
      .toEqual({ agent: 'claude', kind: 'stop', message: null })
  })

  test("Codex's turn-complete is a stop; other notify types are skipped", () => {
    expect(interpret({ agent: 'codex', kind: 'stop', payload: { type: 'agent-turn-complete' } })?.kind).toBe('stop')
    expect(interpret({ agent: 'codex', kind: 'stop', payload: { type: 'something-new' } })).toBeNull()
  })

  test('substrate-event reaches guestd over its socket', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guestd-'))
    const socket = join(dir, 'events.sock')
    const activity = new Activity()
    await serveEvents(activity, socket)
    try {
      expect(await sendEvent(['codex', 'stop', '{"type":"agent-turn-complete"}'], socket)).toBe(0)
      expect(await sendEvent(['vim', 'stop', '{}'], socket)).toBe(0)
      expect(activity.report().events).toMatchObject([{ agent: 'codex', kind: 'stop' }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// Ends every session and waits until the list on disk says so.
async function stopAll(sessions: Sessions) {
  const all = sessions.list().map((s) => sessions.get(s.id)!)
  for (const s of all) s.stop()
  await Promise.all(all.map((s) => s.exited))
  await Bun.sleep(50)
}

describe('reopening sessions after a restart', () => {
  test('agents resume their last conversation', () => {
    const ctty = ['setsid', '--ctty', '--wait']
    expect(sessionArgv({ agent: 'claude' }, true)).toEqual([...ctty, 'runuser', '-l', 'dev', '-c', 'if [ -d /home/dev/workspace ]; then cd /home/dev/workspace; fi; claude --continue --permission-mode default; exec bash -l'])
    expect(sessionArgv({ agent: 'codex' }, true).at(-1)).toBe('if [ -d /home/dev/workspace ]; then cd /home/dev/workspace; fi; codex resume --last --sandbox workspace-write --ask-for-approval on-request; exec bash -l')
    expect(sessionArgv({}, true)).toEqual([...ctty, 'runuser', '-l', 'dev', '-c', 'if [ -d /home/dev/workspace ]; then cd /home/dev/workspace; fi; exec bash -l'])
  })

  test('running sessions come back under the same IDs, only when asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guestd-'))
    const file = join(dir, 'state', 'sessions.json')
    const started: [string | undefined, boolean][] = []
    const argv = (req: { agent?: string }, resume = false) => {
      started.push([req.agent, resume])
      return ['sleep', '30']
    }
    try {
      const before = new Sessions(argv, dir, undefined, file)
      await before.start(false)
      const shell = before.create({})!
      const agent = before.create({ agent: 'claude', mode: 'auto', checkpointId: 'ebea20af-a0cb-4f58-96de-d450915a14f5' })!
      const ended = before.create({})!
      ended.stop()
      await ended.exited
      await Bun.sleep(50)
      // The VM crashes: the file still lists what was running then.
      const crashed = await Bun.file(file).text()
      await stopAll(before)
      await Bun.write(file, crashed)

      // The VM crashed: the next guestd reopens what was running.
      const after = new Sessions(argv, dir, undefined, file)
      await after.start(true)
      expect(after.list().map((s) => [s.id, s.agent]).sort()).toEqual([[shell.id, null], [agent.id, 'claude']].sort())
      expect(started.slice(-2).map(([agent, resume]) => `${agent ?? 'shell'}:${resume}`).sort()).toEqual(['claude:true', 'shell:true'])
      let scrollback = ''
      after.get(agent.id)!.attach((m) => { if (m.type === 'ready') scrollback = m.scrollback })
      expect(scrollback).toContain("Continuing claude's last conversation")
      expect(after.get(agent.id)!.info.mode).toBe('auto')
      expect(after.get(agent.id)!.info.checkpointId).toBe('ebea20af-a0cb-4f58-96de-d450915a14f5')
      await stopAll(after)

      // A normal boot starts empty, and forgets the old list.
      const fresh = new Sessions(argv, dir, undefined, file)
      await fresh.start(false)
      expect(fresh.list()).toEqual([])
      const later = new Sessions(argv, dir, undefined, file)
      await later.start(true)
      expect(later.list()).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
