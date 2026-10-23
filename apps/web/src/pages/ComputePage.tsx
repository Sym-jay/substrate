import { AppWindow, Cpu, HardDrive, MemoryStick, Server } from 'lucide-react'
import { useData } from '../app/data.tsx'
import { href } from '../app/router.ts'
import { AsciiBar, Card, Empty, PageHeader, Stat, StateBadge, gb, since } from '../app/ui.tsx'

// The account's on-demand vCPU quota in ap-south-1, shared by everything here.
const VCPU_QUOTA = 64
const CONTROL_VCPUS = 2
const WINDOWS_VCPUS = 16

export function ComputePage() {
  const { status, capacity, vms, windows } = useData()
  const host = status?.host.configured ? status.host : null
  const list = vms ?? []
  const running = list.filter((vm) => vm.state === 'running')
  const windowsOn = (windows ?? []).filter((w) => ['creating', 'starting', 'running', 'stopping'].includes(w.state)).length
  const hostVcpus = host?.state === 'running' ? capacity?.vcpus ?? 0 : 0
  const used = hostVcpus + CONTROL_VCPUS + windowsOn * WINDOWS_VCPUS
  const memVms = capacity?.memUsedMib ?? 0
  const memReserved = capacity?.memReservedMib ?? 0

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader title="Compute" subtitle="The machines your workspaces run on" />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Host" value={host ? host.instanceType : '—'} icon={<Server />} detail={host ? `${host.state}${host.launchedAt ? ` · up ${since(host.launchedAt)}` : ''}` : 'no host configured'} />
        <Stat label="vCPUs" value={capacity?.vcpus ?? '—'} icon={<Cpu />} detail={`${running.reduce((n, vm) => n + vm.vcpus, 0)} given to running VMs (shared)`} />
        <Stat label="Memory" value={capacity ? gb(capacity.memTotalMib) : '—'} icon={<MemoryStick />} detail={capacity ? `${gb(capacity.memFreeMib)} free for new VMs` : 'not reported'} />
        <Stat label="Workspaces" value={`${running.length}/${list.length}`} icon={<HardDrive />} detail={`running · ${list.reduce((n, vm) => n + vm.diskGib, 0)} GB of disks`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Host memory" className="rise">
          {capacity ? <>
            <AsciiBar parts={[{ value: memReserved, char: '+' }, { value: memVms, char: '#' }]} total={capacity.memTotalMib} width={40} label="Host memory: kept for the host, held by VMs, free" />
            <p className="text-faint mono mt-2 text-xs">+ host · # VMs · . free</p>
            <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
              <div><dt className="text-faint text-xs">For VMs</dt><dd className="font-medium">{gb(memVms)}</dd></div>
              <div><dt className="text-faint text-xs">For the host</dt><dd className="font-medium">{gb(memReserved)}</dd></div>
              <div><dt className="text-faint text-xs">Free</dt><dd className="font-medium">{gb(capacity.memFreeMib)}</dd></div>
            </dl>
            <p className="text-faint mt-3 text-xs leading-relaxed">Memory isn’t overcommitted: every VM can use all of its own. CPUs are shared, since agents mostly wait on model APIs.</p>
          </> : <Empty icon={<MemoryStick />} title="Not reported">The host may be stopped.</Empty>}
        </Card>

        <Card title={`Account vCPUs · ${used} of ${VCPU_QUOTA}`} className="rise" style={{ '--i': 1 } as React.CSSProperties}>
          <AsciiBar parts={[{ value: hostVcpus, char: '#' }, { value: CONTROL_VCPUS, char: '+' }, { value: windowsOn * WINDOWS_VCPUS, char: '=' }]} total={VCPU_QUOTA} width={40} label="Account vCPUs" />
          <p className="text-faint mono mt-2 text-xs"># host · + control · = windows · . free</p>
          <ul className="mt-3 text-sm">
            <li className="list-row"><Server className="text-faint size-4" /><span className="flex-1">Linux host</span><span className="text-muted">{hostVcpus}</span></li>
            <li className="list-row"><Cpu className="text-faint size-4" /><span className="flex-1">Control box</span><span className="text-muted">{CONTROL_VCPUS}</span></li>
            <li className="list-row"><AppWindow className="text-faint size-4" /><span className="flex-1">Windows ({windowsOn} on)</span><span className="text-muted">{windowsOn * WINDOWS_VCPUS}</span></li>
          </ul>
          <p className="text-faint mt-2 text-xs">AWS’s on-demand limit for this account in Mumbai. An instance still shutting down counts until it’s gone.</p>
        </Card>
      </div>

      <Card title="Linux workspaces" className="rise" style={{ '--i': 2 } as React.CSSProperties}>
        {list.length === 0 ? <Empty title="No workspaces" /> : (
          <div className="overflow-x-auto">
            <table className="compute-table">
              <thead><tr><th>Name</th><th>State</th><th>vCPU</th><th>Memory</th><th>In use</th><th>Disk</th><th>Image</th><th>Up</th></tr></thead>
              <tbody>
                {list.map((vm) => (
                  <tr key={vm.id}>
                    <td><a href={href('workspaces', vm.id)} className="font-medium hover:underline">{vm.name}</a></td>
                    <td><StateBadge state={vm.state} /></td>
                    <td>{vm.vcpus}</td>
                    <td>{gb(vm.memMib)}</td>
                    <td>{vm.memory?.actualMib ? gb(vm.memory.actualMib) : '—'}</td>
                    <td>{vm.diskGib} GB</td>
                    <td className="text-faint">{vm.image}</td>
                    <td className="text-faint">{vm.state === 'running' ? since(vm.awakeSince ?? vm.startedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {windows && windows.length > 0 && (
        <Card title="Windows workspaces" className="rise" style={{ '--i': 3 } as React.CSSProperties}>
          <ul>
            {windows.map((w) => (
              <li key={w.id} className="list-row">
                <AppWindow className="text-faint size-4" />
                <a href={href('windows', w.id)} className="flex-1 font-medium hover:underline">{w.name}</a>
                <span className="text-faint text-xs">{w.instanceType}</span>
                <StateBadge state={w.state} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {status && <p className="text-faint text-center text-xs">Control box {status.control.version} · {status.control.region} · up since {new Date(status.control.startedAt).toLocaleString()}</p>}
    </div>
  )
}
