// Runs the control API and the web dev server together. No AWS needed: the
// control API reports "no host configured" unless SUBSTRATE_HOST_INSTANCE_ID is set.
//
// `bun run dev --host` also opens an SSM tunnel to hostd on the real sandbox
// host, so the local UI can create VMs and open terminals without anything
// being public. It needs AWS credentials and the Session Manager plugin.
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { join } from 'node:path'
import { region, stackOutputs } from './lib/aws.ts'

const root = join(import.meta.dir, '..')
const TUNNEL_PORT = '17070'
const procs: Bun.Subprocess[] = []
const env: Record<string, string | undefined> = { ...process.env, PORT: '8080' }

if (process.argv.includes('--host')) {
  const out = await stackOutputs()
  const param = await new SSMClient({ region }).send(
    new GetParameterCommand({ Name: '/substrate/hostd-token', WithDecryption: true }),
  )
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
    SUBSTRATE_HOSTD_TOKEN: param.Parameter?.Value,
    // This control API only listens on localhost, so VMs without a login are fine.
    SUBSTRATE_VMS_WITHOUT_LOGIN: '1',
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
