// GitHub's OAuth redirect always lands on /?github=connected (or failed).
// This remembers where connecting started, so the app can go back there.
export type GitHubReturn = 'launch' | 'settings'
const KEY = 'substrate:after-github'

export function markGitHubReturn(where: GitHubReturn) {
  try { sessionStorage.setItem(KEY, where) } catch { /* only a convenience */ }
}

// Where to go back to, once; null if connecting didn't start here.
export function takeGitHubReturn(): GitHubReturn | null {
  try {
    const where = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    return where === 'launch' || where === 'settings' ? where : null
  } catch {
    return null
  }
}
