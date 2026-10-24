import { createClerkClient } from '@clerk/backend'

export type User = { id: string }

// Who is calling, or null. Throws only if Clerk itself can't be reached.
export type Authenticate = (req: Request) => Promise<User | null>

type ClerkOptions = {
  secretKey: string
  publishableKey: string
  // Frontend origins whose session tokens to accept. Empty accepts any origin
  // the Clerk application issues tokens for.
  authorizedParties: string[]
  // Verified emails allowed in. Empty lets anyone with an account in.
  allowedEmails: string[]
}

// Verifies the Clerk session token the web app sends as `Authorization: Bearer`.
export function clerkAuth({ secretKey, publishableKey, authorizedParties, allowedEmails }: ClerkOptions): Authenticate {
  const clerk = createClerkClient({ secretKey, publishableKey })
  const allowed = new Set(allowedEmails.map((e) => e.toLowerCase()))
  // Allowlist decisions, so each request doesn't cost a Clerk API call.
  const decisions = new Map<string, { allowed: boolean; at: number }>()

  const isAllowed = async (userId: string) => {
    if (!allowed.size) return true
    const cached = decisions.get(userId)
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.allowed
    const user = await clerk.users.getUser(userId)
    const ok = user.emailAddresses.some(
      (e) => e.verification?.status === 'verified' && allowed.has(e.emailAddress.toLowerCase()),
    )
    decisions.set(userId, { allowed: ok, at: Date.now() })
    return ok
  }

  return async (req) => {
    const state = await clerk.authenticateRequest(req, {
      acceptsToken: 'session_token',
      authorizedParties: authorizedParties.length ? authorizedParties : undefined,
    })
    if (!state.isAuthenticated) return null
    const { userId } = state.toAuth()
    return userId && (await isAllowed(userId)) ? { id: userId } : null
  }
}

// A CLI credential outlives a browser session. Recheck that its owner still
// exists, is enabled, and satisfies the same verified-email allowlist. Cache
// for at most one minute; local credential revocation remains immediate.
export function clerkCliAccess({ secretKey, allowedEmails }: Pick<ClerkOptions, 'secretKey' | 'allowedEmails'>) {
  const clerk = createClerkClient({ secretKey })
  const allowed = new Set(allowedEmails.map((email) => email.toLowerCase()))
  const cache = new Map<string, { ok: boolean; at: number }>()
  return async (id: string) => {
    const cached = cache.get(id)
    if (cached && Date.now() - cached.at < 60_000) return cached.ok
    const user = await clerk.users.getUser(id).catch((error: { status?: number }) => {
      if (error.status === 404) return null
      throw error
    })
    const ok = !!user && !user.banned && !user.locked && (!allowed.size || user.emailAddresses.some((email) => email.verification?.status === 'verified' && allowed.has(email.emailAddress.toLowerCase())))
    cache.set(id, { ok, at: Date.now() })
    return ok
  }
}

// Local development without Clerk keys: everyone is the same user. Only
// `bun run dev --host` turns this on, and only on localhost.
export const localDevAuth: Authenticate = async () => ({ id: 'local-dev' })
