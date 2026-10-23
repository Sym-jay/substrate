// Checks Windows workspaces (M9) on the live stack, without the web app. It
// starts an instance from the Windows image with a workspace's first boot and
// the control box's own SSH key, as the control box would. From the control
// box it then checks SSH, the tools, that password sign-in is refused, and
// that VNC answers; from the host, that it can't reach either. It always
// terminates the instance. About 15 minutes and $0.40.
import { RunInstancesCommand, TerminateInstancesCommand, waitUntilInstanceRunning, DescribeInstancesCommand, type _InstanceType } from '@aws-sdk/client-ec2'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { randomBytes } from 'node:crypto'
import { windowsUserData } from '../apps/control/src/windows/user-data.ts'
import { makePassword } from '../apps/control/src/windows/workspaces.ts'
import { config } from '../infra/lib/config.ts'
import { ec2, region, run, stackOutputs } from './lib/aws.ts'

const out = await stackOutputs()
const ssm = new SSMClient({ region })
const param = async (name: string) => (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter!.Value!
const failures: string[] = []
const check = (ok: boolean, what: string, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `: ${detail}` : ''}`)
  if (!ok) failures.push(what)
}
const onControl = async (script: string, timeout = 120) => run(out.ControlInstanceId, script, timeout)

const key = '/var/lib/substrate/windows/id_ed25519'
const publicKey = (await onControl(`cat ${key}.pub`)).stdout.trim()
if (!publicKey.startsWith('ssh-ed25519 ')) throw new Error("the control box has no Windows SSH key yet: deploy the control box first")
const image = await param(config.windows.imageParameter)
const userData = windowsUserData({ password: makePassword(), vncPassword: randomBytes(4).toString('hex'), publicKey })

console.log(`starting a ${config.windows.instanceType} from ${image}`)
const { Instances = [] } = await ec2.send(
  new RunInstancesCommand({
    LaunchTemplate: { LaunchTemplateName: config.windows.launchTemplate },
    ImageId: image,
    InstanceType: config.windows.instanceType as _InstanceType,
    SubnetId: await param(config.windows.subnetParameter),
    MinCount: 1,
    MaxCount: 1,
    UserData: Buffer.from(userData).toString('base64'),
    TagSpecifications: [{ ResourceType: 'instance', Tags: [{ Key: 'project', Value: 'substrate' }, { Key: 'substrate:windows', Value: 'check' }, { Key: 'Name', Value: 'substrate-windows-check' }] }],
  }),
)
const instanceId = Instances[0]!.InstanceId!
console.log(`instance ${instanceId}`)

try {
  await waitUntilInstanceRunning({ client: ec2, maxWaitTime: 600 }, { InstanceIds: [instanceId] })
  const described = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
  const ip = described.Reservations![0]!.Instances![0]!.PrivateIpAddress!
  const ssh = `ssh -i ${key} -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o LogLevel=ERROR Administrator@${ip}`

  console.log(`waiting for its first boot to finish (5–10 minutes)`)
  const started = Date.now()
  for (;;) {
    const probe = await onControl(`${ssh} "if (Test-Path C:\\substrate\\ready) { 'ready' }" 2>&1 || true`, 60)
    if (probe.stdout.trim() === 'ready') break
    if (Date.now() - started > 25 * 60_000) throw new Error(`its first boot didn't finish: ${probe.stdout.trim()}`)
    await Bun.sleep(20_000)
  }
  console.log(`ready after ${Math.round((Date.now() - started) / 60_000)} min`)

  const tools = await onControl(`${ssh} 'git --version; node --version; claude --version; codex --version; $PSVersionTable.PSVersion.ToString(); (Get-Service tvnserver).Status; (Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform).State; Select-String -Path C:\\ProgramData\\ssh\\sshd_config -Pattern "^PasswordAuthentication" | ForEach-Object Line'`)
  console.log(tools.stdout.trim().split('\n').map((l) => `     ${l}`).join('\n'))
  check(tools.ok && /git version/.test(tools.stdout), 'Git', tools.stderr)
  check(/^v\d+/m.test(tools.stdout), 'Node')
  check(/Claude Code/.test(tools.stdout), 'Claude Code')
  check(/codex-cli/.test(tools.stdout), 'Codex')
  check(/^7\./m.test(tools.stdout), 'PowerShell 7 is the SSH shell')
  check(/^Running$/m.test(tools.stdout), 'TightVNC is running')
  check(/^Enabled$/m.test(tools.stdout), 'WSL (Virtual Machine Platform) is on')
  check(/^PasswordAuthentication no$/m.test(tools.stdout), 'sshd_config turns password sign-in off')

  const password = await onControl(`ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive -o BatchMode=yes -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no Administrator@${ip} true 2>&1 || true`)
  check(/Permission denied \(publickey\)/.test(password.stdout), 'SSH refuses passwords', password.stdout.trim())

  const vnc = await onControl(`timeout 5 bash -c 'exec 3<>/dev/tcp/${ip}/5900; head -c 12 <&3' || true`)
  check(/^RFB 003\.00\d/.test(vnc.stdout), 'VNC answers the control box', vnc.stdout.trim())

  const fromHost = await run(out.HostInstanceId, `for port in 22 5900; do if timeout 5 bash -c "</dev/tcp/${ip}/$port" 2>/dev/null; then echo "$port open"; else echo "$port closed"; fi; done`, 60)
  check(/22 closed/.test(fromHost.stdout) && /5900 closed/.test(fromHost.stdout), "the host can't reach its SSH or VNC", fromHost.stdout.trim())
} finally {
  await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }))
  console.log(`terminated ${instanceId}`)
}

if (failures.length) {
  console.error(`${failures.length} check${failures.length === 1 ? '' : 's'} failed`)
  process.exit(1)
}
console.log('all checks passed')
