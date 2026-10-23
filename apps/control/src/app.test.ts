import { Health, Status } from '@substrate/protocol'
import { describe, expect, test } from 'bun:test'
import { createApp } from './app.ts'
import { toHostStatus } from './host.ts'

const options = {
  version: 'test',
  region: 'ap-south-1',
  webDir: 'does-not-exist',
  readHost: async () => ({ configured: false as const }),
  clerkPublishableKey: null,
  vms: { unavailable: 'no sandbox host configured' },
}
const app = createApp(options)

describe('control API', () => {
  test('health reports the version', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(Health.parse(await res.json())).toEqual({ ok: true, version: 'test' })
  })

  test('status works without a sandbox host', async () => {
    const res = await app.request('/api/status')
    const status = Status.parse(await res.json())
    expect(status.host).toEqual({ configured: false })
    expect(status.control.region).toBe('ap-south-1')
  })

  test('config tells the web app whether sign-in is on', async () => {
    expect(await (await app.request('/api/config')).json()).toEqual({ clerkPublishableKey: null })
    const withClerk = createApp({ ...options, clerkPublishableKey: 'pk_test_abc' })
    expect(await (await withClerk.request('/api/config')).json()).toEqual({ clerkPublishableKey: 'pk_test_abc' })
  })

  test('unknown API paths are JSON 404s, not the web app', async () => {
    const res = await app.request('/api/nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  test('without a host or sign-in, every VM route is off', async () => {
    const off = createApp({ ...options, vms: { unavailable: "sign-in isn't set up" } })
    for (const path of ['/api/vms', '/api/vms/vm-abc/sessions', '/api/vms/vm-abc/sessions/s/terminal']) {
      const res = await off.request(path)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "sign-in isn't set up" })
    }
    expect((await off.request('/api/vms', { method: 'POST', body: '{}' })).status).toBe(503)
  })

  test('host errors become a 500', async () => {
    const failing = createApp({
      ...options,
      readHost: async () => {
        throw new Error('ec2 down')
      },
    })
    const res = await failing.request('/api/status')
    expect(res.status).toBe(500)
  })
})

describe('toHostStatus', () => {
  test('a running host reports when it started', () => {
    const launched = new Date('2026-10-23T10:00:00Z')
    expect(
      toHostStatus({
        InstanceId: 'i-123',
        InstanceType: 'r8i.4xlarge',
        State: { Name: 'running' },
        LaunchTime: launched,
      }),
    ).toEqual({
      configured: true,
      instanceId: 'i-123',
      instanceType: 'r8i.4xlarge',
      state: 'running',
      launchedAt: launched.toISOString(),
    })
  })

  test('a stopped host has no start time', () => {
    const status = toHostStatus({
      InstanceId: 'i-123',
      InstanceType: 'r8i.4xlarge',
      State: { Name: 'stopped' },
      LaunchTime: new Date(),
    })
    expect(status.configured && status.launchedAt).toBeNull()
  })
})
