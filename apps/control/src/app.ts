import type { Health, HostStatus, Status } from '@substrate/protocol'
import { relayTo } from '@substrate/protocol/relay'
import { Hono, type Context } from 'hono'
import { serveStatic, upgradeWebSocket } from 'hono/bun'

type Options = {
  version: string
  region: string
  webDir: string
  readHost: () => Promise<HostStatus>
  // Unset in local development, where there is no sandbox host.
  hostd: { url: string; token: string } | null
  // Serve VM routes even though nobody has logged in (local development only).
  vmsWithoutLogin: boolean
}

export function createApp({ version, region, webDir, readHost, hostd, vmsWithoutLogin }: Options) {
  const startedAt = new Date().toISOString()
  const app = new Hono()

  app.get('/api/health', (c) => c.json({ ok: true, version } satisfies Health))

  app.get('/api/status', async (c) => {
    const status: Status = {
      control: { version, region, startedAt },
      host: await readHost(),
    }
    return c.json(status)
  })

  // VMs and their terminals are hostd's: pass them through, adding its token.
  const vmPaths = ['/api/vms', '/api/vms/*']
  if (!hostd) {
    app.on(['GET', 'POST', 'DELETE'], vmPaths, (c) => c.json({ error: 'no sandbox host configured' }, 503))
  } else if (!vmsWithoutLogin) {
    app.on(['GET', 'POST', 'DELETE'], vmPaths, (c) =>
      c.json({ error: 'VMs need a login, which is not built yet. Use `bun run dev --host` meanwhile.' }, 503),
    )
  } else {
    const auth = { Authorization: `Bearer ${hostd.token}` }
    const hostdPath = (c: Context) => c.req.path.replace(/^\/api/, '')

    app.get(
      '/api/vms/:id/sessions/:session/terminal',
      upgradeWebSocket((c) => relayTo(`${hostd.url.replace(/^http/, 'ws')}${hostdPath(c)}`, auth)),
    )

    app.on(['GET', 'POST', 'DELETE'], vmPaths, async (c) => {
      const res = await fetch(`${hostd.url}${hostdPath(c)}`, {
        method: c.req.method,
        headers: { ...auth, 'content-type': 'application/json' },
        body: c.req.method === 'POST' ? await c.req.text() : undefined,
      }).catch(() => null)
      if (!res) return c.json({ error: "can't reach the sandbox host. Is it running?" }, 502)
      return new Response(res.body, {
        status: res.status,
        headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
      })
    })
  }

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  // The web app, with every other path falling back to index.html.
  app.use('/*', serveStatic({ root: webDir }))
  app.get('/*', serveStatic({ root: webDir, path: 'index.html' }))

  app.onError((err, c) => {
    console.error(err)
    return c.json({ error: 'internal error' }, 500)
  })

  return app
}
