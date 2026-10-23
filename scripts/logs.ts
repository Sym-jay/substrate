// Recent logs, fetched over SSM, so nothing needs to be open.
//   bun run logs host [-n LINES]     hostd: VM lifecycle, auto-pause, alerts, recoveries
//   bun run logs control [-n LINES]  the control API
//   bun run logs VM [-n LINES]       a VM's console (kept on the host) and, if it's
//                                    running, its own journal from inside
// VM is an id (vm-xxxxxxxx) or a name. SSM returns at most about 24 KB, so a
// long log comes back cut short; ask for fewer lines.
import type { Vm } from '@substrate/protocol'
import { run, stackOutputs } from './lib/aws.ts'
import { errorMessage, hostd } from './lib/hostd.ts'

const [target, ...args] = process.argv.slice(2)
const flag = args.indexOf('-n')
const lines = flag === -1 ? 100 : Number(args[flag + 1])
if (!target || !Number.isInteger(lines) || lines < 1) {
  console.error('usage: bun run logs host|control|VM [-n LINES]')
  process.exit(1)
}

const out = await stackOutputs()

async function show(instanceId: string, title: string, script: string) {
  const result = await run(instanceId, script)
  console.log(`── ${title} ──`)
  console.log(result.ok ? result.stdout.trimEnd() || '(empty)' : `couldn't read it: ${result.stderr.trim() || result.status}`)
}
const journal = (unit: string) => `journalctl -u ${unit} -n ${lines} --no-pager -o short-iso`

if (target === 'host') {
  await show(out.HostInstanceId, 'hostd', journal('substrate-hostd'))
} else if (target === 'control') {
  await show(out.ControlInstanceId, 'control API', journal('substrate-control'))
} else {
  const res = await hostd<Vm[]>(out.HostInstanceId, 'GET', '/vms')
  if (res.status !== 200) {
    console.error(errorMessage(res))
    process.exit(1)
  }
  const vm = res.data.find((v) => v.id === target || v.name === target)
  if (!vm) {
    console.error(`no VM ${target}`)
    process.exit(1)
  }
  await show(out.HostInstanceId, `${vm.name}: console`, journal(`substrate-vm-${vm.id}`))
  if (vm.state !== 'running') {
    console.log(`── ${vm.name} is ${vm.state}, so there's no journal from inside it ──`)
  } else {
    // Through hostd's exec, printing the text rather than JSON, so a long log
    // is cut short rather than unreadable.
    const body = JSON.stringify({ command: `journalctl -b -n ${lines} --no-pager -o short-iso`, user: 'root' })
    await show(out.HostInstanceId, `${vm.name}: its own journal`, [
      'token=$(cat /var/lib/substrate/hostd-token)',
      `printf %s '${Buffer.from(body).toString('base64')}' | base64 -d |`,
      `  curl -s -H "Authorization: Bearer $token" -H 'content-type: application/json' --data-binary @- http://127.0.0.1:7070/vms/${vm.id}/exec |`,
      "  jq -r '.stdout // .error'",
    ].join('\n'))
  }
}
