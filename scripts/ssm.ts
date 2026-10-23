// Opens a shell on the host or the control box through SSM (no SSH keys or
// open ports). Needs the AWS Session Manager plugin installed locally.
import { region, stackOutputs } from './lib/aws.ts'

const which = process.argv[2]
if (which !== 'host' && which !== 'control') {
  console.error('usage: bun run ssm [host|control]')
  process.exit(1)
}

const out = await stackOutputs()
const target = which === 'host' ? out.HostInstanceId : out.ControlInstanceId
const proc = Bun.spawn(['aws', 'ssm', 'start-session', '--region', region, '--target', target], {
  stdio: ['inherit', 'inherit', 'inherit'],
})
process.exit(await proc.exited)
