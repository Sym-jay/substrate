// Operator fallback when deploy credentials cannot create Parameter Store keys.
// Only an RSA-sealed payload enters S3/SSM. Plaintext is written on control to
// a root-only EnvironmentFile; the one-use private key never leaves that box.
import { constants, publicEncrypt, randomBytes, randomUUID } from 'node:crypto'
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { run, stackOutputs, upload, region } from './lib/aws.ts'
import { readSecret } from './lib/read-secret.ts'
import { Telegram } from '../apps/control/src/telegram.ts'

const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || await readSecret('Telegram bot token')
if (!/^\d{5,20}:[A-Za-z0-9_-]{30,100}$/.test(token)) throw new Error('Invalid Telegram bot token format')
const telegram = new Telegram(token)
const bot = await telegram.call<{ is_bot: boolean; username: string }>('getMe', {})
if (!bot.is_bot || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username)) throw new Error('Telegram did not identify a bot')
const out = await stackOutputs()
const existing = await telegram.call<{ url: string }>('getWebhookInfo', {})
if (existing.url && existing.url !== new URL('/api/telegram/webhook', out.Url).toString()) throw new Error('This bot has another webhook; use a dedicated Substrate bot')
const marker = randomUUID(), base = `/run/substrate-telegram-${marker}`, object = `control/releases/${marker}/telegram.sealed`
try {
  const key = await run(out.ControlInstanceId, `set -eu
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out ${base}.key 2>/dev/null
openssl pkey -in ${base}.key -pubout`, 60)
  if (!key.ok) throw new Error('Could not prepare an encrypted configuration transfer')
  const sealed = publicEncrypt({ key: key.stdout, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(JSON.stringify({ token, username: bot.username, secret: randomBytes(32).toString('hex') })))
  await upload(out.ArtifactsBucket, object, sealed)
  const installed = await run(out.ControlInstanceId, `set -eu
umask 077
trap 'rm -f ${base}.key ${base}.sealed ${base}.json' EXIT
aws s3 cp --quiet s3://${out.ArtifactsBucket}/${object} ${base}.sealed
openssl pkeyutl -decrypt -inkey ${base}.key -in ${base}.sealed -out ${base}.json -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256
python3 - <<'PY'
import json,os,re
data=json.load(open('${base}.json'))
assert re.fullmatch(r'[0-9]{5,20}:[A-Za-z0-9_-]{30,100}',data['token'])
assert re.fullmatch(r'[A-Za-z0-9_]{5,32}',data['username'])
path='/etc/substrate/telegram.env'
previous={}
if os.path.exists(path):
    for line in open(path):
        if '=' in line:
            k,v=line.rstrip('\\n').split('=',1); previous[k]=v
secret=previous.get('SUBSTRATE_TELEGRAM_WEBHOOK_SECRET','') if previous.get('SUBSTRATE_TELEGRAM_BOT_USERNAME')==data['username'] else ''
if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}',secret): secret=data['secret']
os.makedirs('/etc/substrate',exist_ok=True)
temporary=path+'.${marker}'
try:
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:
        f.write('SUBSTRATE_TELEGRAM_BOT_TOKEN='+data['token']+'\\nSUBSTRATE_TELEGRAM_BOT_USERNAME='+data['username']+'\\nSUBSTRATE_TELEGRAM_WEBHOOK_SECRET='+secret+'\\n')
        f.flush(); os.fsync(f.fileno())
    os.replace(temporary,path)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
assert os.stat(path).st_mode & 0o777 == 0o600
print('Telegram configuration installed in the root-only control EnvironmentFile.')
PY`, 60)
  if (!installed.ok) throw new Error('Encrypted Telegram configuration install failed; no secret was logged')
  console.log(installed.stdout.trim())
  console.log('Next: deploy control, then run `bun run telegram:setup --control`.')
} finally {
  await run(out.ControlInstanceId, `rm -f ${base}.key ${base}.sealed ${base}.json`, 30).catch(() => {})
  await new S3Client({ region }).send(new DeleteObjectCommand({ Bucket: out.ArtifactsBucket, Key: object })).catch(() => {})
}
