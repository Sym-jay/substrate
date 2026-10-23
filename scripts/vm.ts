// Manage microVMs on the sandbox host from your machine.
//   bun run vm list
//   bun run vm create [--name NAME] [--size large|medium|small] [--disk GIB]
//   bun run vm start|stop|delete VM
//   bun run vm exec VM [--root] -- COMMAND...
//   bun run vm capacity
// VM is an id (vm-xxxxxxxx) or a name.
import type { Capacity, ExecResult, Vm } from '@substrate/protocol'
import { stackOutputs } from './lib/aws.ts'
import { errorMessage, hostd } from './lib/hostd.ts'

const [command, ...args] = process.argv.slice(2)
const { HostInstanceId: host } = await stackOutputs()

const usage = () => {
  console.error('usage: bun run vm list | create [--name N] [--size S] [--disk GIB] | start|stop|delete VM | exec VM [--root] -- CMD | capacity')
  process.exit(1)
}

function option(name: string) {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
  const res = await hostd<T>(host, method, path, body)
  if (res.status >= 400) {
    console.error(errorMessage(res))
    process.exit(1)
  }
  return res.data
}

async function resolve(ref: string | undefined) {
  if (!ref) usage()
  if (ref!.startsWith('vm-')) return ref!
  const vm = (await call<Vm[]>('GET', '/vms')).find((v) => v.name === ref)
  if (!vm) {
    console.error(`no VM named ${ref}`)
    process.exit(1)
  }
  return vm.id
}

function describe(vm: Vm) {
  const boot = vm.bootMs === null ? '' : `, booted in ${(vm.bootMs / 1000).toFixed(1)} s`
  return `${vm.id} ${vm.name}: ${vm.state}, ${vm.vcpus} vCPU / ${vm.memMib / 1024} GiB RAM / ${vm.diskGib} GiB disk, ${vm.guestIp}${boot}`
}

switch (command) {
  case 'list': {
    const vms = await call<Vm[]>('GET', '/vms')
    if (!vms.length) console.log('no VMs')
    for (const vm of vms) console.log(describe(vm))
    break
  }
  case 'create': {
    console.log('creating…')
    const disk = option('disk')
    const vm = await call<Vm>('POST', '/vms', {
      name: option('name'),
      size: option('size'),
      diskGib: disk === undefined ? undefined : Number(disk),
    })
    console.log(describe(vm))
    break
  }
  case 'start':
  case 'stop':
    console.log(describe(await call<Vm>('POST', `/vms/${await resolve(args[0])}/${command}`)))
    break
  case 'delete':
    await call('DELETE', `/vms/${await resolve(args[0])}`)
    console.log('deleted')
    break
  case 'exec': {
    const dash = args.indexOf('--')
    const cmd = dash === -1 ? '' : args.slice(dash + 1).join(' ')
    if (!cmd) usage()
    const result = await call<ExecResult>('POST', `/vms/${await resolve(args[0])}/exec`, {
      command: cmd,
      user: args.slice(0, dash).includes('--root') ? 'root' : 'dev',
    })
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    if (result.timedOut) console.error('timed out')
    process.exit(result.exitCode ?? 1)
  }
  case 'capacity': {
    const c = await call<Capacity>('GET', '/capacity')
    console.log(`${c.vcpus} vCPU, ${c.memFreeMib} of ${c.memTotalMib} MiB free (${c.memUsedMib} used by VMs, ${c.memReservedMib} kept for the host)`)
    break
  }
  default:
    usage()
}
