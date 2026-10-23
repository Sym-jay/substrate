import { $ } from 'bun'
import type { GuestConfig } from './mmds.ts'
import { renewSshIdentity } from './ssh.ts'

// A restored clone starts with its parent's network configuration in memory.
// MMDS is intercepted on eth0, so it works before the new IP is installed.
// The existing Sessions object and shell processes stay alive.
export async function configureFork(previous: GuestConfig, next: GuestConfig) {
  if (!/^172\.30\.\d{1,3}\.\d{1,3}$/.test(next.guestIp) || !/^172\.30\.\d{1,3}\.\d{1,3}$/.test(next.hostIp)) throw new Error('invalid fork network metadata')
  await $`ip addr replace ${`${next.guestIp}/30`} dev eth0`.quiet()
  await $`ip route replace default via ${next.hostIp} dev eth0`.quiet()
  if (previous.guestIp !== next.guestIp) await $`ip addr del ${`${previous.guestIp}/30`} dev eth0`.quiet().nothrow()
  await $`hostname ${next.name}`.quiet()
  // The image requires VMGENID, which reseeds the kernel RNG on snapshot
  // restore. Mix the unique host token in as well before creating SSH keys.
  await Bun.write('/dev/urandom', Buffer.from(next.token, 'hex'))
  await renewSshIdentity()
}
