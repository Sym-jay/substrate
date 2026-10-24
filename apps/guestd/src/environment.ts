import type { AgentEnv } from '@substrate/protocol'
import { $ } from 'bun'
import { mkdir, rm } from 'node:fs/promises'

const PROFILE_PROXY = '/etc/profile.d/substrate-proxy.sh'
const APT_PROXY = '/etc/apt/apt.conf.d/95substrate-proxy'
const PROFILE_AGENT_ENV = '/etc/profile.d/substrate-agent-env.sh'
export const AGENT_ENV_FILE = '/home/dev/.config/substrate/agent-env'

// Allowlisted egress (Phase 2): everything goes through the host's proxy,
// since nothing else gets out. Login shells (every session), apt and the
// tools that read *_proxy pick it up. Null, for open egress, removes it.
export async function applyProxy(proxy: string | null) {
  if (!proxy) {
    await rm(PROFILE_PROXY, { force: true })
    await rm(APT_PROXY, { force: true })
    return
  }
  if (!/^http:\/\/172\.3[01]\.\d{1,3}\.\d{1,3}:\d{1,5}$/.test(proxy)) throw new Error('invalid proxy in metadata')
  const noProxy = 'localhost,127.0.0.1,::1,169.254.169.254'
  await Bun.write(PROFILE_PROXY, [
    `export http_proxy=${proxy} https_proxy=${proxy} HTTP_PROXY=${proxy} HTTPS_PROXY=${proxy}`,
    `export no_proxy=${noProxy} NO_PROXY=${noProxy}`,
    '',
  ].join('\n'))
  await Bun.write(APT_PROXY, `Acquire::http::Proxy "${proxy}";\nAcquire::https::Proxy "${proxy}";\n`)
}

// The user's agent keys, for every session from now on (login shells source
// the file). Readable by dev only. An empty set removes the file.
export async function writeAgentEnv(env: AgentEnv) {
  const entries = Object.entries(env).filter(([, value]) => value)
  if (!entries.length) return rm(AGENT_ENV_FILE, { force: true })
  await Bun.write(PROFILE_AGENT_ENV, `[ -r "$HOME/.config/substrate/agent-env" ] && . "$HOME/.config/substrate/agent-env"\n`)
  await mkdir('/home/dev/.config/substrate', { recursive: true, mode: 0o700 })
  // The values were checked against AgentEnv: letters, digits and _-.: only.
  await Bun.write(AGENT_ENV_FILE, entries.map(([key, value]) => `export ${key}='${value}'`).join('\n') + '\n', { mode: 0o600 })
  await $`chown -R dev:dev /home/dev/.config/substrate`.quiet()
}
