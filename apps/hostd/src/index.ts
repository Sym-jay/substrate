import { mkdir } from 'node:fs/promises'
import { websocket } from 'hono/bun'
import { createApp } from './app.ts'
import { config } from './config.ts'
import { currentImage } from './images.ts'
import { applyFirewall, defaultUplink, PROXY_PORT, slotOfGuest } from './network.ts'
import { startEgressProxy } from './egress.ts'
import { listRecords } from './state.ts'
import { Tokens } from './tokens.ts'
import { AutoPause } from './autopause.ts'
import { logOnly, ntfy } from './notify.ts'
import { Supervisor } from './supervisor.ts'
import { MemoryController } from './balloon.ts'
import { VmManager } from './vms.ts'
import * as zfs from './zfs.ts'

await mkdir(config.paths.run, { recursive: true })
await mkdir(config.paths.vms, { recursive: true })
// The bearer token for this API: on the data disk, kept in step with
// Parameter Store (see tokens.ts). `bun run vm` reads it to talk to hostd.
const tokens = new Tokens({ current: config.paths.token, previous: config.paths.previousToken })
await tokens.init()
const uplink = await defaultUplink()
await applyFirewall(uplink, config.paths.run)

if (!config.ntfy) console.log('no ntfy topic (`bun run secrets --ntfy`): alerts only go to this log')
const notify = config.ntfy ? ntfy(config.ntfy, config.publicUrl) : logOnly

const vms = new VmManager(notify)
await vms.reconcile()
const pool = () => zfs.poolStatus(config.pool)

new AutoPause({ vms, notify, quietMs: config.autoPause.quietMs }).start(config.autoPause.pollMs)
// Its first pass, right away, brings back VMs that were running before a host crash.
new Supervisor({ vms, pool, notify }).start(config.autoPause.pollMs)
new MemoryController(() => vms.balanceMemory()).start()

// Allowlisted VMs reach the internet only through this (see network.ts). A
// VM with open egress may use it too, to anywhere public.
startEgressProxy({
  port: PROXY_PORT,
  async grantFor(sourceIp) {
    const slot = slotOfGuest(sourceIp)
    const record = slot === null ? undefined : (await listRecords()).find((r) => r.slot === slot)
    if (!record) return null
    return { vmId: record.id, allow: record.egress.mode === 'allowlist' ? record.egress.allow : 'any' }
  },
})

const app = createApp({
  token: (given) => tokens.verify(given),
  version: config.version,
  image: async () => (await currentImage())?.version ?? null,
  pool,
  vms,
})

// idleTimeout 0: creating a VM waits for it to boot, and an exec can run for minutes.
Bun.serve({ port: config.port, idleTimeout: 0, fetch: app.fetch, websocket })
console.log(`substrate-hostd ${config.version} listening on :${config.port}, VMs NATed via ${uplink}`)
