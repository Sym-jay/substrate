// Builds the Windows workspace image (M9). It starts a builder from the
// latest Windows Server 2025 image and installs images/windows/provision.ps1's
// list through SSM. It then restarts the builder (for WSL), has EC2Launch
// generalize it (sysprep), and saves it as an image. New workspaces start
// from the newest one; existing ones keep theirs. Takes 30–45 minutes.
// `--keep` leaves the builder up if a step fails, to look into.
import {
  CreateImageCommand,
  DeleteSnapshotCommand,
  DeregisterImageCommand,
  DescribeImagesCommand,
  RebootInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  waitUntilImageAvailable,
  waitUntilInstanceStopped,
  type _InstanceType,
} from '@aws-sdk/client-ec2'
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { join } from 'node:path'
import { config } from '../infra/lib/config.ts'
import { ec2, printRun, region, run, send, waitForSsm } from './lib/aws.ts'

const keep = process.argv.includes('--keep')
const root = join(import.meta.dir, '..')
const ssm = new SSMClient({ region })
const param = async (name: string) => {
  const value = (await ssm.send(new GetParameterCommand({ Name: name })).catch(() => null))?.Parameter?.Value
  if (!value) throw new Error(`${name} isn't in Parameter Store. Run \`bun run deploy:infra\` first.`)
  return value
}
const minutes = (since: number) => `${Math.round((Date.now() - since) / 60_000)} min`
const tags = (kind: string, name: string) => [
  { Key: 'project', Value: 'substrate' },
  { Key: 'substrate:windows', Value: kind },
  { Key: 'Name', Value: name },
]

const started = Date.now()
const baseImage = await param(config.windows.baseImageParameter)
const subnet = await param(config.windows.subnetParameter)
const name = `substrate-windows-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`

console.log(`starting a builder (${config.windows.builderInstanceType}) from ${baseImage}`)
const { Instances = [] } = await ec2.send(
  new RunInstancesCommand({
    LaunchTemplate: { LaunchTemplateName: config.windows.launchTemplate },
    ImageId: baseImage,
    InstanceType: config.windows.builderInstanceType as _InstanceType,
    SubnetId: subnet,
    MinCount: 1,
    MaxCount: 1,
    TagSpecifications: [
      { ResourceType: 'instance', Tags: tags('builder', 'substrate-windows-builder') },
      { ResourceType: 'volume', Tags: tags('builder', 'substrate-windows-builder') },
    ],
  }),
)
const builder = Instances[0]?.InstanceId
if (!builder) throw new Error('EC2 started no builder')
console.log(`builder ${builder}`)

let ok = false
try {
  console.log('waiting for it to boot (5–10 minutes)')
  await waitForSsm(builder, 20 * 60_000)

  console.log('installing (10–20 minutes; progress shows when it finishes)')
  const provision = await run(builder, await Bun.file(join(root, 'images/windows/provision.ps1')).text(), 3_600, 'AWS-RunPowerShellScript')
  printRun(provision)
  if (!provision.ok) throw new Error(`installing failed (${provision.status})`)

  console.log('restarting, to finish turning on WSL')
  await ec2.send(new RebootInstancesCommand({ InstanceIds: [builder] }))
  await Bun.sleep(90_000)
  await waitForSsm(builder, 15 * 60_000)
  for (let attempt = 1; ; attempt++) {
    const back = await run(builder, 'Write-Output ready', 120, 'AWS-RunPowerShellScript')
    if (back.ok) break
    if (attempt === 10) throw new Error("the builder didn't come back after restarting")
    await Bun.sleep(30_000)
  }

  console.log('generalizing (sysprep), which shuts it down')
  await send(builder, await Bun.file(join(root, 'images/windows/sysprep.ps1')).text(), 1_800, 'AWS-RunPowerShellScript')
  await waitUntilInstanceStopped({ client: ec2, maxWaitTime: 1_800 }, { InstanceIds: [builder] })

  console.log(`saving ${name} (10–20 minutes)`)
  const { ImageId } = await ec2.send(
    new CreateImageCommand({
      InstanceId: builder,
      Name: name,
      Description: 'Substrate Windows workspace: Windows Server 2025 with Git, Node, PowerShell 7, Claude Code, Codex, OpenSSH and WSL',
      TagSpecifications: [
        { ResourceType: 'image', Tags: tags('image', name) },
        { ResourceType: 'snapshot', Tags: tags('image', name) },
      ],
    }),
  )
  if (!ImageId) throw new Error('EC2 made no image')
  await waitUntilImageAvailable({ client: ec2, maxWaitTime: 3_600 }, { ImageIds: [ImageId] })
  await ssm.send(new PutParameterCommand({ Name: config.windows.imageParameter, Value: ImageId, Type: 'String', Overwrite: true }))
  console.log(`${ImageId} is the image for new Windows workspaces`)
  ok = true
} finally {
  if (ok || !keep) {
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [builder] }))
    console.log(`terminated the builder ${builder}`)
  } else {
    console.log(`left the builder ${builder} up (--keep); terminate it when you're done`)
  }
}

// Keep the newest two images. Workspaces made from older ones don't need them.
const { Images = [] } = await ec2.send(
  new DescribeImagesCommand({ Owners: ['self'], Filters: [{ Name: 'tag:substrate:windows', Values: ['image'] }] }),
)
for (const old of Images.sort((a, b) => (b.CreationDate ?? '').localeCompare(a.CreationDate ?? '')).slice(2)) {
  await ec2.send(new DeregisterImageCommand({ ImageId: old.ImageId }))
  for (const mapping of old.BlockDeviceMappings ?? []) {
    if (mapping.Ebs?.SnapshotId) await ec2.send(new DeleteSnapshotCommand({ SnapshotId: mapping.Ebs.SnapshotId }))
  }
  console.log(`removed the old image ${old.Name}`)
}
console.log(`done in ${minutes(started)}`)
