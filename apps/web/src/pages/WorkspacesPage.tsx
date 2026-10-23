import type { AgentMode, Session, Vm } from '@substrate/protocol'
import { ChevronLeft, Pause, Play, Plus, ScrollText, SlidersHorizontal, Square, SquareTerminal, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AgentIcon } from '../app/AgentIcon.tsx'
import { agentCatalog, agentName } from '../app/agents.ts'
import { useData } from '../app/data.tsx'
import { href, navigate } from '../app/router.ts'
import { useSettings } from '../app/settings.ts'
import { Button, Empty, Menu, MenuItem, Segmented, Sheet, useToast } from '../app/ui.tsx'
import { workspaceApi } from '../workspaces/api.ts'
import { PauseSettings } from '../workspaces/PauseSettings.tsx'
import { TerminalView, type Asleep } from '../workspaces/TerminalView.tsx'
import { WorkspaceInfo } from '../workspaces/WorkspaceInfo.tsx'
import { WorkspaceTools } from '../workspaces/WorkspaceTools.tsx'
import { WorkspacesTable } from './WorkspacesTable.tsx'

const isActive = (vm: Vm) => vm.state === 'running' || vm.state === 'starting' || vm.state === 'resuming'

// Every workspace as a table; with one open, its terminals fill the page (the
// sidebar lists the others: app/WorkspaceSidebar.tsx).
export function WorkspacesPage({ params }: { params: string[] }) {
  const [vmId, sessionId] = params
  const { vms } = useData()
  const selected = vms?.find((vm) => vm.id === vmId)

  if (!vmId) return <WorkspacesTable />
  return (
    <div className="ws-single">
      {selected ? <WorkspaceDetail key={selected.id} vm={selected} sessionId={sessionId} />
        : vms ? <div className="card card-pad"><Empty art title="That workspace is gone">It may have been deleted. <a href={href('workspaces')} className="underline underline-offset-4">See them all</a>.</Empty></div>
        : <p className="text-muted text-sm">Loading…</p>}
    </div>
  )
}

