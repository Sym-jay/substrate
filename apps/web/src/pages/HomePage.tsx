import type { Vm } from '@substrate/protocol'
import { Play, Plus, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { agentCatalog, agentName } from '../app/agents.ts'
import { AsciiHero } from '../app/AsciiHero.tsx'
import { useData } from '../app/data.tsx'
import { useLauncher } from '../app/launcher.tsx'
import { href, navigate } from '../app/router.ts'
import { useSettings } from '../app/settings.ts'
import { AsciiBar, Button, StateBadge, gb, since, useToast } from '../app/ui.tsx'
import { workspaceApi } from '../workspaces/api.ts'

export function HomePage(_: { userName?: string | null }) {
  const { vms, sessions, jobs, capacity, vmsUnavailable, putVm } = useData()
  const { launching, quickLaunch, configure } = useLauncher()
  const settings = useSettings()
  const toast = useToast()
  const [waking, setWaking] = useState<string | null>(null)

  const list = vms ?? []
  const isActive = (vm: Vm) => vm.state === 'running' || vm.state === 'starting' || vm.state === 'resuming'
  const active = list.filter(isActive)
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
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
      <AsciiHero>
        <div className="hero-actions">
          <Button variant="primary" icon={<Plus />} disabled={launching || !!vmsUnavailable} onClick={() => quickLaunch()}>{launching ? 'Launching…' : 'Quick launch'}</Button>
          <Button icon={<SlidersHorizontal />} disabled={!!vmsUnavailable} onClick={() => configure()}>Configure & launch</Button>
        </div>
      </AsciiHero>

      <section className="stat-row rise" style={{ '--i': 1 } as React.CSSProperties}>
        <div><div className="label">Running</div><div className="stat-value">{active.length}</div></div>
        <div><div className="label">Resting</div><div className="stat-value">{list.length - active.length}</div></div>
        <div><div className="label">Agents</div><div className="stat-value">{agents.length}</div></div>
        <div>
          <div className="label">Host memory</div>
          <div className="stat-value">{capacity ? `${Math.round((memUsed / capacity.memTotalMib) * 100)}%` : '—'}</div>
          {capacity && <AsciiBar parts={[{ value: memUsed, char: '#' }]} total={capacity.memTotalMib} width={18} label={`${gb(memUsed)} of ${gb(capacity.memTotalMib)}`} />}
        </div>
      </section>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] rise" style={{ '--i': 2 } as React.CSSProperties}>
        <section>
          <div className="mb-2 flex items-baseline justify-between"><h2 className="label">Workspaces</h2><a href={href('workspaces')} className="label hover:text-[var(--ink)]">All →</a></div>
          {list.length === 0 ? <p className="text-muted border-t border-[var(--line)] py-6 text-sm">None yet. Quick launch starts one with your default agent.</p> : (
            <ul className="border-t border-[var(--line)]">
              {list.map((vm) => {
                const working = (sessions[vm.id] ?? []).filter((s) => s.agent && s.state === 'running')
                return (
                  <li key={vm.id} className="list-row !border-t-0 border-b border-[var(--line)]">
                    <span className={`dot ${vm.state === 'running' ? 'is-ok' : vm.state === 'paused' ? 'is-warn' : vm.state === 'failed' ? 'is-bad' : isActive(vm) ? 'is-busy' : ''}`} />
                    <a href={href('workspaces', vm.id)} className="min-w-0 flex-1">
                      <span className="block truncate">{vm.name}</span>
                      <span className="text-faint mono block truncate text-xs">{vm.state}{vm.state === 'running' ? ` · ${since(vm.awakeSince ?? vm.startedAt)}` : ''}{working.length ? ` · ${working.map((s) => agentName(s.agent)).join(', ')}` : ''}</span>
                    </a>
                    {isActive(vm) ? <Button size="sm" variant="ghost" onClick={() => navigate('workspaces', vm.id)}>Open</Button>
                      : (vm.state === 'paused' || vm.state === 'stopped') && <Button size="sm" variant="ghost" icon={<Play />} disabled={waking === vm.id} onClick={() => wake(vm)}>{waking === vm.id ? 'Waking' : vm.state === 'paused' ? 'Resume' : 'Start'}</Button>}
                  </li>
                )
              })}
            </ul>
          )}

          {(agents.length > 0 || runningJobs.length > 0) && <>
            <div className="mt-8 mb-2"><h2 className="label">Running now</h2></div>
            <ul className="border-t border-[var(--line)]">
              {agents.map(({ vm, session }) => (
                <li key={session.id} className="list-row !border-t-0 border-b border-[var(--line)]">
                  <span className="dot is-busy" />
                  <a href={href('workspaces', vm.id, session.id)} className="min-w-0 flex-1 truncate">{agentName(session.agent)} <span className="text-faint">in {vm.name}</span></a>
                  <span className="text-faint mono text-xs">{since(session.createdAt)}</span>
                </li>
              ))}
              {runningJobs.map((job) => (
                <li key={job.id} className="list-row !border-t-0 border-b border-[var(--line)]">
                  <span className="dot is-busy" />
                  <span className="min-w-0 flex-1">{job.kind === 'fork' ? 'Forking a workspace' : 'Creating a workspace'}</span>
                  <span className="text-faint mono text-xs">{job.createdAt ? since(job.createdAt) : ''}</span>
                </li>
              ))}
            </ul>
          </>}
        </section>

        <section>
          <div className="mb-2"><h2 className="label">Agents</h2></div>
          <ul className="border-t border-[var(--line)]">
            {agentCatalog.map((agent) => (
              <li key={agent.id} className="list-row !border-t-0 border-b border-[var(--line)]">
                <span className="monogram">{agent.monogram}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate">{agent.name}{settings.agent === agent.id && <span className="text-faint mono ml-2 text-xs">default</span>}</p>
                  <p className="text-faint mono text-xs">{agent.maker}</p>
                </div>
                <Button size="sm" variant="ghost" disabled={launching || !!vmsUnavailable} onClick={() => quickLaunch({ agent: agent.id })}>Launch</Button>
              </li>
            ))}
          </ul>
          <p className="text-faint mt-3 text-xs leading-relaxed">In every Linux workspace. Configure & launch picks the size, a GitHub repo, and permissions.</p>
        </section>
      </div>
    </div>
  )
}
