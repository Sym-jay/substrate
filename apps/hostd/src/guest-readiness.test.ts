import { expect, test } from 'bun:test'
import { guestClient, waitForGuest } from './guest.ts'

test('a cold guest can answer one slow health request without an abort/retry cycle', async () => {
  let calls = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
    calls++
    await Bun.sleep(350)
    return Response.json({ ok: true, vmId: 'vm-test', version: 'test', uptimeMs: 1 })
  } })
  try {
    const health = await waitForGuest(guestClient('127.0.0.1', 'test', server.port!), {
      timeoutMs: 2000, probeTimeoutMs: 1000, alive: async () => true,
    })
    expect(health.vmId).toBe('vm-test')
    expect(calls).toBe(1)
  } finally { server.stop(true) }
})

test('a longer per-probe timeout still respects the overall readiness deadline', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
    await Bun.sleep(1000)
    return Response.json({ ok: true, vmId: 'vm-test', version: 'test', uptimeMs: 1 })
  } })
  try {
    await expect(waitForGuest(guestClient('127.0.0.1', 'test', server.port!), {
      timeoutMs: 50, probeTimeoutMs: 1000, alive: async () => true,
    })).rejects.toThrow("guest didn't answer")
  } finally { server.stop(true) }
})

test('slow health failures check process liveness by elapsed time', async () => {
  let checks = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
    await Bun.sleep(600)
    return new Response('not ready', { status: 503 })
  } })
  try {
    await expect(waitForGuest(guestClient('127.0.0.1', 'test', server.port!), {
      timeoutMs: 5000, probeTimeoutMs: 1000, alive: async () => { checks++; return false },
    })).rejects.toThrow('the VM exited during boot')
    expect(checks).toBe(1)
  } finally { server.stop(true) }
})
