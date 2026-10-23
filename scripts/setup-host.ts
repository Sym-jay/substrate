// Ships images/host/setup-host.sh to the sandbox host and runs it.
import { join } from 'node:path'
import { instanceState, printRun, run, stackOutputs, upload, waitForSsm } from './lib/aws.ts'

const root = join(import.meta.dir, '..')
const out = await stackOutputs()

const state = await instanceState(out.HostInstanceId)
if (state !== 'running') {
  console.error(`the host is ${state}. Start it with \`bun run host start\`.`)
  process.exit(1)
}
await waitForSsm(out.HostInstanceId)

await upload(
  out.ArtifactsBucket,
  'host/setup-host.sh',
  await Bun.file(join(root, 'images/host/setup-host.sh')).text(),
)

console.log('running setup-host.sh on the host (the first run takes a few minutes)')
const result = await run(
  out.HostInstanceId,
  [
    'set -e',
    // The AWS CLI comes from a snap the first boot installs; it may still be on its way.
    'export PATH="$PATH:/snap/bin"',
    'for i in $(seq 60); do command -v aws >/dev/null && break; sleep 5; done',
    'mkdir -p /opt/substrate',
    `aws s3 cp --quiet s3://${out.ArtifactsBucket}/host/setup-host.sh /opt/substrate/setup-host.sh`,
    'bash /opt/substrate/setup-host.sh',
  ].join('\n'),
)
printRun(result)
if (!result.ok) {
  console.error(`setup failed (${result.status})`)
  process.exit(1)
}
