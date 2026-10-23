import { websocket } from 'hono/bun'
import { createApp } from './app.ts'
import { config } from './config.ts'
import { createHostReader } from './host.ts'

const app = createApp({
  version: config.version,
  region: config.region,
  webDir: config.webDir,
  readHost: createHostReader(config.hostInstanceId, config.region),
  hostd: config.hostd,
})

// Creating a VM waits for it to boot, which can take longer than Bun's default 10 s.
const server = Bun.serve({ port: config.port, idleTimeout: 120, fetch: app.fetch, websocket })
console.log(`substrate-control ${config.version} listening on :${server.port}`)
