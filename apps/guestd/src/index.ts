import { GUESTD_PORT } from '@substrate/protocol'
import { $ } from 'bun'
import { createApp } from './app.ts'
import { exec } from './exec.ts'
import { readGuestConfig, type GuestConfig } from './mmds.ts'

// Set by `bun build --define` in images/host/install-hostd.sh.
declare const BUILD_VERSION: string | undefined
const version = typeof BUILD_VERSION === 'string' ? BUILD_VERSION : 'dev'

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

const app = createApp({ vmId: config.vmId, token: config.token, version, run: exec })
// idleTimeout 0: an exec can legitimately run for minutes.
Bun.serve({ hostname: config.guestIp, port: GUESTD_PORT, idleTimeout: 0, fetch: app.fetch })
console.log(`substrate-guestd ${version} for ${config.vmId} on ${config.guestIp}:${GUESTD_PORT}`)
