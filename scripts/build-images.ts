// Builds the guest kernel and a new root filesystem on the sandbox host.
// New VMs get the new image; existing VMs keep theirs. Takes 10–20 minutes.
import { instanceState, printRun, run, stackOutputs, waitForSsm } from './lib/aws.ts'

const out = await stackOutputs()
const state = await instanceState(out.HostInstanceId)
if (state !== 'running') {
  console.error(`the host is ${state}. Start it with \`bun run host start\`.`)
  process.exit(1)
}
await waitForSsm(out.HostInstanceId)

console.log('building images on the host (10–20 minutes; progress shows when it finishes)')
const started = Date.now()
const result = await run(out.HostInstanceId, 'bash /opt/substrate/hostd/current/images/guest/build-images.sh', 3_600)
printRun(result)
console.log(`took ${Math.round((Date.now() - started) / 60_000)} min`)
if (!result.ok) process.exit(1)
