// Ships hostd, the guest agent and the image scripts to the sandbox host as
// source, runs host setup, then builds and (re)starts hostd there. Building on
// the host avoids uploading large compiled binaries. Running VMs keep running.
import { $ } from 'bun'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

const version = (await $`git describe --always --dirty`.cwd(root).text()).trim()
// Staged outside the repo, so `bun test` never picks up the copied test files.
const work = await mkdtemp(join(tmpdir(), 'substrate-host-'))
const staging = join(work, 'src')
console.log(`packing ${version}`)
const skip = (src: string) => !/\/(node_modules|dist)(\/|$)/.test(src)
for (const path of ['tsconfig.base.json', 'packages/protocol', 'apps/hostd', 'apps/guestd', 'images/guest', 'images/host']) {
  await cp(join(root, path), join(staging, path), { recursive: true, filter: skip })
}
await Bun.write(
  join(staging, 'package.json'),
  JSON.stringify({ name: 'substrate-host', private: true, workspaces: ['packages/protocol', 'apps/hostd', 'apps/guestd'] }),
)
await Bun.write(join(staging, 'VERSION'), `${version}\n`)
const tarball = join(work, 'src.tar.gz')
await $`tar --no-xattrs -czf ${tarball} -C ${staging} .`.env({ ...process.env, COPYFILE_DISABLE: '1' })

await upload(out.ArtifactsBucket, 'host/src.tar.gz', await Bun.file(tarball).bytes())
await upload(out.ArtifactsBucket, 'host/setup-host.sh', await Bun.file(join(root, 'images/host/setup-host.sh')).text())
await rm(work, { recursive: true, force: true })

console.log('setting up the host and installing hostd (the first run takes a few minutes)')
const result = await run(
  out.HostInstanceId,
  [
    'set -e',
    'export PATH="$PATH:/snap/bin:/usr/local/bin"',
    'for i in $(seq 60); do command -v aws >/dev/null && break; sleep 5; done',
    'mkdir -p /opt/substrate',
    `aws s3 cp --quiet s3://${out.ArtifactsBucket}/host/setup-host.sh /opt/substrate/setup-host.sh`,
    'bash /opt/substrate/setup-host.sh',
    `aws s3 cp --quiet s3://${out.ArtifactsBucket}/host/src.tar.gz /tmp/substrate-src.tar.gz`,
    'tar -xzf /tmp/substrate-src.tar.gz -O ./images/host/install-hostd.sh >/opt/substrate/install-hostd.sh',
    'bash /opt/substrate/install-hostd.sh /tmp/substrate-src.tar.gz',
    'rm -f /tmp/substrate-src.tar.gz',
  ].join('\n'),
)
printRun(result)
if (!result.ok) {
  console.error(`deploy failed (${result.status})`)
  process.exit(1)
}
