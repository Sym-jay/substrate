import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { websocket } from 'hono/bun'
import { createApp } from './app.ts'
import { config } from './config.ts'
import { currentImage } from './images.ts'
import { applyFirewall, defaultUplink } from './network.ts'
import { VmManager } from './vms.ts'

// The bearer token for this API. Generated once and kept on the data disk;
// on the host, `bun run vm` reads it to talk to hostd.
async function loadToken() {
  const file = Bun.file(config.paths.token)
  if (await file.exists()) return (await file.text()).trim()
  const token = randomBytes(32).toString('hex')
  await Bun.write(config.paths.token, token, { mode: 0o600 })
  return token
}

await mkdir(config.paths.run, { recursive: true })
await mkdir(config.paths.vms, { recursive: true })
const token = await loadToken()
const uplink = await defaultUplink()
await applyFirewall(uplink, config.paths.run)

const vms = new VmManager()
await vms.reconcile()

const app = createApp({
  token,
  version: config.version,
  image: async () => (await currentImage())?.version ?? null,
  vms,
})

// idleTimeout 0: creating a VM waits for it to boot, and an exec can run for minutes.
Bun.serve({ port: config.port, idleTimeout: 0, fetch: app.fetch, websocket })
console.log(`substrate-hostd ${config.version} listening on :${config.port}, VMs NATed via ${uplink}`)
