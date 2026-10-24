// Puts the secrets the boxes read at deploy time into Parameter Store, so no
// secret ever passes through a shell, a chat or this repo. Safe to run again.
//   bun run secrets          creates the hostd token if it doesn't exist yet
//   bun run secrets --clerk  also (re)loads the Clerk keys from Substrate's Clerk
//                            application; run `bunx clerk@latest auth login` first
//   bun run secrets --ntfy   also creates the ntfy topic for alerts (docs/m4.md),
//                            and prints it so you can subscribe
//   bun run secrets --github-oauth
//                            also asks for the GitHub OAuth app's client ID and
//                            secret, for "Connect GitHub" (docs/phase2.md)
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { $ } from 'bun'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { region } from './lib/aws.ts'
import { readSecret } from './lib/read-secret.ts'
import { Telegram } from '../apps/control/src/telegram.ts'

// The Clerk application Substrate signs users in with. An ID, not a secret.
const CLERK_APP = 'app_3KhDR11hpqRLdJHJVORK4UDj6PK'

// control → hostd. install-hostd.sh and setup-control.sh both read it.
const HOSTD_TOKEN = '/substrate/hostd-token'
// Read by setup-control.sh. The publishable key is public (it ships to browsers).
const CLERK_PUBLISHABLE_KEY = '/substrate/clerk-publishable-key'
const CLERK_SECRET_KEY = '/substrate/clerk-secret-key'
// Read by install-hostd.sh. Anyone who knows the topic can read its alerts.
const NTFY_TOPIC = '/substrate/ntfy-topic'
// Read by setup-control.sh, for users connecting GitHub (Phase 2).
const GITHUB_CLIENT_ID = '/substrate/github-oauth/client-id'
const GITHUB_CLIENT_SECRET = '/substrate/github-oauth/client-secret'
// Written by the stack: where GitHub sends users back to.
const PUBLIC_URL = '/substrate/public-url'

const ssm = new SSMClient({ region })

const exists = (name: string) =>
  ssm
    .send(new GetParameterCommand({ Name: name }))
    .then(() => true)
    .catch((err: Error) => {
      if (err.name === 'ParameterNotFound') return false
      throw err
    })

const put = (name: string, value: string, type: 'String' | 'SecureString') =>
  ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: type, Overwrite: true }))

if (await exists(HOSTD_TOKEN)) {
  console.log(`${HOSTD_TOKEN} already exists`)
} else {
  await put(HOSTD_TOKEN, randomBytes(32).toString('hex'), 'SecureString')
  console.log(`created ${HOSTD_TOKEN}`)
}

if (process.argv.includes('--clerk')) {
  // `clerk env pull` writes the keys to a file. Read them from there straight
  // into Parameter Store, then delete the file. They're never printed.
  const dir = await mkdtemp(join(tmpdir(), 'substrate-clerk-'))
  try {
    const file = join(dir, '.env')
    const pull = await $`bunx clerk@latest env pull --app ${CLERK_APP} --file ${file}`.cwd(dir).quiet().nothrow()
    if (pull.exitCode !== 0 || !(await Bun.file(file).exists())) {
      console.error('`clerk env pull` failed. Run `bunx clerk@latest auth login` first, then try again.')
      process.exit(1)
    }
    const vars = parseEnv(await Bun.file(file).text())
    // The CLI prefixes names per framework (VITE_, NEXT_PUBLIC_, ...), so match the ending.
    const publishable = Object.entries(vars).find(([k]) => k.endsWith('CLERK_PUBLISHABLE_KEY'))?.[1]
    const secret = Object.entries(vars).find(([k]) => k.endsWith('CLERK_SECRET_KEY'))?.[1]
    if (!publishable?.startsWith('pk_') || !secret?.startsWith('sk_')) {
      console.error("`clerk env pull` didn't return both a publishable and a secret key")
      process.exit(1)
    }
    await put(CLERK_PUBLISHABLE_KEY, publishable, 'String')
    await put(CLERK_SECRET_KEY, secret, 'SecureString')
    const instance = publishable.startsWith('pk_live_') ? 'production' : 'development'
    console.log(`stored the Clerk ${instance} keys in ${CLERK_PUBLISHABLE_KEY} and ${CLERK_SECRET_KEY}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
} else if (!(await exists(CLERK_SECRET_KEY))) {
  console.log('no Clerk keys yet: run `bunx clerk@latest auth login`, then `bun run secrets --clerk`')
}

if (process.argv.includes('--ntfy')) {
  if (!(await exists(NTFY_TOPIC))) {
    // Unguessable, since ntfy.sh topics are open to anyone who knows the name.
    await put(NTFY_TOPIC, `substrate-${randomBytes(12).toString('hex')}`, 'SecureString')
    console.log(`created ${NTFY_TOPIC}`)
  }
  const topic = (await ssm.send(new GetParameterCommand({ Name: NTFY_TOPIC, WithDecryption: true }))).Parameter?.Value
  console.log(`Alerts go to https://ntfy.sh/${topic}. Subscribe to "${topic}" in the ntfy app, and keep the name private.`)
}

if (process.argv.includes('--github-oauth')) {
  const publicUrl = await ssm.send(new GetParameterCommand({ Name: PUBLIC_URL })).then((res) => res.Parameter?.Value, () => undefined)
  console.log('Create an OAuth app at https://github.com/settings/applications/new with')
  console.log(`  Authorization callback URL: ${publicUrl ?? 'https://<the dashboard>'}/api/github/callback`)
  const clientId = prompt('Client ID:')?.trim() ?? ''
  if (!/^[A-Za-z0-9._-]{8,}$/.test(clientId)) {
    console.error("that doesn't look like a client ID")
    process.exit(1)
  }
  const clientSecret = await readSecret('Client secret')
  if (!/^[A-Za-z0-9_]{20,}$/.test(clientSecret)) {
    console.error("that doesn't look like a client secret")
    process.exit(1)
  }
  await put(GITHUB_CLIENT_ID, clientId, 'String')
  await put(GITHUB_CLIENT_SECRET, clientSecret, 'SecureString')
  console.log(`stored the GitHub OAuth app in ${GITHUB_CLIENT_ID} and ${GITHUB_CLIENT_SECRET}`)
}

if (process.argv.includes('--telegram')) {
  console.log('Create a dedicated bot with @BotFather in Telegram. Its token is entered privately below.')
  const token = await readSecret('Telegram bot token')
  if (!/^\d{5,20}:[A-Za-z0-9_-]{30,100}$/.test(token)) throw new Error('That does not look like a Telegram bot token.')
  const bot = await new Telegram(token).call<{ is_bot: boolean; username: string }>('getMe', {})
  if (!bot.is_bot || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username)) throw new Error('Telegram did not return a bot username.')
  const name = '/substrate/telegram/webhook-secret'
  const webhookSecret = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
    .then((result) => result.Parameter!.Value!, (error: Error) => { if (error.name === 'ParameterNotFound') return randomBytes(32).toString('hex'); throw error })
  await put('/substrate/telegram/bot-token', token, 'SecureString')
  await put('/substrate/telegram/bot-username', bot.username, 'String')
  await put(name, webhookSecret, 'SecureString')
  console.log(`Stored Telegram configuration for @${bot.username}. No token was printed.`)
}

console.log(process.argv.includes('--telegram')
  ? 'Next: `bun run deploy:control`, then `bun run telegram:setup`. No host deployment is needed for Telegram.'
  : 'To use them: `bun run deploy:host` and `bun run deploy:control`.')

function parseEnv(text: string) {
  const vars: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) vars[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return vars
}
