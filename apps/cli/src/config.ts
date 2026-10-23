import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const Credential = z.object({ token: z.string().min(1), userId: z.string(), expiresAt: z.string() })
const Configuration = z.object({ defaultServer: z.string().optional(), servers: z.record(z.string(), Credential).default({}) })
export type Configuration = z.infer<typeof Configuration>
export type Credential = z.infer<typeof Credential>
export const configPath = (env: NodeJS.ProcessEnv = process.env) => join(env.SUBSTRATE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'substrate'), 'credentials.json')

export function serverOrigin(input: string) {
  let url: URL
  try { url = new URL(input) } catch { throw new Error('Use a server URL such as https://your-substrate-host.') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use the server origin only, without credentials, path, query, or fragment.')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS for remote servers; HTTP is allowed only on loopback for development.')
  return url.origin
}

export async function readConfig(path = configPath()): Promise<Configuration> {
  try { return Configuration.parse(JSON.parse(await readFile(path, 'utf8'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: {} }
    throw new Error(`Could not read CLI configuration at ${path}. Repair or remove that file before continuing.`)
  }
}

export async function writeConfig(config: Configuration, path = configPath()) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(config, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally { await rm(temporary, { force: true }) }
}

export async function connection(url: string | undefined, env: NodeJS.ProcessEnv = process.env) {
  const path = configPath(env), config = await readConfig(path)
  const value = url || env.SUBSTRATE_URL || config.defaultServer
  if (!value) throw new Error('Choose a server with substrate login --url https://your-substrate-host, or set SUBSTRATE_URL.')
  const server = serverOrigin(value)
  if (env.SUBSTRATE_TOKEN && env.SUBSTRATE_URL && server !== serverOrigin(env.SUBSTRATE_URL)) throw new Error('SUBSTRATE_TOKEN belongs to SUBSTRATE_URL. Unset it before selecting another server.')
  return { server, token: env.SUBSTRATE_TOKEN || config.servers[server]?.token, config, path }
}
