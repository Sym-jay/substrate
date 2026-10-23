import { randomBytes } from 'node:crypto'

const TTL_MS = 60_000

type Ticket = { userId: string; vmId: string; sessionId: string; expires: number }

// Browsers can't put a session token on a WebSocket, so the web app trades
// its token for a ticket first and puts that in the terminal URL. A ticket
// opens one terminal, once, within a minute.
export class Tickets {
  private tickets = new Map<string, Ticket>()

  issue({ userId, vmId, sessionId }: Omit<Ticket, 'expires'>) {
    const now = Date.now()
    for (const [id, t] of this.tickets) if (t.expires < now) this.tickets.delete(id)
    const id = randomBytes(24).toString('base64url')
    this.tickets.set(id, { userId, vmId, sessionId, expires: now + TTL_MS })
    return id
  }

  // The ticket's user, if it's valid for this terminal. Used up either way.
  redeem(id: string, vmId: string, sessionId: string): string | null {
    const ticket = this.tickets.get(id)
    this.tickets.delete(id)
    if (!ticket || ticket.expires < Date.now() || ticket.vmId !== vmId || ticket.sessionId !== sessionId) return null
    return ticket.userId
  }
}
