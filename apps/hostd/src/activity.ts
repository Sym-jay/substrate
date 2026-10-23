import type { GuestActivity } from '@substrate/protocol'

// Browser PTYs report activity in guestd. SSH and app previews bypass those
// PTYs, so their traffic contributes here without resetting max-uptime clocks.
export class ExternalActivity {
  private seen = new Map<string, number>()
  constructor(private now = () => performance.now()) {}
  touch(id: string) { this.seen.set(id, this.now()) }
  forget(id: string) { this.seen.delete(id) }
  report(id: string, guest: GuestActivity | null): GuestActivity | null {
    const last = this.seen.get(id)
    return guest && last !== undefined ? { ...guest, idleMs: Math.min(guest.idleMs, Math.max(0, Math.round(this.now() - last))) } : guest
  }
}
