import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { NotificationPreferences } from '@substrate/protocol'
import type { Authenticate, User } from './auth.ts'
import type { Notifications } from './notifications.ts'

export function notificationRoutes(authenticate: Authenticate, notifications: Notifications) {
  const app = new Hono<{ Variables: { user: User } }>()
  app.use('*', async (c, next) => { c.header('cache-control', 'no-store'); await next() })
  app.post('/telegram/webhook', async (c, next) => {
    if (!notifications.validWebhook(c.req.header('x-telegram-bot-api-secret-token'))) return c.json({ error: 'not found' }, 404)
    await next()
  }, bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const linked = await notifications.receive(await c.req.json().catch(() => null))
    // Telegram can execute a method in the webhook response. This contains no
    // task/account data; notification delivery remains browser-confirmed.
    return c.json(linked ? { method: 'sendMessage', chat_id: linked.chatId,
      text: 'Return to Substrate Settings to confirm this Telegram connection. No task alerts are enabled until you confirm.' } : { ok: true })
  })
  for (const path of ['/notifications', '/notifications/*']) app.use(path, async (c, next) => {
    const user = await authenticate(c.req.raw)
    if (!user) return c.json({ error: 'sign in first' }, 401)
    c.set('user', user)
    await next()
  })
  app.get('/notifications', async (c) => c.json(await notifications.status(c.var.user.id)))
  app.put('/notifications', async (c) => {
    const input = NotificationPreferences.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: 'Choose which task notifications to receive.' }, 400)
    return c.json(await notifications.preferences(c.var.user.id, input.data))
  })
  app.post('/notifications/telegram/connect', async (c) => c.json(await notifications.begin(c.var.user.id)))
  app.post('/notifications/telegram/confirm', async (c) => c.json(await notifications.confirm(c.var.user.id)))
  app.delete('/notifications/telegram', async (c) => c.json(await notifications.disconnect(c.var.user.id)))
  app.post('/notifications/test', async (c) => c.json(await notifications.test(c.var.user.id), 202))
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
    console.error('notification settings: database unavailable')
    return c.json({ error: 'Could not update notifications. Try again.' }, 500)
  })
  return app
}
