import { Vm } from '@substrate/protocol'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { computeCapacity, parseMemTotalMib } from './capacity.ts'
import { vmLogs } from './logs.ts'
import { bootArgs, firecrackerConfig } from './firecracker.ts'
import { Mutex } from './mutex.ts'
import { firewallRules, lowestFreeSlot, slotAddresses } from './network.ts'
import { HttpError, newVmId, type VmService } from './vms.ts'

describe('network', () => {
  test('each slot gets its own /30', () => {
    expect(slotAddresses(0)).toEqual({
      tap: 'sbx0',
      hostIp: '172.30.0.1',
      guestIp: '172.30.0.2',
      mac: '06:00:ac:1e:00:02',
    })
    expect(slotAddresses(1)).toMatchObject({ hostIp: '172.30.0.5', guestIp: '172.30.0.6' })
    expect(slotAddresses(64)).toMatchObject({ tap: 'sbx64', guestIp: '172.30.1.2', mac: '06:00:ac:1e:01:02' })
    expect(() => slotAddresses(-1)).toThrow()
    expect(() => slotAddresses(16_384)).toThrow()
  })

  test('slots are reused from the lowest free one', () => {
    expect(lowestFreeSlot([])).toBe(0)
    expect(lowestFreeSlot([0, 1, 3])).toBe(2)
  })

  test('VMs only reach the internet', () => {
    const rules = firewallRules('ens5')
    expect(rules).toContain('iifname "sbx*" drop')
    expect(rules).toContain('169.254.0.0/16')
    expect(rules).toContain('ip saddr 172.30.0.0/16 oifname "ens5" masquerade')
  })
})

describe('firecracker config', () => {
  const spec = {
    id: 'vm-abc',
    hostname: 'demo',
    vcpus: 6,
    memMib: 16_384,
    kernel: '/k/vmlinux',
    rootDevice: '/dev/zvol/substrate/vms/vm-abc/root',
    ...slotAddresses(3),
  }

  test('the kernel configures eth0 itself', () => {
    expect(bootArgs(spec)).toContain('ip=172.30.0.14::172.30.0.13:255.255.255.252:demo:eth0:off')
  })

  test('maps the VM onto Firecracker settings', () => {
    const cfg = firecrackerConfig(spec)
    expect(cfg['machine-config']).toEqual({ vcpu_count: 6, mem_size_mib: 16_384, smt: false })
    expect(cfg.drives[0]).toMatchObject({ path_on_host: spec.rootDevice, is_root_device: true, cache_type: 'Writeback' })
    expect(cfg['network-interfaces'][0]).toEqual({ iface_id: 'eth0', guest_mac: spec.mac, host_dev_name: 'sbx3' })
    expect(cfg['mmds-config'].network_interfaces).toEqual(['eth0'])
    expect(cfg.balloon).toEqual({ amount_mib: 12_288, deflate_on_oom: true, stats_polling_interval_s: 1, free_page_reporting: true })
    expect(firecrackerConfig({ ...spec, memMib: 4096 }).balloon.amount_mib).toBe(0)
  })
})

describe('capacity', () => {
  test('reads MemTotal', () => {
    expect(parseMemTotalMib('MemTotal:       131072000 kB\nMemFree: 1 kB\n')).toBe(128_000)
  })

  test('free memory leaves the host its reserve', () => {
    expect(
      computeCapacity({ memTotalMib: 126_000, memReservedMib: 4_096, memUsedMib: 16_384, vcpus: 16 }).memFreeMib,
    ).toBe(105_520)
    expect(computeCapacity({ memTotalMib: 8_000, memReservedMib: 4_096, memUsedMib: 16_384, vcpus: 2 }).memFreeMib).toBe(0)
  })
})

describe('mutex', () => {
  test('runs sections one at a time, even after a failure', async () => {
    const mutex = new Mutex()
    const order: string[] = []
    const slow = mutex.run(async () => {
      await Bun.sleep(20)
      order.push('a')
    })
    const failing = mutex.run(async () => {
      order.push('b')
      throw new Error('boom')
    })
    const last = mutex.run(async () => order.push('c'))
    await Promise.allSettled([slow, failing, last])
    expect(order).toEqual(['a', 'b', 'c'])
  })
})

test('VM ids are short and URL-safe', () => {
  expect(newVmId()).toMatch(/^vm-[a-z2-7]{8}$/)
})

