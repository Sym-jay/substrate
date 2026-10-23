import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { upgradeWebSocket } from 'hono/bun'
import { relayTo } from '@substrate/protocol/relay'
import type { Owners } from './owners.ts'
import type { Tickets } from './tickets.ts'
import type { Capabilities } from './capabilities.ts'

export const previewPort = (port: number) => Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 7000
export const previewPrefix = (vmId: string, port: number) => `/p/${encodeURIComponent(vmId)}/${port}`

export function previewRoutes({ hostd, owners, tickets, capabilities }: {
  hostd: { url: string; token: string }; owners: Owners; tickets: Tickets; capabilities: Capabilities
}) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    const match = /^\/p\/([a-zA-Z0-9_-]+)\/(\d+)\//.exec(c.req.path)
    if (!match || !previewPort(Number(match[2]))) return c.text('Preview not found', 404)
    const vmId = match[1]!, port = Number(match[2]), prefix = previewPrefix(vmId, port)
    const cookie = `__Secure-substrate-preview-${vmId}-${port}`
    const url = new URL(c.req.url)
    const bootstrap = url.searchParams.get('__substrate_ticket')
    if (bootstrap) {
      const userId = tickets.redeem(bootstrap, vmId, `preview:${port}`)
      if (!userId || owners.owner(vmId) !== userId) return c.text('This preview link expired. Open it again from Substrate.', 401)
      const credential = capabilities.issue({ userId, vmId, kind: 'preview', port })
      setCookie(c, cookie, credential.token, { path: prefix + '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 3600 })
      url.searchParams.delete('__substrate_ticket')
      c.header('cache-control', 'no-store')
      c.header('referrer-policy', 'no-referrer')
      return c.redirect(url.pathname + url.search, 303)
    }
    const grant = capabilities.read(getCookie(c, cookie) ?? '', 'preview', vmId, port)
    if (!grant || owners.owner(vmId) !== grant.userId) return c.text('Open this preview from your workspace in Substrate.', 401)
    await next()
  })

  app.all('/p/:id/:port/*', async (c) => {
    const vmId = c.req.param('id'), port = Number(c.req.param('port'))
    const prefix = previewPrefix(vmId, port)
    const original = new URL(c.req.url)
    // Dev servers configured with this base path must receive it too (Vite
    // otherwise redirects back to its base indefinitely).
    const path = original.pathname
    const target = new URL(`${hostd.url}/vms/${encodeURIComponent(vmId)}/preview/${port}${path}${original.search}`)
    const headers = new Headers(c.req.raw.headers)
    headers.set('authorization', `Bearer ${hostd.token}`)
    headers.delete('host')
    headers.delete('x-substrate-preview')
    headers.delete('origin')
    const cookies = headers.get('cookie')?.split(';').filter((cookie) => !cookie.trim().startsWith('__Secure-substrate-preview-')).join(';')
    if (cookies) headers.set('cookie', cookies); else headers.delete('cookie')
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket') {
      return upgradeWebSocket(() => relayTo(target.href.replace(/^http/, 'ws'), Object.fromEntries(headers)))(c, async () => {})
    }
    let response: Response
    try {
      response = await fetch(target, { method: c.req.method, headers,
        body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body, redirect: 'manual', signal: AbortSignal.timeout(60_000) })
    } catch { return c.text('The app is not responding. Check its port and start the dev server.', 502) }
    const outgoing = new Headers(response.headers)
    outgoing.set('cache-control', 'private, no-store')
    outgoing.set('referrer-policy', 'no-referrer')
    const location = outgoing.get('location')
    if (location?.startsWith('/') && !location.startsWith('//') && !location.startsWith(prefix)) outgoing.set('location', prefix + location)
    // App cookies stay inside this workspace's preview path.
    const cookiesOut = outgoing.getSetCookie()
    if (cookiesOut.length) {
      outgoing.delete('set-cookie')
      for (const value of cookiesOut) outgoing.append('set-cookie', value.replace(/;\s*Domain=[^;]*/ig, '').replace(/;\s*Path=[^;]*/ig, '') + `; Path=${prefix}/; Secure`)
    }
    return new Response(response.body, { status: response.status, headers: outgoing })
  })
  app.all('*', (c) => c.text('Preview not found', 404))
  return app
}
