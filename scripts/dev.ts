// Runs the control API and the web dev server together. No AWS needed: the
// control API reports "no host configured" unless SUBSTRATE_HOST_INSTANCE_ID is set.
//
// `bun run dev --host` also opens an SSM tunnel to hostd on the real sandbox
// host, so the local UI can create VMs and open terminals without anything
// being public. It uses the Clerk keys from Parameter Store when they exist
// (sign in as on the real site), and otherwise, or with `--no-login`, runs
// without sign-in. It needs AWS credentials and the Session Manager plugin.
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm'
import { join } from 'node:path'
import { region, stackOutputs } from './lib/aws.ts'

const root = join(import.meta.dir, '..')
const TUNNEL_PORT = '17070'
const procs: Bun.Subprocess[] = []
const env: Record<string, string | undefined> = { ...process.env, PORT: '8080' }

if (process.argv.includes('--host')) {
  const out = await stackOutputs()
  const { Parameters = [] } = await new SSMClient({ region }).send(
    new GetParametersCommand({
      Names: ['/substrate/hostd-token', '/substrate/clerk-publishable-key', '/substrate/clerk-secret-key'],
      WithDecryption: true,
    }),
  )
  const param = (name: string) => Parameters.find((p) => p.Name === `/substrate/${name}`)?.Value
  const hostdToken = param('hostd-token')
  if (!hostdToken) {
    console.error('no /substrate/hostd-token in Parameter Store: run `bun run secrets`, then `bun run deploy:host`')
    process.exit(1)
  }
  const noLogin = process.argv.includes('--no-login')
  const clerk = !noLogin && param('clerk-publishable-key') && param('clerk-secret-key')
  if (!clerk && !noLogin) console.log('no Clerk keys in Parameter Store: running without sign-in (`bun run secrets --clerk` adds them)')
  procs.push(
    Bun.spawn(
      [
        'aws', 'ssm', 'start-session', '--region', region, '--target', out.HostInstanceId,
        '--document-name', 'AWS-StartPortForwardingSession',
        '--parameters', JSON.stringify({ portNumber: ['7070'], localPortNumber: [TUNNEL_PORT] }),
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    ),
  )
  Object.assign(env, {
    SUBSTRATE_HOST_INSTANCE_ID: out.HostInstanceId,
    SUBSTRATE_HOSTD_URL: `http://127.0.0.1:${TUNNEL_PORT}`,
    SUBSTRATE_HOSTD_TOKEN: hostdToken,
    CLERK_PUBLISHABLE_KEY: clerk ? param('clerk-publishable-key') : undefined,
    CLERK_SECRET_KEY: clerk ? param('clerk-secret-key') : undefined,
    // Without Clerk keys: this control API only listens on localhost, so VMs
    // without sign-in are fine here.
    SUBSTRATE_VMS_WITHOUT_LOGIN: clerk ? undefined : '1',
  })
}

procs.push(
  Bun.spawn(['bun', '--watch', 'src/index.ts'], {
    cwd: join(root, 'apps/control'),
    env,
    stdio: ['inherit', 'inherit', 'inherit'],
  }),
  Bun.spawn(['bun', 'run', 'dev'], {
    cwd: join(root, 'apps/web'),
    stdio: ['inherit', 'inherit', 'inherit'],
  }),
)

const stop = () => {
  for (const p of procs) p.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
await Promise.race(procs.map((p) => p.exited))
stop()
