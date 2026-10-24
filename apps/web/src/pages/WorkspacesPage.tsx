import type { AgentMode, Session, Vm } from '@substrate/protocol'
import { ChevronLeft, Maximize, Minimize, Monitor, Pause, Play, Plus, ScrollText, SlidersHorizontal, Square, SquareTerminal, Wrench, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AgentIcon } from '../app/AgentIcon.tsx'
import { agentCatalog, agentName } from '../app/agents.ts'
import { useData } from '../app/data.tsx'
import { href, navigate } from '../app/router.ts'
import { useSettings } from '../app/settings.ts'
import { Button, Empty, Menu, MenuItem, Segmented, Sheet, useToast } from '../app/ui.tsx'
import { WorkspaceApiError, workspaceApi } from '../workspaces/api.ts'
import { PauseSettings } from '../workspaces/PauseSettings.tsx'
import { TerminalView, type Asleep } from '../workspaces/TerminalView.tsx'
import { VmDesktop, useVmGui } from '../workspaces/VmDesktop.tsx'
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
  // A running session whose × was pressed once: pressing it again ends it.
  const [confirming, setConfirming] = useState<string | null>(null)
  // Ended sessions closed here, which an older workspace still lists.
  const [closed, setClosed] = useState(() => readClosed(vm.id))
  const pane = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const generation = useRef(0)
  const running = vm.state === 'running'
  const shown = sessions.filter((s) => !closed.includes(s.id))
  const active = shown.find((s) => s.id === sessionId)
  // The Desktop tab is a route of its own, beside the sessions.
  const onDesktop = sessionId === 'desktop'
  const gui = useVmGui(vm)

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
    if (!sessionId && shown[0]) navigate('workspaces', vm.id, shown[0].id)
  }, [sessionId, shown, vm.id])

  // The pane can go full screen; Esc (or the button) brings it back.
  useEffect(() => {
    const sync = () => setFullscreen(!!pane.current && document.fullscreenElement === pane.current)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  const toggleFullscreen = () => void (document.fullscreenElement ? document.exitFullscreen() : pane.current?.requestFullscreen())?.catch(() => {})

  // The first press of a × only asks: it turns into "End?" for a few seconds.
  const askFirst = (id: string) => {
    if (confirming === id) return false
    setConfirming(id)
    setTimeout(() => setConfirming((c) => (c === id ? null : c)), 3_000)
    return true
  }

  // Closing a tab ends its session; a running one asks first.
  const closeTab = async (s: Session) => {
    if (s.state === 'running' && askFirst(s.id)) return
    setConfirming(null)
    try {
      await workspaceApi.closeSession(vm.id, s.id)
    } catch (error) {
      if (s.state === 'running') {
        toast(error instanceof WorkspaceApiError && error.status === 404
          ? 'This workspace can’t end sessions from here yet. Type exit in it instead.'
          : error instanceof Error ? error.message : 'Couldn’t end it.', 'error')
        return
      }
      // An ended one closes here either way.
      setClosed(writeClosed(vm.id, [...closed, s.id], sessions))
    }
    setSessions((prev) => prev.filter((x) => x.id !== s.id))
    if (s.id === sessionId) {
      const next = shown.find((x) => x.id !== s.id)
      navigate('workspaces', vm.id, ...(next ? [next.id] : []))
    }
    refresh()
  }

  // Closing the Desktop tab closes the desktop: it stops, until it's set up again.
  const closeDesktop = async () => {
    if (askFirst('desktop')) return
    setConfirming(null)
    try {
      if ((await gui.close()).available) {
        toast('Its desktop is still running: it was set up inside the workspace, so close it there.', 'error')
        return
      }
    } catch (error) {
      toast(error instanceof WorkspaceApiError && error.status === 404
        ? 'This workspace can’t close its desktop from here yet.'
        : error instanceof Error ? error.message : 'Couldn’t close it.', 'error')
      return
    }
    if (onDesktop) navigate('workspaces', vm.id, ...(shown[0] ? [shown[0].id] : []))
  }

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
  const terminalFor = onDesktop ? null : active ?? (asleep && sessionId ? { id: sessionId, agent: null } : null)

  return (
    <div ref={pane} className="ws-pane card">
      <div className="ws-tabs">
        <a href={href('workspaces')} className="btn btn-ghost btn-sm btn-icon shrink-0 md:hidden" aria-label="All workspaces"><ChevronLeft /></a>
        <div className="ws-tab-list" role="tablist" aria-label="Sessions and desktop">
        {shown.map((s, i) => (
          <span key={s.id} className={`ws-tab-wrap ${s.id === sessionId ? 'is-current' : ''}`}>
            <a role="tab" href={href('workspaces', vm.id, s.id)} aria-selected={s.id === sessionId} className={`ws-tab ${s.state === 'exited' ? 'is-ended' : ''}`}>
              {s.agent ? <AgentIcon agent={s.agent} className="size-3.5" /> : <SquareTerminal className="size-3.5" />}
              {agentName(s.agent)} {i + 1}
              {s.agent && s.mode === 'auto' && <span className="text-faint text-[10px] uppercase">auto</span>}
            </a>
            <button type="button" className={`ws-tab-close ${confirming === s.id ? 'is-confirming' : ''}`} onClick={() => void closeTab(s)}
              aria-label={confirming === s.id ? `End ${agentName(s.agent)} ${i + 1}` : `Close ${agentName(s.agent)} ${i + 1}`}
              title={s.state === 'running' ? (confirming === s.id ? 'Click again to end it' : 'End this session') : 'Close'}>
              {confirming === s.id ? 'End?' : <X />}
            </button>
          </span>
        ))}
        {(running || onDesktop) && (
          <span className={`ws-tab-wrap ${onDesktop ? 'is-current' : ''} ${gui.available ? '' : 'no-close'}`}>
            <a role="tab" href={href('workspaces', vm.id, 'desktop')} aria-selected={onDesktop} className="ws-tab" title={gui.available ? 'Its desktop, in the browser' : 'Set up a desktop for this workspace'}>
              <Monitor className="size-3.5" />Desktop{gui.state === 'setting-up' && <span className="text-faint text-[10px] uppercase">setting up</span>}
            </a>
            {/* Only a running desktop has anything to close. */}
            {gui.available && (
              <button type="button" className={`ws-tab-close ${confirming === 'desktop' ? 'is-confirming' : ''}`} onClick={() => void closeDesktop()}
                aria-label={confirming === 'desktop' ? 'Close the desktop' : 'Close Desktop'}
                title={confirming === 'desktop' ? 'Click again to close it' : 'Close the desktop'}>
                {confirming === 'desktop' ? 'End?' : <X />}
              </button>
            )}
          </span>
        )}
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
          <Button size="sm" variant="ghost" icon={fullscreen ? <Minimize /> : <Maximize />} onClick={toggleFullscreen} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} title={fullscreen ? 'Leave full screen (Esc)' : 'Full screen'} />
          <WorkspaceInfo vm={vm} />
        </div>
      </div>

      <div className="ws-terminal">
        {onDesktop ? <VmDesktop vm={vm} gui={gui} />
          : terminalFor && (running || asleep)
          ? <TerminalView key={terminalFor.id} fill path={workspaceApi.terminalPath(vm.id, terminalFor.id)} title={active ? `${agentName(active.agent)} ${shown.indexOf(active) + 1}` : 'Session'} asleep={asleep} onWake={() => void act('resume')} />
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

// Ended sessions closed in this browser, per workspace. Only ones it still
// lists are kept, so the list doesn't grow.
const closedKey = (vmId: string) => `substrate:closed-sessions:${vmId}`
function readClosed(vmId: string): string[] {
  try { return JSON.parse(localStorage.getItem(closedKey(vmId)) ?? '[]') as string[] } catch { return [] }
}
function writeClosed(vmId: string, ids: string[], listed: Session[]) {
  const kept = ids.filter((id) => listed.some((s) => s.id === id))
  try { localStorage.setItem(closedKey(vmId), JSON.stringify(kept)) } catch { /* only a convenience */ }
  return kept
}
