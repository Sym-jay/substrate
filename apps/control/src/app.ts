import type { Health, HostStatus, Status } from '@substrate/protocol'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { vmRoutes, type VmRoutesOptions } from './vms.ts'

type Options = {
  version: string
  region: string
  webDir: string
  readHost: () => Promise<HostStatus>
  // The web app reads this at startup, so builds don't need it. Null: no sign-in.
  clerkPublishableKey: string | null
  // VM routes, or why there aren't any (no sandbox host, or no sign-in).
  vms: VmRoutesOptions | { unavailable: string }
}

export function createApp({ version, region, webDir, readHost, clerkPublishableKey, vms }: Options) {
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

  app.get('/api/config', (c) => c.json({ clerkPublishableKey }))

  if ('unavailable' in vms) {
    const { unavailable } = vms
    app.on(['GET', 'POST', 'DELETE'], ['/api/vms', '/api/vms/*'], (c) => c.json({ error: unavailable }, 503))
  } else {
    app.route('/api', vmRoutes(vms))
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
