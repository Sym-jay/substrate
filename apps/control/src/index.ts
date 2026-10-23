import { websocket } from 'hono/bun'
import { createApp } from './app.ts'
import { clerkAuth, localDevAuth } from './auth.ts'
import { config } from './config.ts'
import { createHostReader } from './host.ts'
import { Owners } from './owners.ts'
import { Tickets } from './tickets.ts'
import { Capabilities } from './capabilities.ts'
import { previewRoutes } from './previews.ts'
import { githubTokens } from './github.ts'
import { Jobs } from './jobs.ts'
import { Workflows, WorkflowStore } from './workflows.ts'

const authenticate = config.clerk
  ? clerkAuth({ ...config.clerk, authorizedParties: config.authorizedParties, allowedEmails: config.allowedEmails })
  : config.vmsWithoutLogin
    ? localDevAuth
    : null
const owners = new Owners(config.db)
const tickets = new Tickets()
const capabilities = new Capabilities(config.db)
const jobs = new Jobs(config.db)
const workflows = config.hostd && authenticate ? new Workflows({
  store: new WorkflowStore(config.db), owners, jobs, hostd: config.hostd, maxVmsPerUser: config.maxVmsPerUser,
}) : undefined
workflows?.start()

const app = createApp({
  version: config.version,
  region: config.region,
  webDir: config.webDir,
  readHost: createHostReader(config.hostInstanceId, config.region),
  clerkPublishableKey: config.clerk?.publishableKey ?? null,
  previews: config.hostd && config.previewOrigin ? previewRoutes({ hostd: config.hostd, owners, tickets, capabilities }) : undefined,
  vms: !config.hostd
    ? { unavailable: 'no sandbox host configured' }
    : !authenticate
      ? { unavailable: "sign-in isn't set up on this server yet, so VMs are off" }
      : {
          hostd: config.hostd,
          authenticate,
          owners,
          tickets,
          capabilities,
          jobs,
          workflows,
          previewOrigin: config.previewOrigin,
          githubToken: githubTokens(config.region),
          maxVmsPerUser: config.maxVmsPerUser,
        },
})

// Creating a VM waits for it to boot, which can take longer than Bun's default 10 s.
const server = Bun.serve({ port: config.port, idleTimeout: 120, fetch: app.fetch, websocket })
console.log(
  `substrate-control ${config.version} listening on :${server.port}` +
    (config.clerk ? ', Clerk sign-in on' : authenticate ? ', local dev without sign-in' : ''),
)
