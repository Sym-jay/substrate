import type { Vm } from '@substrate/protocol'
import { Activity, AppWindow, Bot, Cpu, MemoryStick, Moon, Play, Rocket, SlidersHorizontal, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { agentCatalog, agentName } from '../app/agents.ts'
import { useData } from '../app/data.tsx'
import { describeSize } from '../app/launch.ts'
import { sizeLabels, useLauncher } from '../app/launcher.tsx'
import { href, navigate } from '../app/router.ts'
import { useSettings } from '../app/settings.ts'
import { Button, Card, Empty, Stat, StateBadge, gb, since, useToast } from '../app/ui.tsx'
import { workspaceApi } from '../workspaces/api.ts'

const greeting = () => {
  const hour = new Date().getHours()
  return hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
}

export function HomePage({ userName }: { userName?: string | null }) {
  const { vms, sessions, jobs, capacity, windows, vmsUnavailable, putVm } = useData()
  const { launching, quickLaunch, configure } = useLauncher()
  const settings = useSettings()
  const toast = useToast()
  const [waking, setWaking] = useState<string | null>(null)

  const list = vms ?? []
  const active = list.filter((vm) => vm.state === 'running' || vm.state === 'starting' || vm.state === 'resuming')
  const inactive = list.filter((vm) => !active.includes(vm))
  const agents = list.flatMap((vm) => (sessions[vm.id] ?? []).filter((s) => s.agent && s.state === 'running').map((s) => ({ vm, session: s })))
  const runningJobs = jobs.filter((j) => j.state === 'running')
  const memUsed = capacity ? capacity.memUsedMib + capacity.memReservedMib : 0

  const wake = async (vm: Vm) => {
    setWaking(vm.id)
    try { putVm(await (vm.state === 'paused' ? workspaceApi.resume(vm.id) : workspaceApi.start(vm.id))); navigate('workspaces', vm.id) }
    catch (error) { toast(error instanceof Error ? error.message : 'Couldn’t start it.', 'error') }
    finally { setWaking(null) }
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <section className="hero card rise">
        <div className="relative z-10 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-muted text-sm">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
            <h1 className="text-chrome mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">{greeting()}{userName ? `, ${userName}` : ''}</h1>
            <p className="text-muted mt-2 text-sm">
              {vmsUnavailable ? vmsUnavailable : `${active.length} running · ${inactive.length} inactive · ${agents.length} agent${agents.length === 1 ? '' : 's'} working`}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <div className="flex flex-wrap gap-2">
              <Button variant="chrome" size="lg" icon={<Rocket />} disabled={launching || !!vmsUnavailable} onClick={() => quickLaunch()}>{launching ? 'Launching…' : 'Quick launch'}</Button>
              <Button variant="steel" size="lg" icon={<SlidersHorizontal />} disabled={!!vmsUnavailable} onClick={() => configure()}>Configure & launch</Button>
            </div>
            <p className="text-faint text-xs">Quick launch: {agentName(settings.agent)}{settings.agent ? ` (${settings.mode === 'auto' ? 'full auto' : 'asks first'})` : ''} · {sizeLabels[settings.size]}, {describeSize(settings.size)} · <a href={href('settings')} className="underline underline-offset-2">change</a></p>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rise" style={{ '--i': 1 } as React.CSSProperties}><Stat label="Running" value={active.length} icon={<SquareTerminal />} detail={`of ${list.length} workspace${list.length === 1 ? '' : 's'}`} /></div>
        <div className="rise" style={{ '--i': 2 } as React.CSSProperties}><Stat label="Inactive" value={inactive.length} icon={<Moon />} detail={`${list.filter((v) => v.state === 'paused').length} paused, ${list.filter((v) => v.state === 'stopped').length} stopped`} /></div>
        <div className="rise" style={{ '--i': 3 } as React.CSSProperties}><Stat label="Agents working" value={agents.length} icon={<Bot />} detail={runningJobs.length ? `${runningJobs.length} background job${runningJobs.length === 1 ? '' : 's'}` : 'no background jobs'} /></div>
        <div className="rise" style={{ '--i': 4 } as React.CSSProperties}>
          <Stat label="Host memory" value={capacity ? `${Math.round((memUsed / capacity.memTotalMib) * 100)}%` : '—'} icon={<MemoryStick />} detail={capacity ? `${gb(memUsed)} of ${gb(capacity.memTotalMib)} · ${capacity.vcpus} vCPU` : 'not reported'}>
            {capacity && <div className="meter mt-1"><span style={{ width: `${(memUsed / capacity.memTotalMib) * 100}%` }} /></div>}
          </Stat>
        </div>
      </div>

      <Card title="Agents" action={<span className="text-faint text-xs">In every Linux workspace</span>} className="rise" style={{ '--i': 5 } as React.CSSProperties}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {agentCatalog.map((agent) => (
            <div key={agent.id} className="agent-card">
              <div className="flex items-center gap-3">
                <span className="monogram">{agent.monogram}</span>
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-semibold">{agent.name}{settings.agent === agent.id && <span className="chip">Default</span>}</p>
                  <p className="text-faint text-xs">{agent.maker}</p>
                </div>
              </div>
              <p className="text-muted flex-1 text-sm leading-relaxed">{agent.blurb}</p>
              <div className="flex gap-2">
                <Button variant="steel" size="sm" icon={<Rocket />} disabled={launching || !!vmsUnavailable} onClick={() => quickLaunch({ agent: agent.id })}>Launch</Button>
                <Button variant="ghost" size="sm" disabled={!!vmsUnavailable} onClick={() => configure({ agent: agent.id })}>Configure</Button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Active · ${active.length}`} action={<a href={href('workspaces')} className="text-muted text-xs hover:underline">All workspaces</a>} className="rise" style={{ '--i': 6 } as React.CSSProperties}>
          {active.length === 0 ? <Empty icon={<SquareTerminal />} title="Nothing running">Quick launch starts a workspace with your default agent in seconds.</Empty> : (
            <ul>
              {active.map((vm) => {
                const vmSessions = sessions[vm.id] ?? []
                const working = vmSessions.filter((s) => s.agent && s.state === 'running')
                return (
                  <li key={vm.id} className="list-row">
                    <span className="dot is-ok" />
                    <a href={href('workspaces', vm.id)} className="min-w-0 flex-1">
                      <p className="truncate font-medium">{vm.name}</p>
                      <p className="text-faint truncate text-xs">{vm.vcpus} vCPU · {gb(vm.memMib)} · up {since(vm.awakeSince ?? vm.startedAt)}{vm.repository ? ` · ${vm.repository}` : ''}</p>
                    </a>
                    <span className="text-muted hidden text-xs sm:inline">{working.length ? working.map((s) => agentName(s.agent)).join(', ') : `${vmSessions.length} session${vmSessions.length === 1 ? '' : 's'}`}</span>
                    <Button variant="steel" size="sm" onClick={() => navigate('workspaces', vm.id)}>Open</Button>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card title={`Inactive · ${inactive.length}`} className="rise" style={{ '--i': 7 } as React.CSSProperties}>
          {inactive.length === 0 ? <Empty icon={<Moon />} title="Nothing paused or stopped">Idle workspaces pause themselves and show up here, with everything saved.</Empty> : (
            <ul>
              {inactive.map((vm) => (
                <li key={vm.id} className="list-row">
                  <StateBadge state={vm.state} />
                  <a href={href('workspaces', vm.id)} className="min-w-0 flex-1">
                    <p className="truncate font-medium">{vm.name}</p>
                    <p className="text-faint truncate text-xs">{vm.state === 'paused' ? `paused ${since(vm.pausedAt)} ago, everything saved` : vm.lastError ?? `${vm.vcpus} vCPU · ${gb(vm.memMib)}`}</p>
                  </a>
                  {(vm.state === 'paused' || vm.state === 'stopped') && (
                    <Button variant="steel" size="sm" icon={<Play />} disabled={waking === vm.id} onClick={() => wake(vm)}>{waking === vm.id ? 'Waking…' : vm.state === 'paused' ? 'Resume' : 'Start'}</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Running jobs" action={<a href={href('jobs')} className="text-muted text-xs hover:underline">Jobs</a>} className="rise" style={{ '--i': 8 } as React.CSSProperties}>
          {agents.length === 0 && runningJobs.length === 0 ? <Empty icon={<Activity />} title="No agents working">Agents you start show up here while they run.</Empty> : (
            <ul>
              {agents.map(({ vm, session }) => (
                <li key={session.id} className="list-row">
                  <span className="dot is-busy" />
                  <a href={href('workspaces', vm.id, session.id)} className="min-w-0 flex-1">
                    <p className="truncate font-medium">{agentName(session.agent)} <span className="text-muted font-normal">in {vm.name}</span></p>
                    <p className="text-faint text-xs">{session.mode === 'auto' ? 'full auto' : 'asks first'} · started {since(session.createdAt)} ago</p>
                  </a>
                </li>
              ))}
              {runningJobs.map((job) => (
                <li key={job.id} className="list-row">
                  <span className="dot is-busy" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{job.kind === 'fork' ? 'Forking a workspace' : 'Creating a workspace'}</p>
                    <p className="text-faint text-xs">{job.createdAt ? `started ${since(job.createdAt)} ago` : 'running'}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Compute" action={<a href={href('compute')} className="text-muted text-xs hover:underline">Details</a>} className="rise" style={{ '--i': 9 } as React.CSSProperties}>
          <ul>
            <li className="list-row"><Cpu className="text-faint size-4" /><span className="flex-1">Linux workspaces</span><span className="text-muted text-sm">{capacity ? `${capacity.vcpus} vCPU · ${gb(capacity.memTotalMib)}` : '—'}</span></li>
            {windows && (
              <li className="list-row">
                <AppWindow className="text-faint size-4" />
                <a href={href('windows')} className="flex-1">Windows workspaces</a>
                <span className="text-muted text-sm">{windows.filter((w) => w.state === 'running').length} on · {windows.length} total</span>
              </li>
            )}
          </ul>
        </Card>
      </div>
    </div>
  )
}
