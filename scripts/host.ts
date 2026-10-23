// Start, stop or check the sandbox host. It costs about $1.15/h while running,
// so stop it when you're done (until M5 does this automatically).
import {
  StartInstancesCommand,
  StopInstancesCommand,
  waitUntilInstanceRunning,
  waitUntilInstanceStopped,
} from '@aws-sdk/client-ec2'
import { ec2, instanceState, stackOutputs, waitForSsm } from './lib/aws.ts'

const action = process.argv[2] ?? 'status'
const { HostInstanceId: id } = await stackOutputs()

switch (action) {
  case 'status':
    console.log(`host ${id} is ${await instanceState(id)}`)
    break
  case 'start':
    await ec2.send(new StartInstancesCommand({ InstanceIds: [id] }))
    console.log('starting…')
    await waitUntilInstanceRunning({ client: ec2, maxWaitTime: 600 }, { InstanceIds: [id] })
    await waitForSsm(id)
    console.log(`host ${id} is running and reachable over SSM`)
    break
  case 'stop':
    await ec2.send(new StopInstancesCommand({ InstanceIds: [id] }))
    console.log('stopping…')
    await waitUntilInstanceStopped({ client: ec2, maxWaitTime: 600 }, { InstanceIds: [id] })
    console.log(`host ${id} is stopped`)
    break
  default:
    console.error('usage: bun run host [status|start|stop]')
    process.exit(1)
}
