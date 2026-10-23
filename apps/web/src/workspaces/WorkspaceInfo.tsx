import type { Vm } from '@substrate/protocol'
import { Info } from 'lucide-react'
import { agentName } from '../app/agents.ts'
import { useData } from '../app/data.tsx'
import { AsciiBar, Button, Menu, StateBadge, gb, since } from '../app/ui.tsx'

// The open workspace's details, behind an Info button in its tab bar: state,
// size, memory in use, uptime, agents, repository, and when it pauses.
export function WorkspaceInfo({ vm }: { vm: Vm }) {
  const { sessions } = useData()
  const agents = (sessions[vm.id] ?? []).filter((s) => s.agent && s.state === 'running').map((s) => agentName(s.agent))
  const inUse = vm.state === 'running' ? vm.memory?.actualMib : undefined
  return (
    <Menu align="end" button={({ toggle, open }) => (
      <Button size="sm" variant="ghost" icon={<Info />} aria-label={`About ${vm.name}`} aria-expanded={open} title="Details" onClick={toggle} />
    )}>
      {() => (
        <section className="ws-info" aria-label={`${vm.name} details`}>
          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className="truncate">{vm.name}</span>
            <StateBadge state={vm.state} />
          </div>
          <dl>
            <dt>Size</dt><dd>{vm.vcpus} vCPU · {gb(vm.memMib)} · {vm.diskGib} GB disk</dd>
            {inUse ? <><dt>Memory</dt><dd><AsciiBar parts={[{ value: inUse, char: '#' }]} total={vm.memMib} width={14} label={`${gb(inUse)} of ${gb(vm.memMib)} in use`} /> {gb(inUse)} in use</dd></> : null}
            {vm.state === 'running' && <><dt>Up</dt><dd>{since(vm.awakeSince ?? vm.startedAt)}</dd></>}
            {agents.length > 0 && <><dt>Agents</dt><dd>{agents.join(', ')}</dd></>}
            {vm.repository && <><dt>Repo</dt><dd>{vm.repository}</dd></>}
            <dt>Pauses</dt><dd>{vm.autoPauseMinutes === null ? 'never when idle' : vm.autoPauseMinutes ? `after ${vm.autoPauseMinutes} min idle` : 'when idle'}{vm.maxAwakeHours ? `, or after ${vm.maxAwakeHours} h awake` : ''}</dd>
            <dt>ID</dt><dd className="select-all">{vm.id}</dd>
            <dt>Created</dt><dd>{since(vm.createdAt)} ago</dd>
          </dl>
        </section>
      )}
    </Menu>
  )
}
