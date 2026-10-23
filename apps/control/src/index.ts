import { createApp } from './app.ts'
import { config } from './config.ts'
import { createHostReader } from './host.ts'

const app = createApp({
  version: config.version,
  region: config.region,
  webDir: config.webDir,
  readHost: createHostReader(config.hostInstanceId, config.region),
})

const server = Bun.serve({ port: config.port, fetch: app.fetch })
console.log(`substrate-control ${config.version} listening on :${server.port}`)
