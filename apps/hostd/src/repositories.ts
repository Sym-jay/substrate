import type { VmRecord } from './state.ts'
import { guestClient } from './guest.ts'
import { slotAddresses } from './network.ts'

// Credentials are read on the host, sent over the private authenticated link,
// and never placed in a URL, argv, returned output, or repository metadata.
export async function importRepository(record: VmRecord, token?: string) {
  if (!record.repository) return
  const guest = guestClient(slotAddresses(record.slot).guestIp, record.token)
  await guest.repository(record.repository, token)
}
