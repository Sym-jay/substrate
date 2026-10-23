import type { Health, HostStatus, Status } from '@substrate/protocol'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'

type Options = {
  version: string
  region: string
  webDir: string
  readHost: () => Promise<HostStatus>
}

export function createApp({ version, region, webDir, readHost }: Options) {
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
