// Puts the secrets the boxes read at deploy time into Parameter Store, so no
// secret ever passes through a shell, a chat or this repo. Safe to run again.
//   bun run secrets          creates the hostd token if it doesn't exist yet
//   bun run secrets --clerk  also (re)loads the Clerk keys from Substrate's Clerk
//                            application; run `bunx clerk@latest auth login` first
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { $ } from 'bun'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { region } from './lib/aws.ts'

// The Clerk application Substrate signs users in with. An ID, not a secret.
const CLERK_APP = 'app_3KhDR11hpqRLdJHJVORK4UDj6PK'

// control → hostd. install-hostd.sh and setup-control.sh both read it.
const HOSTD_TOKEN = '/substrate/hostd-token'
// Read by setup-control.sh. The publishable key is public (it ships to browsers).
const CLERK_PUBLISHABLE_KEY = '/substrate/clerk-publishable-key'
const CLERK_SECRET_KEY = '/substrate/clerk-secret-key'

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

console.log('To use them: `bun run deploy:host` and `bun run deploy:control`.')

function parseEnv(text: string) {
  const vars: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) vars[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return vars
}
