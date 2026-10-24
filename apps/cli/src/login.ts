import { CliDeviceGrant, CliToken } from '@substrate/protocol'
import { hostname } from 'node:os'
import { Client, ApiError } from './client.ts'
import { connection, writeConfig } from './config.ts'

export async function openBrowser(url: string) {
  const argv = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url]
  try { return await Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).exited === 0 } catch { return false }
}

export async function login(options: { url?: string; noBrowser?: boolean; tokenStdin?: boolean; name?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv; stdout: (value: unknown) => void; stderr: (value: string) => void }) {
  const info = await connection(options.url, options.env)
  let token: string, userId: string, expiresAt: string
  if (options.tokenStdin) {
    if (process.stdin.isTTY) throw new Error('Pipe a CLI credential into login --token-stdin. Tokens are not accepted as command-line arguments.')
    const input = (await Bun.stdin.text()).trim()
    if (!/^sub_cli_[A-Za-z0-9_-]{43}$/.test(input)) throw new Error('stdin did not contain one Substrate CLI credential.')
    const identity = await new Client(info.server, input, fetch, options.signal).identity()
    if (!identity.session) throw new Error('This is not a persistent CLI credential.')
    token = input; userId = identity.userId; expiresAt = identity.session.expiresAt
  } else {
    const client = new Client(info.server, undefined, fetch, options.signal)
    let grant: CliDeviceGrant
    try { grant = CliDeviceGrant.parse(await client.request('/api/cli/device', 'POST', { name: (options.name || hostname()).slice(0, 80) }, false)) }
    catch (error) { if (error instanceof ApiError && error.status === 404) throw new Error('CLI login is not available on this server yet. Deploy the CLI-enabled control service first.'); throw error }
    const url = `${info.server}/#/cli/${grant.userCode}`
    options.stderr(`Approve this login in your browser: ${url}\nCheck that the code matches: ${grant.userCode}\n`)
    if (!options.noBrowser) await openBrowser(url)
    let value: CliToken | undefined
    while (Date.now() < Date.parse(grant.expiresAt)) {
      await client.sleep(Math.max(2, grant.intervalSeconds) * 1000)
      try {
        const reply = await client.request('/api/cli/device/token', 'POST', { deviceCode: grant.deviceCode }, false)
        if ((reply as { state?: string }).state === 'pending') continue
        value = CliToken.parse(reply); break
      } catch (error) { if (error instanceof ApiError && error.status === 429) continue; throw error }
    }
    if (!value) throw new Error('CLI login expired. Run substrate login again.')
    token = value.token; userId = value.userId; expiresAt = value.session.expiresAt
  }
  const config = await connection(options.url, options.env)
  config.config.defaultServer = info.server
  config.config.servers[info.server] = { token, userId, expiresAt }
  try { await writeConfig(config.config, config.path) }
  catch (error) {
    if (!options.tokenStdin) await new Client(info.server, token).request('/api/cli/logout', 'POST', {}).catch(() => {})
    throw error
  }
  options.stdout({ server: info.server, userId, expiresAt })
}
