import { AGENT_KEY_ENV, type AgentEnv, type Vm } from '@substrate/protocol'
import { websocket } from 'hono/bun'
import { accountRoutes } from './account.ts'
import { createApp } from './app.ts'
import { clerkAuth, localDevAuth, type Authenticate } from './auth.ts'
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
import { SshAccess } from './ssh-access.ts'
import { Quotas } from './quotas.ts'
import { kmsCipher, UserSecrets } from './secrets.ts'
import { Tickets } from './tickets.ts'
import { Usage } from './usage.ts'
import { Events, sessionsTable, Users } from './users.ts'
import type { Hostd } from './vms.ts'
import { awsWindowsCloud } from './windows/cloud.ts'
import { windowsRoutes } from './windows/routes.ts'
import { WindowsSsh } from './windows/ssh.ts'
import { WindowsStore } from './windows/store.ts'
import { WindowsTerminals, withControllingTerminal } from './windows/terminals.ts'
import { WindowsWorkspaces } from './windows/workspaces.ts'
import { Workflows, WorkflowStore } from './workflows.ts'

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
// Account SSH keys and Windows workspaces stay in the control box's SQLite
// file for now; the rest moved to `db` (Phase 2).
const sshAccess = new SshAccess(config.db)
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

// Tasks and fork-and-compare, kept in the control box's SQLite file like
// SSH keys and Windows workspaces.
const workflows = hostd && authenticate ? new Workflows({
  store: new WorkflowStore(config.db), owners, jobs, hostd, maxVmsPerUser: config.maxVmsPerUser,
  maxVms: async (userId) => (await quotas.of(userId)).maxVms,
}) : undefined
workflows?.start()
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

// Windows workspaces (M9), on the deployed control box.
const windows = config.windows && authenticate ? await setUpWindows(config.windows, authenticate) : undefined

async function setUpWindows(windows: NonNullable<typeof config.windows>, authenticate: Authenticate) {
  const ssh = new WindowsSsh(windows.sshDir)
  await ssh.init()
  const workspaces = new WindowsWorkspaces({
    store: new WindowsStore(config.db),
    cloud: awsWindowsCloud({ region: config.region, ...windows }),
    ssh,
    terminals: new WindowsTerminals(),
    instanceType: windows.instanceType,
    maxRunning: windows.maxRunning,
    maxPerUser: windows.maxPerUser,
    idleStopMinutes: windows.idleStopMinutes,
    shell: withControllingTerminal,
  })
  workspaces.run()
  return windowsRoutes({ authenticate, workspaces, tickets })
}

const app = createApp({
  version: config.version,
  region: config.region,
  webDir: config.webDir,
  readHost: createHostReader(config.hostInstanceId, config.region),
  clerkPublishableKey: config.clerk?.publishableKey ?? null,
  windows,
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
          sshAccess,
          jobs,
          workflows,
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
