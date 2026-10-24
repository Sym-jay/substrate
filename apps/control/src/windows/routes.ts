import { CreateWindowsWorkspace, UpdateWindowsWorkspace } from '@substrate/protocol'
import { Hono, type MiddlewareHandler } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import type { Authenticate, User } from '../auth.ts'
import type { Tickets } from '../tickets.ts'
import { desktopRelay } from './desktop.ts'
import { WindowsError, type WindowsWorkspaces } from './workspaces.ts'

type Env = { Variables: { user: User } }

const DESKTOP = 'desktop'

// Windows workspaces, for signed-in users and only their own.
export function windowsRoutes({ authenticate, workspaces, tickets }: { authenticate: Authenticate; workspaces: WindowsWorkspaces; tickets: Tickets }) {
  const app = new Hono<Env>()

  // ── WebSockets: a one-time ticket, since browsers can't add headers to them ──
  const redeem = (id: string, session: string): MiddlewareHandler<Env> => async (c, next) => {
    const user = tickets.redeem(c.req.query('ticket') ?? '', c.req.param(id)!, session === DESKTOP ? DESKTOP : c.req.param(session)!)
    if (!user) return c.json({ error: 'missing or expired ticket' }, 401)
    c.set('user', { id: user })
    await next()
  }
  app.get('/windows/:id/terminals/:terminal', redeem('id', 'terminal'), async (c, next) => {
    if (!workspaces.terminal(c.req.param('id'), c.req.param('terminal'))) return c.json({ error: 'no such terminal' }, 404)
    await next()
  }, upgradeWebSocket((c) => {
    const terminal = workspaces.terminal(c.req.param('id')!, c.req.param('terminal')!)!
    let detach = () => {}
    return {
      onOpen: (_event, ws) => {
        detach = terminal.attach((message) => ws.send(JSON.stringify(message)))
      },
      onMessage: (event, ws) => {
        let message: unknown = null
        try { message = JSON.parse(String(event.data)) } catch {}
        if (!terminal.receive(message)) ws.close(1003, 'invalid terminal message')
      },
      onClose: () => detach(),
    }
  }))
  app.get('/windows/:id/desktop', redeem('id', DESKTOP), async (c, next) => {
    try { await workspaces.desktop(c.var.user.id, c.req.param('id')) } catch (err) { return c.json({ error: (err as Error).message }, 409) }
    await next()
  }, upgradeWebSocket(async (c) => {
    const id = c.req.param('id')!
    const { host, port } = await workspaces.desktop((c.var as Env['Variables']).user.id, id)
    return desktopRelay({ host, port, onInput: () => workspaces.touch(id) })
  }))

  // ── Everything else: signed in ──
  const signedIn: MiddlewareHandler<Env> = async (c, next) => {
    const user = await authenticate(c.req.raw)
    if (!user) return c.json({ error: 'sign in first' }, 401)
    c.set('user', user)
    await next()
  }
  app.use('/windows', signedIn)
  app.use('/windows/*', signedIn)

  app.get('/windows', async (c) => c.json(await workspaces.list(c.var.user.id)))
  app.post('/windows', async (c) => {
    const input = CreateWindowsWorkspace.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: input.error.issues[0]?.message ?? 'invalid workspace' }, 400)
    return c.json(await workspaces.create(c.var.user.id, input.data), 201)
  })
  app.patch('/windows/:id', async (c) => {
    const input = UpdateWindowsWorkspace.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: input.error.issues[0]?.message ?? 'invalid settings' }, 400)
    return c.json(await workspaces.update(c.var.user.id, c.req.param('id'), input.data))
  })
  app.post('/windows/:id/start', async (c) => c.json(await workspaces.start(c.var.user.id, c.req.param('id'))))
  app.post('/windows/:id/stop', async (c) => c.json(await workspaces.stop(c.var.user.id, c.req.param('id'))))
  app.delete('/windows/:id', async (c) => {
    await workspaces.remove(c.var.user.id, c.req.param('id'))
    return c.body(null, 204)
  })
  app.get('/windows/:id/credentials', async (c) => c.json(await workspaces.credentials(c.var.user.id, c.req.param('id'))))

  app.get('/windows/:id/terminals', async (c) => c.json(await workspaces.terminals(c.var.user.id, c.req.param('id'))))
  app.post('/windows/:id/terminals', async (c) => c.json((await workspaces.createTerminal(c.var.user.id, c.req.param('id'))).info, 201))
  app.post('/windows/:id/terminals/:terminal/ticket', async (c) => {
    const id = c.req.param('id')
    await workspaces.own(c.var.user.id, id)
    return c.json({ ticket: tickets.issue({ userId: c.var.user.id, vmId: id, sessionId: c.req.param('terminal') }) })
  })
  // The VNC password goes to the browser: noVNC signs in with it.
  app.post('/windows/:id/desktop/ticket', async (c) => {
    const id = c.req.param('id')
    const { password } = await workspaces.desktop(c.var.user.id, id)
    return c.json({ ticket: tickets.issue({ userId: c.var.user.id, vmId: id, sessionId: DESKTOP }), password })
  })

  app.onError((err, c) => {
    if (err instanceof WindowsError) return c.json({ error: err.message }, err.status)
    console.error(`${c.req.method} ${c.req.path}: ${err.message}`)
    return c.json({ error: err.message }, 502)
  })

  return app
}
