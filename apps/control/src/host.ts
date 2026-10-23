import { DescribeInstancesCommand, EC2Client, type Instance } from '@aws-sdk/client-ec2'
import { HostStatus, InstanceState } from '@substrate/protocol'

export function toHostStatus(instance: Instance): HostStatus {
  const state = InstanceState.parse(instance.State?.Name)
  return {
    configured: true,
    instanceId: instance.InstanceId ?? '',
    instanceType: instance.InstanceType ?? '',
    state,
    launchedAt: state === 'running' ? (instance.LaunchTime?.toISOString() ?? null) : null,
  }
}

// Reads the sandbox host's EC2 state. Cached briefly so a page refreshing
// every few seconds doesn't turn into an EC2 API call per request.
export function createHostReader(instanceId: string | null, region: string, cacheMs = 5_000) {
  if (!instanceId) return async (): Promise<HostStatus> => ({ configured: false })

  const ec2 = new EC2Client({ region })
  let cached: { at: number; status: HostStatus } | null = null

  return async (): Promise<HostStatus> => {
    if (cached && Date.now() - cached.at < cacheMs) return cached.status
    const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
    const instance = out.Reservations?.[0]?.Instances?.[0]
    if (!instance) throw new Error(`host instance ${instanceId} not found`)
    const status = toHostStatus(instance)
    cached = { at: Date.now(), status }
    return status
  }
}
