// Register the dedicated bot only after control has loaded its configuration.
// Tokens are read from Parameter Store into memory; no secret appears in args.
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { Telegram } from '../apps/control/src/telegram.ts'
import { region } from './lib/aws.ts'

const ssm = new SSMClient({ region })
const get = async (Name: string) => {
  const value = (await ssm.send(new GetParameterCommand({ Name, WithDecryption: true }))).Parameter?.Value
  if (!value) throw new Error('Telegram configuration is missing. Run `bun run secrets --telegram` first.')
  return value
}
const [token, secret, address] = await Promise.all([
  get('/substrate/telegram/bot-token'), get('/substrate/telegram/webhook-secret'), get('/substrate/public-url'),
])
const publicUrl = new URL(address)
if (publicUrl.protocol !== 'https:') throw new Error('Telegram requires the public HTTPS dashboard URL.')
const webhook = new URL('/api/telegram/webhook', publicUrl).toString()
const probe = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: '{}', signal: AbortSignal.timeout(15_000) })
if (!probe.ok) throw new Error('The deployed control service has not loaded this Telegram configuration. Deploy control first.')
const telegram = new Telegram(token)
const current = await telegram.call<{ url: string }>('getWebhookInfo', {})
if (current.url && current.url !== webhook) throw new Error('This bot already has another webhook. Use a dedicated Substrate bot; the existing webhook was left unchanged.')
await telegram.call('setWebhook', { url: webhook, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: false })
console.log('Telegram webhook registered. Open Settings → Task notifications to connect your own private chat.')
