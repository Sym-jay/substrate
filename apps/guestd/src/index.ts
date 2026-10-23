import { GUESTD_PORT } from '@substrate/protocol'
import { $ } from 'bun'
import { websocket } from 'hono/bun'
import { Activity, BUSY_CPUS, cpuSampler } from './activity.ts'
import { createApp } from './app.ts'
import { sendEvent, serveEvents } from './events.ts'
import { exec } from './exec.ts'
import { readGuestConfig, type GuestConfig } from './mmds.ts'
import { Sessions } from './sessions.ts'

// Set by `bun build --define` in images/host/install-hostd.sh.
declare const BUILD_VERSION: string | undefined
const version = typeof BUILD_VERSION === 'string' ? BUILD_VERSION : 'dev'

// `substrate-guestd event …` is the `substrate-event` command agent hooks run.
if (process.argv[2] === 'event') process.exit(await sendEvent(process.argv.slice(3)))

// The kernel set up eth0 from its `ip=` boot argument. The metadata service
// answers on eth0 itself, so reach it directly rather than via the gateway.
await $`ip route replace 169.254.169.254 dev eth0`.quiet()

let config: GuestConfig | null = null
for (let attempt = 1; !config; attempt++) {
  try {
    config = await readGuestConfig()
  } catch (err) {
    if (attempt % 20 === 1) console.error(`waiting for the metadata service: ${err}`)
    await Bun.sleep(50)
  }
}

const activity = new Activity()
const sessions = new Sessions(undefined, undefined, activity)
const app = createApp({ vmId: config.vmId, token: config.token, version, run: exec, sessions, activity })
// Without it agents can't send alerts, but the VM still works.
await serveEvents(activity).catch((err) => console.error(`agent events are off: ${err}`))
const cpu = cpuSampler()
setInterval(async () => {
  if ((await cpu().catch(() => 0)) > BUSY_CPUS) activity.touch()
}, 10_000)
// idleTimeout 0: an exec can legitimately run for minutes.
Bun.serve({ hostname: config.guestIp, port: GUESTD_PORT, idleTimeout: 0, fetch: app.fetch, websocket })
console.log(`substrate-guestd ${version} for ${config.vmId} on ${config.guestIp}:${GUESTD_PORT}`)
