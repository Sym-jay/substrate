import { DEFAULT_EGRESS_ALLOWLIST, egressAllows } from '@substrate/protocol'
import type { Socket } from 'bun'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// What a guest may reach: a list of hosts, or anywhere public.
export type EgressGrant = { vmId: string; allow: readonly string[] | 'any' }

type Options = {
  hostname?: string
  port: number
  // The VM behind a source address, and its grant; null for anything else.
  grantFor: (sourceIp: string) => Promise<EgressGrant | null>
  resolve?: (host: string) => Promise<string[]>
  // Whether the proxy may connect to this address. Never the host's own
  // networks or its instance metadata service, whatever a name resolves to.
  addressAllowed?: (ip: string) => boolean
  log?: (message: string) => void
}

type Conn = {
  head: Uint8Array
  // The request head has been read; what follows goes to the upstream.
  parsed: boolean
  upstream: Socket<Conn> | null
  // Bytes waiting for the other side to take them.
  toUpstream: Uint8Array[]
  toClient: Uint8Array[]
  done: boolean
}

const MAX_HEAD = 16 * 1024
const IDLE_SECONDS = 600

// Private, loopback, link-local (169.254.169.254 is the metadata service),
// shared, multicast and reserved addresses, in both families.
export function isPublicAddress(ip: string) {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (isIP(v4) === 4) {
    const [a = 0, b = 0] = v4.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)))
  }
  const lower = ip.toLowerCase()
  return isIP(ip) === 6 && !(lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff'))
}

// The request line of a proxy request: CONNECT host:port, or an absolute URL.
export function parseProxyRequest(head: string) {
  const line = head.slice(0, head.indexOf('\r\n'))
  const [method = '', target = '', version = ''] = line.split(' ')
  if (!/^HTTP\/1\.[01]$/.test(version)) return null
  if (method === 'CONNECT') {
    const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(target)
    return match ? { kind: 'connect' as const, host: match[1]!, port: Number(match[2]) } : null
  }
  if (!/^http:\/\//i.test(target)) return null
  const url = URL.parse(target)
  if (!url) return null
  return { kind: 'http' as const, host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80), method, path: `${url.pathname}${url.search}`, version }
}

// The guests' HTTP(S) proxy for allowlisted egress, like a small Squid: an
// allowlisted VM can't reach the internet any other way (see network.ts).
export function startEgressProxy({ hostname = '0.0.0.0', port, grantFor, resolve = resolveAll, addressAllowed = isPublicAddress, log = console.log }: Options) {
  const reply = (socket: Socket<Conn>, status: string, body: string) => {
    socket.data.done = true
    socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
  }
  const send = (to: Socket<Conn> | null, queue: Uint8Array[], data: Uint8Array) => {
    if (!to || queue.length) return void queue.push(data)
    const written = to.write(data)
    if (written < data.length) queue.push(data.subarray(Math.max(written, 0)))
  }
  const flush = (to: Socket<Conn>, queue: Uint8Array[]) => {
    while (queue.length) {
      const chunk = queue[0]!
      const written = to.write(chunk)
      if (written < chunk.length) return void (queue[0] = chunk.subarray(Math.max(written, 0)))
      queue.shift()
    }
  }

  async function open(client: Socket<Conn>, head: string, rest: Uint8Array) {
    const request = parseProxyRequest(head)
    if (!request) return reply(client, '400 Bad Request', 'Substrate: send proxy requests (CONNECT host:port, or an absolute http:// URL).\n')
    const grant = await grantFor(client.remoteAddress)
    if (!grant) return reply(client, '403 Forbidden', 'Substrate: unknown source.\n')
    const target = `${request.host}:${request.port}`
    const allowed = grant.allow === 'any'
      ? request.port > 0 && request.port < 65536
      : egressAllows([...DEFAULT_EGRESS_ALLOWLIST, ...grant.allow], request.host, request.port)
    if (!allowed) {
      log(`egress ${grant.vmId}: denied ${target}`)
      return reply(client, '403 Forbidden', `Substrate: this workspace's egress allowlist doesn't include ${target}.\n`)
    }
    const addresses = isIP(request.host) ? [request.host] : await resolve(request.host).catch(() => [])
    const address = addresses.find((ip) => isIP(ip) === 4 && addressAllowed(ip)) ?? addresses.find(addressAllowed)
    if (!address) {
      log(`egress ${grant.vmId}: denied ${target}: ${addresses.length ? 'not a public address' : "doesn't resolve"}`)
      return reply(client, '403 Forbidden', `Substrate: ${request.host} ${addresses.length ? "isn't a public address" : "doesn't resolve"}.\n`)
    }
    const first = request.kind === 'connect' ? rest : Buffer.concat([Buffer.from(rewriteHead(head, request.method, request.path, request.version)), rest])
    await Bun.connect<Conn>({
      hostname: address,
      port: request.port,
      data: client.data,
      socket: {
        open(upstream) {
          if (client.data.done) return void upstream.end()
          client.data.upstream = upstream
          upstream.timeout(IDLE_SECONDS)
          if (request.kind === 'connect') client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (first.length) send(upstream, client.data.toUpstream, first)
          flush(upstream, client.data.toUpstream)
        },
        data(_upstream, data) {
          send(client, client.data.toClient, data)
        },
        drain(upstream) {
          flush(upstream, client.data.toUpstream)
        },
        close() {
          client.data.done = true
          client.end()
        },
        error() {
          client.end()
        },
        connectError() {
          reply(client, '502 Bad Gateway', `Substrate: couldn't connect to ${target}.\n`)
        },
        timeout(upstream) {
          upstream.end()
        },
      },
    }).catch(() => reply(client, '502 Bad Gateway', `Substrate: couldn't connect to ${target}.\n`))
  }

  return Bun.listen<Conn>({
    hostname,
    port,
    socket: {
      open(client) {
        client.data = { head: new Uint8Array(0), parsed: false, upstream: null, toUpstream: [], toClient: [], done: false }
        client.timeout(IDLE_SECONDS)
      },
      data(client, data) {
        const conn = client.data
        if (conn.done) return
        // Until the upstream is open, send() queues.
        if (conn.parsed) return void send(conn.upstream, conn.toUpstream, data)
        conn.head = Buffer.concat([conn.head, data])
        const end = Buffer.from(conn.head).indexOf('\r\n\r\n')
        if (end === -1) {
          if (conn.head.length > MAX_HEAD) reply(client, '431 Request Header Fields Too Large', 'Substrate: request head too large.\n')
          return
        }
        conn.parsed = true
        const head = Buffer.from(conn.head.subarray(0, end + 4)).toString('latin1')
        const rest = conn.head.subarray(end + 4)
        conn.head = new Uint8Array(0)
        void open(client, head, rest).catch((err: Error) => reply(client, '502 Bad Gateway', `Substrate: ${err.message}\n`))
      },
      drain(client) {
        flush(client, client.data.toClient)
      },
      close(client) {
        client.data.done = true
        client.data.upstream?.end()
      },
      error(client) {
        client.data.upstream?.end()
      },
      timeout(client) {
        client.end()
      },
    },
  })
}

// An absolute-form request's head, as the origin server expects it.
function rewriteHead(head: string, method: string, path: string, version: string) {
  const lines = head.split('\r\n')
  const headers = lines.slice(1).filter((line) => line && !/^(proxy-connection|proxy-authorization|connection|keep-alive):/i.test(line))
  // One request per connection: a second one could name another host.
  return `${method} ${path} ${version}\r\n${headers.join('\r\n')}\r\nConnection: close\r\n\r\n`
}

async function resolveAll(host: string) {
  return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)
}
