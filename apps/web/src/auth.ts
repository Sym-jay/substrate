// The signed-in user's Clerk session token, sent with every API call.
// ClerkApp sets the source; without Clerk (local development without keys)
// calls go out without one.
let tokenSource: () => Promise<string | null> = async () => null

export function setTokenSource(source: () => Promise<string | null>) {
  tokenSource = source
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await tokenSource()
  return token ? { Authorization: `Bearer ${token}` } : {}
}
