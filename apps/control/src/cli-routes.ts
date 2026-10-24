import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { CliDeviceCode, CliDeviceRequest } from '@substrate/protocol'
import type { Authenticate } from './auth.ts'
import { CliCredentials, cliBearer } from './cli-auth.ts'

export function cliRoutes({ credentials, browserAuthenticate, authenticate, requireBrowserBearer = true }: {
  credentials: CliCredentials; browserAuthenticate: Authenticate; authenticate: Authenticate; requireBrowserBearer?: boolean
}) {
  const app = new Hono()
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      if (error.status === 429) c.header('retry-after', '2')
      return c.json({ error: error.message }, error.status as 400 | 403 | 404 | 409 | 410 | 429)
    }
    console.error('CLI authentication storage:', error instanceof Error ? error.name : 'unknown error')
    return c.json({ error: 'CLI authentication is temporarily unavailable. Try again.' }, 503)
  })
  const starts = new Map<string, { at: number; count: number }>()
  app.use('/cli/*', async (c, next) => { c.header('cache-control', 'no-store'); c.header('referrer-policy', 'no-referrer'); await next() })
  const browser = async (request: Request) => {
    if (cliBearer(request) || (requireBrowserBearer && !/^Bearer \S+$/.test(request.headers.get('authorization') ?? ''))) return null
    return browserAuthenticate(request)
  }
  app.post('/cli/device', async (c) => {
    const now = Date.now()
    for (const [key, value] of starts) if (now - value.at >= 60_000) starts.delete(key)
    // CloudFront appends the connecting viewer address to X-Forwarded-For.
    const source = (c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || 'direct').slice(0, 100)
    const bucket = starts.get(source) ?? { at: now, count: 0 }
    if (bucket.count >= 10 || (!starts.has(source) && starts.size >= 2048)) { c.header('retry-after', '60'); return c.json({ error: 'Too many login requests. Wait a minute before trying again.' }, 429) }
    bucket.count++; starts.set(source, bucket)
    const input = CliDeviceRequest.safeParse(await c.req.json().catch(() => null))
    return input.success ? c.json(await credentials.begin(input.data.name), 201) : c.json({ error: 'Provide a CLI device name (1–80 characters).' }, 400)
  })
  app.post('/cli/device/token', async (c) => {
    const input = await c.req.json().catch(() => null) as { deviceCode?: unknown } | null
    if (typeof input?.deviceCode !== 'string' || input.deviceCode.length > 128) return c.json({ error: 'Provide the device secret.' }, 400)
    const grant = await credentials.poll(input.deviceCode)
    if (!grant) { c.header('retry-after', '2'); return c.json({ state: 'pending' }, 202) }
    return c.json(grant)
  })
  app.get('/cli/device/:code', async (c) => {
    if (!await browser(c.req.raw)) return c.json({ error: 'Sign in through the website to approve CLI access.' }, 401)
    const code = CliDeviceCode.safeParse(c.req.param('code'))
    return code.success ? c.json(await credentials.inspect(code.data)) : c.json({ error: 'Invalid login code.' }, 400)
  })
  for (const action of ['approve', 'deny'] as const) app.post(`/cli/device/:code/${action}`, async (c) => {
    const user = await browser(c.req.raw)
    if (!user) return c.json({ error: 'Sign in through the website to approve CLI access.' }, 401)
    const code = CliDeviceCode.safeParse(c.req.param('code'))
    if (!code.success) return c.json({ error: 'Invalid login code.' }, 400)
    await credentials.decide(code.data, user.id, action === 'approve')
    return c.body(null, 204)
  })
  app.get('/cli/sessions', async (c) => {
    const user = await browser(c.req.raw)
    return user ? c.json(await credentials.list(user.id)) : c.json({ error: 'Sign in through the website to manage CLI sessions.' }, 401)
  })
  app.delete('/cli/sessions/:id', async (c) => {
    const user = await browser(c.req.raw)
    if (!user) return c.json({ error: 'Sign in through the website to manage CLI sessions.' }, 401)
    return await credentials.revoke(user.id, c.req.param('id')) ? c.body(null, 204) : c.json({ error: 'CLI session not found.' }, 404)
  })
  app.get('/cli/whoami', async (c) => {
    const user = await authenticate(c.req.raw)
    if (!user) return c.json({ error: 'CLI login is missing, expired, or revoked. Run substrate login.' }, 401)
    const token = cliBearer(c.req.raw)
    return c.json({ userId: user.id, session: token ? (await credentials.identify(token))?.session ?? null : null })
  })
  app.post('/cli/logout', async (c) => {
    const user = await authenticate(c.req.raw), token = cliBearer(c.req.raw)
    const identity = token ? await credentials.identify(token) : null
    if (!user || !identity) return c.json({ error: 'CLI login is missing, expired, or revoked.' }, 401)
    await credentials.revoke(user.id, identity.session.id)
    return c.body(null, 204)
  })
  return app
}