function WorkspaceDetail({ vm, sessionId }: { vm: Vm; sessionId?: string }) {
  const { putVm, dropVm, sessions: polled, refresh } = useData()
  const settings = useSettings()
  const toast = useToast()
  const [sessions, setSessions] = useState<Session[]>(polled[vm.id] ?? [])
  const [operation, setOperation] = useState<'start' | 'stop' | 'pause' | 'resume' | 'session' | null>(null)
  const [mode, setMode] = useState<AgentMode>(settings.mode)
  const [tools, setTools] = useState(false)
  const generation = useRef(0)
  const running = vm.state === 'running'
  const active = sessions.find((s) => s.id === sessionId)

  // This workspace's sessions, more often than the dashboard's poll.
  useEffect(() => {
    if (!running) return
    const controller = new AbortController()
    const load = async () => {
      try {
        const list = await workspaceApi.sessions(vm.id, controller.signal)
        if (!controller.signal.aborted) setSessions(list)
      } catch { /* the dashboard's poll shows errors */ }
    }
    void load()
    const timer = setInterval(load, 5_000)
    return () => { controller.abort(); clearInterval(timer); generation.current++ }
  }, [vm.id, running])

  // Open the first session if none is chosen.
  useEffect(() => {
    if (!sessionId && sessions[0]) navigate('workspaces', vm.id, sessions[0].id)
  }, [sessionId, sessions, vm.id])

  const act = async (action: 'start' | 'stop' | 'pause' | 'resume') => {
    setOperation(action)
    try { putVm(await workspaceApi[action](vm.id)) }
    catch (error) { toast(error instanceof Error ? error.message : `Couldn’t ${action} it.`, 'error') }
    finally { setOperation(null) }
  }

  const open = async (agent: Session['agent']) => {
    const current = generation.current
    setOperation('session')
    try {
      const session = await workspaceApi.createSession(vm.id, agent ? { agent, mode } : {})
      if (current !== generation.current) return
      setSessions((prev) => [...prev.filter((s) => s.id !== session.id), session])
      navigate('workspaces', vm.id, session.id)
      refresh()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Couldn’t open a session.', 'error')
    } finally {
      setOperation(null)
    }
  }

  const asleep: Asleep | undefined =
    vm.state === 'pausing' ? 'pausing'
      : vm.state === 'resuming' || (vm.state === 'paused' && operation === 'resume') ? 'waking'
      : vm.state === 'paused' ? 'paused' : undefined
  const terminalFor = active ?? (asleep && sessionId ? { id: sessionId, agent: null } : null)

  return (
    <div className="ws-pane card">
      <div className="ws-tabs">
        <a href={href('workspaces')} className="btn btn-ghost btn-sm btn-icon shrink-0 md:hidden" aria-label="All workspaces"><ChevronLeft /></a>
        <div className="ws-tab-list" role="tablist" aria-label="Sessions">
        {sessions.map((s, i) => (
          <a key={s.id} role="tab" href={href('workspaces', vm.id, s.id)} aria-selected={s.id === sessionId} className={`ws-tab ${s.state === 'exited' ? 'is-ended' : ''}`}>
            {s.agent ? <AgentIcon agent={s.agent} className="size-3.5" /> : <SquareTerminal className="size-3.5" />}
            {agentName(s.agent)} {i + 1}
            {s.agent && s.mode === 'auto' && <span className="text-faint text-[10px] uppercase">auto</span>}
          </a>
        ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Menu align="end" button={({ toggle }) => (
            <Button size="sm" variant="secondary" icon={<Plus />} disabled={!running || operation === 'session'} onClick={toggle}><span className="hidden sm:inline">{operation === 'session' ? 'Opening…' : 'New session'}</span></Button>
          )}>
            {(close) => (
              <>
                <div className="menu-label">Agent permissions</div>
                <div className="px-2 pb-2"><Segmented label="Permissions" value={mode} onChange={setMode} options={[{ value: 'ask', label: 'Ask first' }, { value: 'auto', label: 'Full auto' }]} /></div>
                <div className="menu-label">Open in {vm.name}</div>
                <MenuItem icon={<SquareTerminal />} hint="bash" onClick={() => { close(); void open(null) }}>Shell</MenuItem>
                {agentCatalog.map((a) => (
                  <MenuItem key={a.id} icon={<AgentIcon agent={a.id} />} hint={a.maker} onClick={() => { close(); void open(a.id) }}>{a.name}</MenuItem>
                ))}
              </>
            )}
          </Menu>
          {vm.state === 'running' && <Button size="sm" variant="ghost" icon={<Pause />} disabled={!!operation} onClick={() => act('pause')} title="Save everything and pause"><span className="hidden lg:inline">{operation === 'pause' ? 'Pausing…' : 'Pause'}</span></Button>}
          {vm.state === 'paused' && <Button variant="primary" size="sm" icon={<Play />} disabled={!!operation} onClick={() => act('resume')}>{operation === 'resume' ? 'Resuming…' : 'Resume'}</Button>}
          {(vm.state === 'stopped' || vm.state === 'failed') && <Button variant="primary" size="sm" icon={<Play />} disabled={!!operation} onClick={() => act('start')}>{operation === 'start' ? 'Starting…' : 'Start'}</Button>}
          {vm.state === 'running' && <Button size="sm" variant="ghost" icon={<Square />} disabled={!!operation} onClick={() => act('stop')} title="Stop: ends running processes, keeps files"><span className="hidden lg:inline">{operation === 'stop' ? 'Stopping…' : 'Stop'}</span></Button>}
          <a href={href('logs', vm.id)} className="btn btn-ghost btn-sm" title="Logs"><ScrollText /><span className="hidden lg:inline">Logs</span></a>
          <Button size="sm" variant="ghost" icon={<Wrench />} onClick={() => setTools(true)} title="Fork, checkpoints, previews, SSH, size"><span className="hidden lg:inline">Tools</span></Button>
          <WorkspaceInfo vm={vm} />
        </div>
      </div>

      <div className="ws-terminal">
        {terminalFor && (running || asleep)
          ? <TerminalView key={terminalFor.id} fill path={workspaceApi.terminalPath(vm.id, terminalFor.id)} title={active ? `${agentName(active.agent)} ${sessions.indexOf(active) + 1}` : 'Session'} asleep={asleep} onWake={() => void act('resume')} />
          : (
            <div className="flex h-full items-center justify-center">
              <Empty icon={<SquareTerminal />} title={
                running ? 'No sessions yet'
                  : vm.state === 'paused' ? 'Paused, with everything saved'
                  : vm.state === 'failed' ? 'This workspace failed'
                  : isActive(vm) ? 'Starting…' : 'Stopped'
              }>
                {running ? 'Open a shell or start an agent with +.'
                  : vm.state === 'paused' ? 'Resume it and its processes carry on where they were.'
                  : vm.state === 'failed' ? vm.lastError ?? 'Start it again, or see Logs.'
                  : isActive(vm) ? 'Its terminals open here once it’s up.'
                  : 'Start it to open a terminal. Its files are as you left them.'}
              </Empty>
            </div>
          )}
      </div>

      <Sheet open={tools} title={`${vm.name} · tools`} onClose={() => setTools(false)}>
        <div className="workspaces">
          <div className="mb-2 flex items-center gap-2"><SlidersHorizontal className="text-faint size-4" /><span className="text-sm font-medium">Pausing</span></div>
          <PauseSettings vm={vm} onChange={putVm} />
          <WorkspaceTools vm={vm} onChange={putVm}
            onFork={(fork) => { putVm(fork); setTools(false); navigate('workspaces', fork.id) }}
            onDeleted={() => { dropVm(vm.id); setTools(false); navigate('workspaces') }} />
        </div>
      </Sheet>
    </div>
  )
}
