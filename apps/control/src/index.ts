import { AGENT_KEY_ENV, type AgentEnv, type Vm } from '@substrate/protocol'
import { websocket } from 'hono/bun'
import { accountRoutes } from './account.ts'
import { createApp } from './app.ts'
import { clerkAuth, localDevAuth } from './auth.ts'
import { Capabilities } from './capabilities.ts'
import { config } from './config.ts'
import { openDatabase } from './open-database.ts'
import { GitHub, legacyGitHubTokens } from './github.ts'
import { createHostReader } from './host.ts'
import { rotatingHostd } from './hostd-token.ts'
import { Jobs } from './jobs.ts'
import { Metering } from './metering.ts'
import { Owners } from './owners.ts'
import { previewRoutes } from './previews.ts'
import { Quotas } from './quotas.ts'
import { kmsCipher, UserSecrets } from './secrets.ts'
import { Tickets } from './tickets.ts'
import { Usage } from './usage.ts'
import { Events, sessionsTable, Users } from './users.ts'
import type { Hostd } from './vms.ts'

const authenticate = config.clerk
  ? clerkAuth({ ...config.clerk, authorizedParties: config.authorizedParties, allowedEmails: config.allowedEmails })
  : config.vmsWithoutLogin
    ? localDevAuth
    : null

const db = await openDatabase()

const owners = new Owners(db)
const tickets = new Tickets()
const capabilities = new Capabilities(db)
const jobs = new Jobs(db)
await jobs.start()
const users = new Users(db)
const events = new Events(db)
const usage = new Usage(db)
const quotas = new Quotas(db, config.quota, config.admins)
const secrets = config.kmsKeyId ? new UserSecrets(db, kmsCipher(config.region, config.kmsKeyId)) : null
const github = secrets
  ? new GitHub({
      db, secrets, legacy: legacyGitHubTokens(config.region),
      oauth: config.githubOAuth && config.publicUrl ? { ...config.githubOAuth, redirectUri: `${config.publicUrl}/api/github/callback` } : null,
    })
  : null

const hostd: Hostd | null = config.hostd ? (config.hostInstanceId ? rotatingHostd(config.hostd, config.region) : config.hostd) : null
const callHostd = (path: string, init: RequestInit = {}) =>
  fetch(`${hostd!.url}${path}`, { ...init, headers: { Authorization: `Bearer ${hostd!.token}`, 'content-type': 'application/json' } })
const allVms = async () => {
  const res = await callHostd('/vms').catch(() => null)
  return res?.ok ? ((await res.json()) as Vm[]) : null
}
const vmsOf = async (userId: string) => {
  const vms = await allVms()
  if (!vms) return null
  const mine = new Set(await owners.vmsOf(userId))
  return vms.filter((vm) => mine.has(vm.id))
}

// A user's agent keys, as their sessions get them.
async function agentEnv(userId: string): Promise<AgentEnv> {
  if (!secrets) return {}
  const env: AgentEnv = {}
  for (const name of ['anthropic', 'openai'] as const) {
    const value = await secrets.get(userId, name)
    if (value) env[AGENT_KEY_ENV[name]] = value
  }
  return env
}

// After a key changes, the user's running VMs get the new set straight away.
async function keysChanged(userId: string) {
  const env = await agentEnv(userId)
  for (const vm of (await vmsOf(userId)) ?? []) {
    if (vm.state !== 'running') continue
    await callHostd(`/vms/${vm.id}/agent-env`, { method: 'PUT', body: JSON.stringify(env) }).catch(() => null)
  }
}

if (hostd) {
  new Metering({
    allVms, owners, usage, quotas, events,
    pause: async (vmId) => {
      const res = await callHostd(`/vms/${vmId}/pause`, { method: 'POST', body: '{}' })
      if (!res.ok) throw new Error(`hostd said ${res.status}`)
    },
  }).start()
}

const app = createApp({
  version: config.version,
  region: config.region,
  webDir: config.webDir,
  readHost: createHostReader(config.hostInstanceId, config.region),
  clerkPublishableKey: config.clerk?.publishableKey ?? null,
  previews: hostd && config.previewOrigin ? previewRoutes({ hostd, owners, tickets, capabilities }) : undefined,
  account: authenticate
    ? accountRoutes({ authenticate, users, events, usage, quotas, owners, vmsOf, secrets, github, keysChanged, admins: config.admins })
    : undefined,
  vms: !hostd
    ? { unavailable: 'no sandbox host configured' }
    : !authenticate
      ? { unavailable: "sign-in isn't set up on this server yet, so VMs are off" }
      : {
          hostd,
          authenticate,
          owners,
          tickets,
          capabilities,
          jobs,
          previewOrigin: config.previewOrigin,
          githubToken: (userId) => (github ? github.token(userId) : legacyGitHubTokens(config.region)(userId)),
          maxVmsPerUser: config.maxVmsPerUser,
          quotas, usage, events, users,
          sessions: sessionsTable(db),
          agentEnv,
        },
})

// Creating a VM waits for it to boot, which can take longer than Bun's default 10 s.
const server = Bun.serve({ port: config.port, idleTimeout: 120, fetch: app.fetch, websocket })
console.log(
  `substrate-control ${config.version} listening on :${server.port}` +
    (config.clerk ? ', Clerk sign-in on' : authenticate ? ', local dev without sign-in' : '') +
    `, data in ${config.database ? 'Postgres' : 'SQLite'}` +
    (secrets ? ', user keys on' : ''),
)
