import { Vm } from '@substrate/protocol'
import { describe, expect, test } from 'bun:test'
import { createApp } from './app.ts'
import { computeCapacity, parseMemTotalMib } from './capacity.ts'
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

  test('health reports the current image', async () => {
    expect(await (await call('/health')).json()).toEqual({ ok: true, version: 'test', image: '20261023-000000' })
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
  })

  test('delete returns no content', async () => {
    expect((await call('/vms/vm-abc', { method: 'DELETE' })).status).toBe(204)
  })
})
