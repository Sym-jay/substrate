import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { CreateComparison, CreateTask, ReviewTask, SelectApproach } from '@substrate/protocol'
import type { Authenticate, User } from './auth.ts'
import type { Workflows } from './workflows.ts'

export function workflowRoutes(authenticate: Authenticate, workflows: Workflows) {
  const app = new Hono<{ Variables: { user: User } }>()
  const signedIn = async (c: import('hono').Context<{ Variables: { user: User } }>, next: import('hono').Next) => {
    const user = await authenticate(c.req.raw)
    if (!user) return c.json({ error: 'sign in first' }, 401)
    c.set('user', user)
    c.header('cache-control', 'no-store')
    await next()
  }
  for (const path of ['/tasks', '/tasks/*', '/comparisons', '/comparisons/*']) app.use(path, signedIn)
  app.get('/tasks', (c) => c.json(workflows.list(c.var.user.id)))
  app.post('/tasks', async (c) => {
    const parsed = CreateTask.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid task' }, 400)
    return c.json(await workflows.createTask(c.var.user.id, parsed.data.vmId, parsed.data.spec), 202)
  })
  app.get('/tasks/:id', (c) => c.json(workflows.task(c.var.user.id, c.req.param('id'))))
  app.patch('/tasks/:id', async (c) => {
    const input = ReviewTask.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: 'Choose whether this result is reviewed' }, 400)
    return c.json(workflows.review(c.var.user.id, c.req.param('id'), input.data.reviewed))
  })
  app.post('/tasks/:id/cancel', async (c) => c.json(await workflows.cancel(c.var.user.id, c.req.param('id'))))
  app.get('/comparisons', (c) => c.json(workflows.comparisons(c.var.user.id)))
  app.post('/comparisons', async (c) => {
    const input = CreateComparison.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: input.error.issues[0]?.message ?? 'Invalid comparison' }, 400)
    return c.json(await workflows.createComparison(c.var.user.id, input.data), 202)
  })
  app.get('/comparisons/:id', (c) => c.json(workflows.comparison(c.var.user.id, c.req.param('id'))))
  app.post('/comparisons/:id/select', async (c) => {
    const input = SelectApproach.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: 'Choose an approach' }, 400)
    return c.json(workflows.select(c.var.user.id, c.req.param('id'), input.data.taskId))
  })
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
    console.error('workflows:', error)
    return c.json({ error: 'Could not update tasks. Try again.' }, 500)
  })
  return app
}
