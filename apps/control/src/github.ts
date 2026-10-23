import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import type { GitHubRepoInfo, GitHubStatus } from '@substrate/protocol'
import { randomBytes } from 'node:crypto'
import type { Db } from './db.ts'
import type { UserSecrets } from './secrets.ts'

// Before Phase 2, an admin stored a user's token in Parameter Store
// (scripts/github-token.ts). Still read, for users who haven't connected.
export function legacyGitHubTokens(region: string) {
  const ssm = new SSMClient({ region })
  return async (userId: string): Promise<string | undefined> => {
    if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error('invalid GitHub credential owner')
    try {
      const result = await ssm.send(new GetParameterCommand({ Name: `/substrate/github/${userId}`, WithDecryption: true }))
      return result.Parameter?.Value
    } catch (error) {
      if (error instanceof Error && error.name === 'ParameterNotFound') return undefined
      throw error
    }
  }
}

type Options = {
  db: Db
  secrets: UserSecrets
  // A GitHub OAuth app, for "Connect with GitHub"; without one, users paste a token.
  oauth: { clientId: string; clientSecret: string; redirectUri: string } | null
  legacy?: (userId: string) => Promise<string | undefined>
  fetch?: typeof fetch
  now?: () => number
}

const STATE_TTL_MS = 10 * 60_000

// Each user's GitHub connection: the token their repository workspaces clone
// with (sent into their VMs only, by hostd), and their repositories.
export class GitHub {
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly o: Options) {
    this.fetch = o.fetch ?? fetch
    this.now = o.now ?? Date.now
  }

  async status(userId: string): Promise<GitHubStatus> {
    const saved = (await this.o.secrets.list(userId)).find((s) => s.name === 'github')
    return { connected: Boolean(saved), login: saved?.hint ?? null, oauth: Boolean(this.o.oauth) }
  }

  // The token for a user's repository workspaces, if they have one.
  async token(userId: string) {
    return (await this.o.secrets.get(userId, 'github')) ?? (await this.o.legacy?.(userId))
  }

  // Where to send the browser to connect. The state ties GitHub's answer to this user.
  async authorizeUrl(userId: string) {
    const oauth = this.o.oauth
    if (!oauth) throw new Error("GitHub sign-in isn't set up on this server; paste a token instead")
    const state = randomBytes(24).toString('base64url')
    await this.o.db`delete from oauth_states where expires <= ${this.now()}`
    await this.o.db`insert into oauth_states (state, user_id, expires) values (${state}, ${userId}, ${this.now() + STATE_TTL_MS})`
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', oauth.clientId)
    url.searchParams.set('redirect_uri', oauth.redirectUri)
    url.searchParams.set('scope', 'repo read:user')
    url.searchParams.set('state', state)
    url.searchParams.set('allow_signup', 'false')
    return url.href
  }

  // GitHub's redirect back. The state is used up either way.
  async finish(state: string, code: string) {
    const oauth = this.o.oauth
    if (!oauth) throw new Error('GitHub sign-in is not set up')
    const [row] = await this.o.db`select user_id, expires from oauth_states where state = ${state}`
    await this.o.db`delete from oauth_states where state = ${state}`
    if (!row || Number(row.expires) <= this.now()) throw new Error('that sign-in link expired; connect again')
    const res = await this.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: oauth.clientId, client_secret: oauth.clientSecret, code, redirect_uri: oauth.redirectUri }),
    })
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string }
    if (!res.ok || !body.access_token) throw new Error(body.error_description ?? "GitHub didn't grant access")
    await this.save(row.user_id, body.access_token)
    return row.user_id as string
  }

  // A pasted token (classic or fine-grained), checked with GitHub first.
  async connectWithToken(userId: string, token: string) {
    return this.save(userId, token)
  }

  async disconnect(userId: string) {
    await this.o.secrets.remove(userId, 'github')
  }

  async repos(userId: string, query = '') {
    const token = await this.token(userId)
    if (!token) throw new Error('connect GitHub first')
    const res = await this.api('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member', token)
    if (!res.ok) throw new Error(`GitHub said ${res.status}; reconnect GitHub`)
    const repos = (await res.json()) as { full_name: string; private: boolean; description: string | null; default_branch: string; pushed_at: string | null }[]
    const q = query.trim().toLowerCase()
    return repos
      .filter((repo) => !q || repo.full_name.toLowerCase().includes(q))
      .map((repo): GitHubRepoInfo => ({ fullName: repo.full_name, private: repo.private, description: repo.description, defaultBranch: repo.default_branch, pushedAt: repo.pushed_at }))
  }

  private async save(userId: string, token: string) {
    const res = await this.api('/user', token)
    if (!res.ok) throw new Error("GitHub didn't accept that token")
    const { login } = (await res.json()) as { login: string }
    await this.o.secrets.set(userId, 'github', token, login)
    return login
  }

  private api(path: string, token: string) {
    return this.fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'substrate' },
    })
  }
}
