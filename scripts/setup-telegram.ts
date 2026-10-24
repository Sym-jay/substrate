// Register the dedicated bot only after control has loaded its configuration.
// Tokens stay in memory. --control uses the deployment's existing SSM access,
// including root-only fallback configuration, without returning secrets locally.
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { Telegram } from '../apps/control/src/telegram.ts'
import { region, run, stackOutputs } from './lib/aws.ts'

if (process.argv.includes('--control')) await onControl()
else await fromParameters()

async function fromParameters() {
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
}

async function onControl() {
  const out = await stackOutputs()
  const result = await run(out.ControlInstanceId, `python3 - <<'PY'
import json,subprocess,urllib.request,urllib.parse
try:
    pid=subprocess.check_output(['systemctl','show','-p','MainPID','--value','substrate-control']).decode().strip()
    entries=open('/proc/'+pid+'/environ','rb').read().split(b'\\x00')
    env=dict(entry.decode().split('=',1) for entry in entries if b'=' in entry)
    token=env['SUBSTRATE_TELEGRAM_BOT_TOKEN']; secret=env['SUBSTRATE_TELEGRAM_WEBHOOK_SECRET']
    address=env['SUBSTRATE_PUBLIC_URL']
    if urllib.parse.urlparse(address).scheme!='https': raise ValueError('https required')
    callback=urllib.parse.urljoin(address,'/api/telegram/webhook')
    def call(method,data):
        req=urllib.request.Request('https://api.telegram.org/bot'+token+'/'+method,data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})
        result=json.load(urllib.request.urlopen(req,timeout=15))
        if not result.get('ok'): raise ValueError('Telegram rejected request')
        return result['result']
    probe=urllib.request.Request(callback,data=b'{}',headers={'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret})
    urllib.request.urlopen(probe,timeout=15).close()
    current=call('getWebhookInfo',{})
    if current.get('url') and current['url']!=callback:
        print('Bot already has another webhook; it was left unchanged.'); raise SystemExit(1)
    call('setWebhook',{'url':callback,'secret_token':secret,'allowed_updates':['message'],'drop_pending_updates':False})
    print('Telegram webhook registered using the protected control configuration.')
except Exception:
    print('Telegram registration failed. Verify deployed configuration; secret details were not logged.')
    raise SystemExit(1)
PY`, 60)
  if (!result.ok) throw new Error(result.stdout.trim() || 'Could not register Telegram on control')
  console.log(result.stdout.trim())
}
