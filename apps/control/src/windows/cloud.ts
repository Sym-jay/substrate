import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  type _InstanceType,
} from '@aws-sdk/client-ec2'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'

export type InstanceInfo = { state: string; privateIp: string | null }

// What the workspaces need from AWS; tests substitute a fake.
export interface WindowsCloud {
  // Starts a new instance from the newest Substrate Windows image, which runs
  // `userData` at its first boot.
  launch(input: { id: string; name: string; userData: string; instanceType: string }): Promise<string>
  describe(instanceIds: string[]): Promise<Map<string, InstanceInfo>>
  start(instanceId: string): Promise<void>
  stop(instanceId: string): Promise<void>
  terminate(instanceId: string): Promise<void>
  // Its busiest 5-minute average CPU over the last `minutes`, in percent.
  // Null when CloudWatch has nothing yet.
  cpu(instanceId: string, minutes: number): Promise<number | null>
}

type Options = {
  region: string
  subnetId: string
  launchTemplate: string
  // Parameter Store's name for the newest image (`bun run build:windows-image`).
  imageParameter: string
}

export function awsWindowsCloud({ region, subnetId, launchTemplate, imageParameter }: Options): WindowsCloud {
  const ec2 = new EC2Client({ region })
  const ssm = new SSMClient({ region })
  const cloudwatch = new CloudWatchClient({ region })

  return {
    async launch({ id, name, userData, instanceType }) {
      const imageId = (await ssm.send(new GetParameterCommand({ Name: imageParameter })).catch(() => null))?.Parameter?.Value
      if (!imageId) throw new Error('there is no Windows image yet: run `bun run build:windows-image`')
      const tags = [
        { Key: 'project', Value: 'substrate' },
        { Key: 'substrate:windows', Value: 'workspace' },
        { Key: 'substrate:workspace', Value: id },
        { Key: 'Name', Value: `substrate-windows-${name}` },
      ]
      const { Instances = [] } = await ec2.send(
        new RunInstancesCommand({
          LaunchTemplate: { LaunchTemplateName: launchTemplate },
          ImageId: imageId,
          InstanceType: instanceType as _InstanceType,
          SubnetId: subnetId,
          MinCount: 1,
          MaxCount: 1,
          UserData: Buffer.from(userData).toString('base64'),
          TagSpecifications: (['instance', 'volume', 'network-interface'] as const).map((ResourceType) => ({ ResourceType, Tags: tags })),
        }),
      )
      const instanceId = Instances[0]?.InstanceId
      if (!instanceId) throw new Error('EC2 started no instance')
      return instanceId
    },

    async describe(instanceIds) {
      const found = new Map<string, InstanceInfo>()
      if (!instanceIds.length) return found
      const { Reservations = [] } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: instanceIds }))
      for (const instance of Reservations.flatMap((r) => r.Instances ?? [])) {
        found.set(instance.InstanceId!, { state: instance.State?.Name ?? 'unknown', privateIp: instance.PrivateIpAddress ?? null })
      }
      return found
    },

    async start(instanceId) {
      await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }))
    },

    async stop(instanceId) {
      await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }))
    },

    async terminate(instanceId) {
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }))
    },

    async cpu(instanceId, minutes) {
      const end = new Date()
      const { MetricDataResults = [] } = await cloudwatch.send(
        new GetMetricDataCommand({
          StartTime: new Date(end.getTime() - minutes * 60_000),
          EndTime: end,
          MetricDataQueries: [
            {
              Id: 'cpu',
              MetricStat: {
                Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: instanceId }] },
                Period: 300,
                Stat: 'Average',
              },
            },
          ],
        }),
      )
      const values = MetricDataResults[0]?.Values ?? []
      return values.length ? Math.max(...values) : null
    },
  }
}
