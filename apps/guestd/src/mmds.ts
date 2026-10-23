import { z } from 'zod'

// What hostd puts in the VM's metadata service under `substrate`.
export const GuestConfig = z.object({
  vmId: z.string(),
  name: z.string(),
  token: z.string().min(32),
  guestIp: z.string(),
  hostIp: z.string(),
  // Set when hostd brought this VM back after a crash, or from the disk of a
  // save it couldn't restore: reopen the sessions that were running.
  resumeSessions: z.boolean().default(false),
})
export type GuestConfig = z.infer<typeof GuestConfig>

const MMDS = 'http://169.254.169.254'

// Firecracker's metadata service, version 2: get a session token, then read.
export async function readGuestConfig(): Promise<GuestConfig> {
  const session = await fetch(`${MMDS}/latest/api/token`, {
    method: 'PUT',
    headers: { 'X-metadata-token-ttl-seconds': '60' },
    signal: AbortSignal.timeout(1_000),
  })
  if (!session.ok) throw new Error(`MMDS token request failed: ${session.status}`)
  const res = await fetch(`${MMDS}/substrate`, {
    headers: { 'X-metadata-token': await session.text(), Accept: 'application/json' },
    signal: AbortSignal.timeout(1_000),
  })
  if (!res.ok) throw new Error(`MMDS read failed: ${res.status}`)
  return GuestConfig.parse(await res.json())
}
