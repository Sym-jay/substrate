import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import type { Hostd } from './vms.ts'

const PARAMETER = '/substrate/hostd-token'
// hostd rereads its tokens every minute (refresh-token.sh); waiting this long
// before using a new one means hostd always knows it first.
const ADOPT_AFTER_MS = 3 * 60_000

// hostd's token, kept in step with Parameter Store, where a scheduled job
// rotates it. Until a new token is adopted, the old one still works: hostd
// accepts the previous token too.
export function rotatingHostd(initial: { url: string; token: string }, region: string, now = Date.now): Hostd & { refresh(): Promise<void> } {
  const ssm = new SSMClient({ region })
  let token = initial.token
  let seen: { value: string; at: number } | null = null
  const refresh = async () => {
    const value = (await ssm.send(new GetParameterCommand({ Name: PARAMETER, WithDecryption: true }))).Parameter?.Value
    if (!value || value === token) return void (seen = null)
    if (seen?.value !== value) seen = { value, at: now() }
    if (now() - seen.at >= ADOPT_AFTER_MS) {
      token = value
      seen = null
      console.log('hostd token: now using the rotated one')
    }
  }
  setInterval(() => void refresh().catch((err: Error) => console.error(`hostd token: ${err.message}`)), 60_000)
  return { url: initial.url, get token() { return token }, refresh }
}
