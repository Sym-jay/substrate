import { z } from 'zod'

// Where a VM may connect out to (Phase 2). `open`: anywhere on the internet,
// directly. `allowlist`: only through the host's proxy, and only to these
// hosts plus DEFAULT_EGRESS_ALLOWLIST. An entry is a hostname, `*.domain` for
// any name under it, and optionally `:port` (80 and 443 are always allowed).
export const EgressHost = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/, 'a hostname, *.domain, optionally with :port')
export const EgressPolicy = z.object({
  mode: z.enum(['open', 'allowlist']),
  allow: EgressHost.array().max(200).default([]),
})
export type EgressPolicy = z.infer<typeof EgressPolicy>

// What coding agents and their package managers need.
export const DEFAULT_EGRESS_ALLOWLIST = [
  // Agents
  'api.anthropic.com', '*.anthropic.com', 'claude.ai', '*.claude.ai',
  'api.openai.com', '*.openai.com', 'chatgpt.com', '*.chatgpt.com',
  'opencode.ai', '*.opencode.ai',
  // Code
  'github.com', '*.github.com', '*.githubusercontent.com', 'ghcr.io', '*.ghcr.io', 'github.com:22',
  // Packages
  'registry.npmjs.org', '*.npmjs.org', 'registry.yarnpkg.com', 'bun.sh', '*.bun.sh',
  'pypi.org', 'files.pythonhosted.org', 'proxy.golang.org', 'sum.golang.org', 'crates.io', '*.crates.io', 'static.rust-lang.org',
  'archive.ubuntu.com', 'security.ubuntu.com', 'ports.ubuntu.com', '*.ubuntu.com', 'deb.nodesource.com',
  'registry-1.docker.io', 'auth.docker.io', 'production.cloudflare.docker.com',
]

// Whether `host:port` is allowed by these entries.
export function egressAllows(allow: readonly string[], host: string, port: number) {
  const name = host.toLowerCase().replace(/\.$/, '')
  return allow.some((entry) => {
    const [pattern = '', portText] = entry.toLowerCase().split(':')
    const ports = portText ? [Number(portText)] : [80, 443]
    if (!ports.includes(port)) return false
    if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1
    return name === pattern
  })
}
