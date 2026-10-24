import { DEFAULT_EGRESS_ALLOWLIST, egressAllows } from '@substrate/protocol'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPublicAddress, parseProxyRequest, startEgressProxy, type EgressGrant } from './egress.ts'
import { firewallRules, namespaceAddresses, proxyAddress, slotAddresses, slotOfGuest } from './network.ts'
import { Tokens } from './tokens.ts'

const stops: (() => void)[] = []
afterAll(() => stops.forEach((stop) => stop()))

describe('allowlist', () => {
  test('hosts, wildcards and ports', () => {
    const allow = ['github.com', '*.npmjs.org', 'example.com:8443']
    expect(egressAllows(allow, 'github.com', 443)).toBe(true)
    expect(egressAllows(allow, 'GitHub.com.', 80)).toBe(true)
    expect(egressAllows(allow, 'github.com', 22)).toBe(false)
    expect(egressAllows(allow, 'api.github.com', 443)).toBe(false)
    expect(egressAllows(allow, 'registry.npmjs.org', 443)).toBe(true)
    // A wildcard is for names under the domain, not the domain itself or look-alikes.
    expect(egressAllows(allow, 'npmjs.org', 443)).toBe(false)
    expect(egressAllows(allow, 'evilnpmjs.org', 443)).toBe(false)
    expect(egressAllows(allow, 'example.com', 8443)).toBe(true)
    expect(egressAllows(allow, 'example.com', 443)).toBe(false)
    expect(egressAllows(DEFAULT_EGRESS_ALLOWLIST, 'api.anthropic.com', 443)).toBe(true)
    expect(egressAllows(DEFAULT_EGRESS_ALLOWLIST, 'github.com', 22)).toBe(true)
  })

  test('only public addresses', () => {
    for (const ip of ['169.254.169.254', '10.40.0.123', '172.31.0.1', '192.168.1.1', '127.0.0.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
      expect(isPublicAddress(ip)).toBe(false)
    for (const ip of ['1.1.1.1', '140.82.112.3', '2606:4700::1111']) expect(isPublicAddress(ip)).toBe(true)
  })

  test('proxy request lines', () => {
    expect(parseProxyRequest('CONNECT github.com:443 HTTP/1.1\r\n\r\n')).toEqual({ kind: 'connect', host: 'github.com', port: 443 })
    expect(parseProxyRequest('GET http://example.com/a?b=1 HTTP/1.1\r\nHost: example.com\r\n\r\n')).toMatchObject({ kind: 'http', host: 'example.com', port: 80, path: '/a?b=1' })
    expect(parseProxyRequest('GET /a HTTP/1.1\r\n\r\n')).toBeNull()
    expect(parseProxyRequest('CONNECT github.com HTTP/1.1\r\n\r\n')).toBeNull()
  })
})

describe('the egress proxy', () => {
  // An upstream that echoes what it gets, upper-cased; and a plain HTTP server.
  const echo = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data(s, d) { s.write(Buffer.from(d).toString().toUpperCase()) } } })
  const web = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => new Response(`hello from ${new URL(req.url).pathname} (${req.headers.get('connection')})`) })
  stops.push(() => echo.stop(true), () => web.stop(true))
  const denied: string[] = []
  const grants = new Map<string, EgressGrant>([['127.0.0.1', { vmId: 'vm-a', allow: ['allowed.test:' + echo.port, 'web.test:' + web.port] }]])
  const proxy = startEgressProxy({
    hostname: '127.0.0.1', port: 0,
    grantFor: async (ip) => grants.get(ip) ?? null,
    // Every test name resolves to loopback, which tests allow; the real check is above.
    resolve: async (host) => (host === 'private.test' ? ['10.0.0.5'] : ['127.0.0.1']),
    addressAllowed: (ip) => ip === '127.0.0.1',
    log: (line) => denied.push(line),
  })
  stops.push(() => proxy.stop(true))

  // Sends `request` through the proxy, then `then` once it answers; returns everything it got.
  async function through(request: string, then = '') {
    let got = ''
    let sent = false
    const done = Promise.withResolvers<string>()
    const socket = await Bun.connect({
      hostname: '127.0.0.1', port: proxy.port,
      socket: {
        data(s, d) {
          got += Buffer.from(d).toString()
          if (!sent && then && got.includes('\r\n\r\n')) { sent = true; s.write(then) }
        },
        close() { done.resolve(got) },
      },
    })
    socket.write(request)
    setTimeout(() => { socket.end(); done.resolve(got) }, 500)
    return done.promise
  }

  test('CONNECT to an allowed host tunnels', async () => {
    const got = await through(`CONNECT allowed.test:${echo.port} HTTP/1.1\r\nHost: allowed.test\r\n\r\n`, 'ping')
    expect(got).toStartWith('HTTP/1.1 200 Connection Established\r\n\r\n')
    expect(got).toEndWith('PING')
  })

  test('anything else is refused, and logged against the VM', async () => {
    expect(await through('CONNECT other.test:443 HTTP/1.1\r\n\r\n')).toStartWith('HTTP/1.1 403')
    expect(denied.at(-1)).toBe('egress vm-a: denied other.test:443')
  })

  test("a name that resolves to a private address is refused (the host's metadata service, say)", async () => {
    grants.set('127.0.0.1', { vmId: 'vm-a', allow: 'any' })
    expect(await through('CONNECT private.test:443 HTTP/1.1\r\n\r\n')).toStartWith('HTTP/1.1 403')
    expect(await through('CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n')).toStartWith('HTTP/1.1 403')
    grants.set('127.0.0.1', { vmId: 'vm-a', allow: ['allowed.test:' + echo.port, 'web.test:' + web.port] })
  })

  test('a plain HTTP request is forwarded, one per connection', async () => {
    const got = await through(`GET http://web.test:${web.port}/path HTTP/1.1\r\nHost: web.test\r\nProxy-Connection: keep-alive\r\n\r\n`)
    expect(got).toStartWith('HTTP/1.1 200')
    expect(got).toContain('hello from /path (close)')
  })

  test('unknown sources and non-proxy requests are refused', async () => {
    expect(await through('GET / HTTP/1.1\r\n\r\n')).toStartWith('HTTP/1.1 400')
    grants.delete('127.0.0.1')
    expect(await through(`CONNECT allowed.test:${echo.port} HTTP/1.1\r\n\r\n`)).toStartWith('HTTP/1.1 403')
  })
})