describe('hostd API', () => {
  const token = 'h'.repeat(64)
  const vm: Vm = {
    id: 'vm-abc',
    name: 'demo',
    vcpus: 6,
    memMib: 16_384,
    diskGib: 32,
    state: 'running',
    image: '20261023-000000',
    guestIp: '172.30.0.2',
    createdAt: '2026-10-23T00:00:00.000Z',
    startedAt: '2026-10-23T00:00:00.000Z',
    bootMs: 1800,
    lastError: null,
  }
  const created: unknown[] = []
  const fake: VmService = {
    list: async () => [vm],
    get: async (id) => {
      if (id !== vm.id) throw new HttpError(404, `no VM ${id}`)
      return vm
    },
    create: async (input) => {
      created.push(input)
      return vm
    },
    start: async () => vm,
    stop: async () => ({ ...vm, state: 'stopped' }),
    pause: async () => ({ ...vm, state: 'paused' }),
    resume: async () => ({ ...vm, state: 'running' }),
    update: async (_id, input) => ({ ...vm, ...input }),
    resize: async () => vm,
    fork: async () => vm,
    checkpoints: async () => [],
    rollback: async () => vm,
    createSession: async () => { throw new HttpError(409, 'demo isn\'t running') },
    growDisk: async (_id, input) => ({ ...vm, ...input }),
    remove: async () => {},
    exec: async (_id, req) => ({ exitCode: 0, stdout: req.user, stderr: '', durationMs: 5, timedOut: false }),
    guest: async () => {
      throw new HttpError(409, 'demo isn\'t running')
    },
    capacity: async () => ({ vcpus: 16, memTotalMib: 126_000, memReservedMib: 4_096, memUsedMib: 0, memFreeMib: 121_904 }),
  }
  const app = createApp({ token, version: 'test', image: async () => '20261023-000000', vms: fake })
  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    })

  test('everything needs the token', async () => {
    expect((await app.request('/vms')).status).toBe(401)
  })

  test('health reports the current image and the storage pool', async () => {
    expect(await (await call('/health')).json()).toEqual({ ok: true, version: 'test', image: '20261023-000000', pool: null })
    const withPool = createApp({
      token, version: 'test', image: async () => null, vms: fake,
      pool: async () => ({ health: 'ONLINE', sizeGib: 49, usedPct: 23 }),
    })
    const res = await withPool.request('/health', { headers: { Authorization: `Bearer ${token}` } })
    expect(((await res.json()) as { pool: unknown }).pool).toEqual({ health: 'ONLINE', sizeGib: 49, usedPct: 23 })
  })

  test("a VM's logs: its console and hostd's lines about it, within limits", async () => {
    const asked: string[][] = []
    const withLogs = createApp({
      token, version: 'test', image: async () => null, vms: fake,
      logs: (id, lines) => vmLogs(id, lines, async (args) => {
        asked.push(args)
        return args.includes('--grep') ? '-- Boot 382961d920a647489c447e07d3079f2c --\nstarted vm-abc\n' : '-- No entries --\n'
      }),
    })
    const get = (path: string) => withLogs.request(path, { headers: { Authorization: `Bearer ${token}` } })
    expect(await (await get('/vms/vm-abc/logs?lines=50')).json()).toEqual({ console: '', host: 'started vm-abc' })
    expect(asked[0]).toEqual(['-u', 'substrate-vm-vm-abc', '-n', '50'])
    expect(asked[1]).toEqual(['-u', 'substrate-hostd', '-n', '50', '--grep', 'vm-abc'])
    await get('/vms/vm-abc/logs?lines=999999')
    expect(asked[2]).toContain('2000')
    expect((await get('/vms/vm-nope/logs')).status).toBe(404)
  })

  describe('desktop and SSH keys', () => {
    const commands: string[] = []
    let stateOut = 'off'
    let open = false
    const started: string[] = []
    const withGuest = createApp({
      token, version: 'test', image: async () => null,
      vms: {
        ...fake,
        start: async (id) => { started.push(id); return vm },
        exec: async (_id, req) => { commands.push(req.command); return { exitCode: 0, stdout: stateOut, stderr: '', durationMs: 1, timedOut: false } },
      },
      probe: async (host, port) => open && host === vm.guestIp && port === 5900,
    })
    const req = (path: string, init: RequestInit = {}) =>
      withGuest.request(path, { ...init, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' } })

    test("a VM's desktop is ready when VNC answers, and otherwise says why not", async () => {
      expect(await (await req('/vms/vm-abc/gui')).json()).toEqual({ state: 'off', available: false })
      stateOut = 'setting-up\n'
      expect(await (await req('/vms/vm-abc/gui')).json()).toEqual({ state: 'setting-up', available: false })
      open = true
      expect(await (await req('/vms/vm-abc/gui')).json()).toEqual({ state: 'ready', available: true })
      open = false
    })

    test('setting up a desktop runs the bundled script in the background', async () => {
      commands.length = 0
      const res = await req('/vms/vm-abc/gui/setup', { method: 'POST' })
      expect(await res.json()).toEqual({ state: 'setting-up', available: false })
      expect(commands[0]).toContain('systemd-run --unit=substrate-desktop-setup')
      const encoded = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d >\/var\/lib\/substrate-desktop\/setup\.sh/.exec(commands[0]!)?.[1]
      const script = Buffer.from(encoded!, 'base64').toString()
      expect(script).toContain('x11vnc -display :1 -rfbport 5900')
      // It must at least be valid bash.
      const check = Bun.spawnSync(['bash', '-n'], { stdin: Buffer.from(script) })
      expect(check.exitCode).toBe(0)
    })

    test('account keys are validated, and can start the VM first', async () => {
      commands.length = 0
      const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOxzQ7 me@laptop'
      expect((await req('/vms/vm-abc/ssh/keys', { method: 'PUT', body: JSON.stringify({ publicKeys: ['not a key'] }) })).status).toBe(400)
      expect((await req('/vms/vm-abc/ssh/keys', { method: 'PUT', body: JSON.stringify({ publicKeys: [key], start: true }) })).status).toBe(200)
      expect(started).toContain('vm-abc')
      expect(commands[0]).toContain(Buffer.from(`# substrate:begin (keys from your Substrate account)\n${key}\n# substrate:end\n`).toString('base64'))
    })
  })

  test('the key sync replaces only its own block of authorized_keys', async () => {
    const { sshSyncCommand } = await import('./desktop.ts')
    const dir = await mkdtemp(join(tmpdir(), 'keys-'))
    const file = join(dir, 'authorized_keys')
    const run = async (keys: string[]) => {
      // The command, minus what needs root or systemd, against a temporary file.
      const script = sshSyncCommand(keys).split('\n')
        .filter((line) => !/^(install|chown|chmod|systemctl)/.test(line))
        .join('\n').replace('f=/home/dev/.ssh/authorized_keys', `f=${file}`)
      expect(Bun.spawnSync(['bash', '-c', script]).exitCode).toBe(0)
      return readFile(file, 'utf8')
    }
    await writeFile(file, 'ssh-ed25519 AAAAhand-added mine\n')
    expect(await run(['ssh-ed25519 AAAAone a', 'ssh-rsa AAAAtwo b'])).toBe('ssh-ed25519 AAAAhand-added mine\n# substrate:begin (keys from your Substrate account)\nssh-ed25519 AAAAone a\nssh-rsa AAAAtwo b\n# substrate:end\n')
    expect(await run(['ssh-rsa AAAAtwo b'])).toBe('ssh-ed25519 AAAAhand-added mine\n# substrate:begin (keys from your Substrate account)\nssh-rsa AAAAtwo b\n# substrate:end\n')
    expect(await run([])).toBe('ssh-ed25519 AAAAhand-added mine\n')
  })

  test('a disk can only be grown to a sensible size', async () => {
    const grow = (body: unknown) => call('/vms/vm-abc/disk', { method: 'POST', body: JSON.stringify(body) })
    expect(Vm.parse(await (await grow({ diskGib: 64 })).json()).diskGib).toBe(64)
    expect((await grow({ diskGib: 4 })).status).toBe(400)
    expect((await grow({})).status).toBe(400)
  })

  test('create validates its input', async () => {
    expect((await call('/vms', { method: 'POST', body: JSON.stringify({ size: 'huge' }) })).status).toBe(400)
    expect((await call('/vms', { method: 'POST', body: JSON.stringify({ name: 'Bad Name' }) })).status).toBe(400)
    const res = await call('/vms', { method: 'POST', body: JSON.stringify({ name: 'demo', size: 'small' }) })
    expect(res.status).toBe(201)
    expect(created.at(-1)).toEqual({ name: 'demo', size: 'small' })
  })

  test('disk sizes are whole GiB within bounds', async () => {
    const create = (diskGib: unknown) => call('/vms', { method: 'POST', body: JSON.stringify({ diskGib }) })
    expect((await create(4)).status).toBe(400)
    expect((await create(2_000)).status).toBe(400)
    expect((await create(12.5)).status).toBe(400)
    expect((await create(64)).status).toBe(201)
    expect(created.at(-1)).toEqual({ diskGib: 64 })
  })

  test('unknown VMs are 404s', async () => {
    const res = await call('/vms/vm-nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no VM vm-nope' })
  })

  test('exec defaults to the dev user', async () => {
    const res = await call('/vms/vm-abc/exec', { method: 'POST', body: JSON.stringify({ command: 'whoami' }) })
    expect(((await res.json()) as { stdout: string }).stdout).toBe('dev')
  })

  test('sessions need a running VM', async () => {
    const res = await call('/vms/vm-abc/sessions')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "demo isn't running" })
  })

  test('pause and resume return the updated lifecycle state', async () => {
    expect(Vm.parse(await (await call('/vms/vm-abc/pause', { method: 'POST' })).json()).state).toBe('paused')
    expect(Vm.parse(await (await call('/vms/vm-abc/resume', { method: 'POST' })).json()).state).toBe('running')
  })

  test('auto-pause can be changed or turned off, within limits', async () => {
    const patch = (body: unknown) => call('/vms/vm-abc', { method: 'PATCH', body: JSON.stringify(body) })
    expect(Vm.parse(await (await patch({ autoPauseMinutes: 30 })).json()).autoPauseMinutes).toBe(30)
    expect(Vm.parse(await (await patch({ autoPauseMinutes: null })).json()).autoPauseMinutes).toBeNull()
    expect((await patch({ autoPauseMinutes: 0 })).status).toBe(400)
    expect((await patch({})).status).toBe(400)
    expect(Vm.parse(await (await patch({ maxAwakeHours: 48 })).json()).maxAwakeHours).toBe(48)
    expect((await patch({ maxAwakeHours: 0 })).status).toBe(400)
  })

  test('delete returns no content', async () => {
    expect((await call('/vms/vm-abc', { method: 'DELETE' })).status).toBe(204)
  })
})
