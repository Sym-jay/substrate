import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation'
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import {
  DescribeInstanceInformationCommand,
  GetCommandInvocationCommand,
  SendCommandCommand,
  SSMClient,
} from '@aws-sdk/client-ssm'
import { config } from '../../infra/lib/config.ts'

export const region = config.region
export const ec2 = new EC2Client({ region })
const cloudformation = new CloudFormationClient({ region })
const s3 = new S3Client({ region })
const ssm = new SSMClient({ region })

const outputKeys = [
  'Url',
  'ArtifactsBucket',
  'ControlInstanceId',
  'HostInstanceId',
  'HostDataVolumeId',
] as const
export type Outputs = Record<(typeof outputKeys)[number], string>

export async function stackOutputs(): Promise<Outputs> {
  const res = await cloudformation
    .send(new DescribeStacksCommand({ StackName: config.stackName }))
    .catch((err: Error) => {
      if (err.name === 'ValidationError') {
        throw new Error(`stack ${config.stackName} isn't deployed. Run \`bun run deploy:infra\` first.`)
      }
      throw err
    })
  const found = new Map((res.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]))
  const outputs = {} as Outputs
  for (const key of outputKeys) {
    const value = found.get(key)
    if (!value) throw new Error(`stack output ${key} is missing. Is the stack up to date?`)
    outputs[key] = value
  }
  return outputs
}

export async function instanceState(instanceId: string) {
  const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
  return res.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? 'unknown'
}

export async function upload(bucket: string, key: string, body: Uint8Array | string) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }))
}

export async function isSsmOnline(instanceId: string) {
  const res = await ssm.send(
    new DescribeInstanceInformationCommand({
      Filters: [{ Key: 'InstanceIds', Values: [instanceId] }],
    }),
  )
  return res.InstanceInformationList?.[0]?.PingStatus === 'Online'
}

export async function waitForSsm(instanceId: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await isSsmOnline(instanceId))) {
    if (Date.now() > deadline) throw new Error(`${instanceId} never came online in SSM`)
    await Bun.sleep(5_000)
  }
}

export type RunResult = { ok: boolean; status: string; stdout: string; stderr: string }

// Runs a shell script on an instance through SSM and waits for it to finish.
// SSM keeps only the last 24 KB of each stream.
export async function run(instanceId: string, script: string, timeoutSeconds = 900): Promise<RunResult> {
  const sent = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: 'AWS-RunShellScript',
      Parameters: { commands: [script], executionTimeout: [String(timeoutSeconds)] },
    }),
  )
  const commandId = sent.Command?.CommandId
  if (!commandId) throw new Error('SSM did not return a command ID')

  for (;;) {
    await Bun.sleep(2_000)
    const inv = await ssm
      .send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }))
      .catch((err: Error) => {
        // The invocation takes a moment to exist after SendCommand returns.
        if (err.name === 'InvocationDoesNotExist') return null
        throw err
      })
    if (!inv || ['Pending', 'InProgress', 'Delayed'].includes(inv.Status ?? '')) continue
    return {
      ok: inv.Status === 'Success',
      status: inv.Status ?? 'unknown',
      stdout: inv.StandardOutputContent ?? '',
      stderr: inv.StandardErrorContent ?? '',
    }
  }
}

export function printRun(result: RunResult) {
  if (result.stdout.trim()) console.log(result.stdout.trimEnd())
  if (result.stderr.trim()) console.error(result.stderr.trimEnd())
}