describe('jailed networking', () => {
  test("a namespace's addresses, and where its guest finds the proxy", () => {
    expect(namespaceAddresses(3)).toEqual({ netns: 'sbxns3', hostVeth: 'vh3', nsVeth: 'vn3', vethHostIp: '172.31.0.13', vethNsIp: '172.31.0.14', tap: 'tap0' })
    expect(proxyAddress(3, true)).toBe('172.31.0.13')
    expect(proxyAddress(3, false)).toBe(slotAddresses(3).hostIp)
  })

  test('guests are found by their address', () => {
    expect(slotOfGuest(slotAddresses(5).guestIp)).toBe(5)
    expect(slotOfGuest(`::ffff:${slotAddresses(0).guestIp}`)).toBe(0)
    expect(slotOfGuest(slotAddresses(5).hostIp)).toBeNull()
    expect(slotOfGuest('10.40.0.1')).toBeNull()
  })

  test('the firewall treats jailed VMs like the rest, and lets allowlisted ones out only through the proxy', () => {
    const rules = firewallRules('ens5')
    for (const dev of ['sbx*', 'vh*']) {
      expect(rules).toContain(`iifname "${dev}" tcp dport 3128 accept`)
      expect(rules).toContain(`iifname "${dev}" drop`)
      expect(rules).toContain(`iifname "${dev}" oifname "ens5" accept`)
    }
    // Before anything is accepted.
    expect(rules.indexOf('iifname @proxied drop')).toBeLessThan(rules.indexOf('oifname "ens5" accept'))
  })
})

describe('tokens', () => {
  test('the current and, during a rotation, the previous token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hostd-tokens-'))
    stops.push(() => void rm(dir, { recursive: true, force: true }))
    let now = 0
    const tokens = new Tokens({ current: join(dir, 'current'), previous: join(dir, 'previous') }, () => now)
    const first = await tokens.init()
    expect(await tokens.verify(first)).toBe(true)
    expect(await tokens.verify('nope')).toBe(false)
    await Bun.write(join(dir, 'previous'), first)
    await Bun.write(join(dir, 'current'), 'rotated')
    now += 31_000
    expect(await tokens.verify('rotated')).toBe(true)
    expect(await tokens.verify(first)).toBe(true)
  })
})
