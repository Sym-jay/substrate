import { websocket } from 'hono/bun'
import { createApp } from './app.ts'
import { clerkAuth, localDevAuth } from './auth.ts'
import { config } from './config.ts'
import { createHostReader } from './host.ts'
import { Owners } from './owners.ts'
import { Tickets } from './tickets.ts'

const authenticate = config.clerk
  ? clerkAuth({ ...config.clerk, authorizedParties: config.authorizedParties, allowedEmails: config.allowedEmails })
  : config.vmsWithoutLogin
    ? localDevAuth
    : null

const app = createApp({
  version: config.version,
  region: config.region,
  webDir: config.webDir,
  readHost: createHostReader(config.hostInstanceId, config.region),
  clerkPublishableKey: config.clerk?.publishableKey ?? null,
  vms: !config.hostd
    ? { unavailable: 'no sandbox host configured' }
    : !authenticate
      ? { unavailable: "sign-in isn't set up on this server yet, so VMs are off" }
      : {
          hostd: config.hostd,
          authenticate,
          owners: new Owners(config.db),
          tickets: new Tickets(),
          maxVmsPerUser: config.maxVmsPerUser,
        },
})

// Creating a VM waits for it to boot, which can take longer than Bun's default 10 s.
const server = Bun.serve({ port: config.port, idleTimeout: 120, fetch: app.fetch, websocket })
console.log(
  `substrate-control ${config.version} listening on :${server.port}` +
    (config.clerk ? ', Clerk sign-in on' : authenticate ? ', local dev without sign-in' : ''),
)
