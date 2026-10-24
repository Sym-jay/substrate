import type { Session, WindowsCredentials, WindowsWorkspace } from '@substrate/protocol'
import { AppWindow, ChevronLeft, Copy, KeyRound, Maximize, Minimize, Monitor, Play, Plus, RotateCw, Square, SquareTerminal, Trash } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useData } from '../app/data.tsx'
import { useLauncher } from '../app/launcher.tsx'
import { href, navigate, redirect } from '../app/router.ts'
import { Button, Empty, StateBadge, since, useToast } from '../app/ui.tsx'
import { windowsApi } from '../workspaces/api.ts'
import { useDesktop } from '../workspaces/DesktopView.tsx'
import { TerminalView } from '../workspaces/TerminalView.tsx'
import { WorkspacesTable } from './WorkspacesTable.tsx'

const idleChoices = [null, 15, 30, 60, 120, 240]
const idleLabel = (m: number | null) => (m === null ? 'never' : m < 60 ? `${m} min idle` : `${m / 60} h idle`)
const stateText: Record<WindowsWorkspace['state'], string> = {
  creating: 'setting up', starting: 'starting', running: 'running', stopping: 'stopping', stopped: 'stopped', failed: 'failed',
}

// A Windows workspace, opened (#/windows/<id>): its desktop over the whole
// window, with Workspaces under it. Windows workspaces are listed and launched
// with the rest, so there's nothing else here: #/windows goes to Workspaces.
export function WindowsPage({ params }: { params: string[] }) {
  const [id, view = 'desktop'] = params
  const { windows } = useData()
  const { configure } = useLauncher()
  const opened = windows?.find((w) => w.id === id)

  useEffect(() => {
    // An old #/windows/new link: Launch, set to Windows.
    if (id === 'new') configure({ os: 'windows' })
    // Nothing to open, once the list is in.
    if (!id || id === 'new' || (windows !== undefined && !opened)) redirect('workspaces')
  }, [id, windows, opened, configure])

  return (
    <>
      <WorkspacesTable />
      {opened && <WindowsFull key={opened.id} workspace={opened} view={view} />}
    </>
  )
}

// One workspace, over the whole window: a bar of tabs and controls, and the
// desktop (or a terminal) under it. It can go full screen, too.
function WindowsFull({ workspace, view }: { workspace: WindowsWorkspace; view: string }) {
  const { putWindows, refresh } = useData()
  const toast = useToast()
  const frame = useRef<HTMLDivElement>(null)
  const [terminals, setTerminals] = useState<Session[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [credentials, setCredentials] = useState<WindowsCredentials | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const running = workspace.state === 'running'
  const terminal = terminals.find((t) => t.id === view)
  const desktop = useDesktop(workspace.id, running && !terminal)

  useEffect(() => {
    if (!running) { setTerminals([]); return }
    const controller = new AbortController()
    const load = async () => { try { setTerminals(await windowsApi.terminals(workspace.id, controller.signal)) } catch { /* shown elsewhere */ } }
    void load()
    const timer = setInterval(load, 5_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [workspace.id, running])

  useEffect(() => {
    const sync = () => setFullscreen(!!frame.current && document.fullscreenElement === frame.current)
    document.addEventListener('fullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }, [])

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(label)
    try { await work() } catch (e) { toast(e instanceof Error ? e.message : 'That didn’t work.', 'error') } finally { setBusy(null) }
  }
  const toggleFullscreen = () => void (document.fullscreenElement ? document.exitFullscreen() : frame.current?.requestFullscreen())?.catch(() => {})

  return createPortal(
    <div ref={frame} className="win-full" role="dialog" aria-label={workspace.name}>
      <div className="win-bar">
        <a href={href('workspaces')} className="btn btn-ghost btn-sm btn-icon" aria-label="All workspaces" title="All workspaces"><ChevronLeft /></a>
        <span className="truncate text-sm">{workspace.name}</span>
        <StateBadge state={workspace.state} label={stateText[workspace.state]} />
        <span className="win-bar-rule" />
        <div className="ws-tab-list" role="tablist" aria-label="Desktop and terminals">
          <a role="tab" href={href('windows', workspace.id)} aria-selected={!terminal} className="ws-tab"><Monitor className="size-3.5" />Desktop</a>
          {terminals.map((t, i) => (
            <a key={t.id} role="tab" href={href('windows', workspace.id, t.id)} aria-selected={t.id === view} className={`ws-tab ${t.state === 'exited' ? 'is-ended' : ''}`}><SquareTerminal className="size-3.5" />PowerShell {i + 1}</a>
          ))}
        </div>
        <Button size="sm" variant="ghost" icon={<Plus />} disabled={!running || busy === 'terminal'} title="New PowerShell terminal" onClick={() => act('terminal', async () => {
          const t = await windowsApi.createTerminal(workspace.id)
          setTerminals((prev) => [...prev, t])
          navigate('windows', workspace.id, t.id)
        })}><span className="hidden xl:inline">{busy === 'terminal' ? 'Opening…' : 'PowerShell'}</span></Button>

        <div className="ml-auto flex items-center gap-1">
          {running && !terminal && desktop.state !== 'connected' && <span className={`text-xs ${desktop.state === 'error' ? 'text-[var(--bad)]' : 'text-muted'}`} role="status">{desktop.status}</span>}
          {running && !terminal && (desktop.state === 'disconnected' || desktop.state === 'error') && <Button size="sm" variant="ghost" icon={<RotateCw />} onClick={desktop.reconnect}>Reconnect</Button>}
          {running && !terminal && <Button size="sm" variant="ghost" disabled={desktop.state !== 'connected'} onClick={desktop.ctrlAltDel} title="Send Ctrl+Alt+Del">Ctrl+Alt+Del</Button>}
          {workspace.state === 'stopped'
            ? <Button variant="primary" size="sm" icon={<Play />} disabled={!!busy} onClick={() => act('start', async () => putWindows(await windowsApi.start(workspace.id)))}>{busy === 'start' ? 'Starting…' : 'Start'}</Button>
            : <Button size="sm" variant="ghost" icon={<Square />} title="Stop: its disk is kept" disabled={!!busy || !['running', 'starting', 'creating'].includes(workspace.state)} onClick={() => act('stop', async () => putWindows(await windowsApi.stop(workspace.id)))}><span className="hidden lg:inline">{busy === 'stop' || workspace.state === 'stopping' ? 'Stopping…' : 'Stop'}</span></Button>}
          <select className="input !min-h-[30px] !w-auto !py-1 text-xs" aria-label="Auto-stop" title="Stops itself after this long without use" value={workspace.idleStopMinutes ?? 'off'} disabled={!!busy}
            onChange={(e) => { const idleStopMinutes = e.target.value === 'off' ? null : Number(e.target.value); void act('settings', async () => putWindows(await windowsApi.update(workspace.id, { idleStopMinutes }))) }}>
            {idleChoices.map((m) => <option key={m ?? 'off'} value={m ?? 'off'}>Auto-stop: {idleLabel(m)}</option>)}
          </select>
          <Button size="sm" variant="ghost" icon={<KeyRound />} title="Windows sign-in" onClick={() => credentials ? setCredentials(null) : act('sign-in', async () => setCredentials(await windowsApi.credentials(workspace.id)))}><span className="hidden lg:inline">Sign-in</span></Button>
          {document.fullscreenEnabled && <Button size="sm" variant="ghost" icon={fullscreen ? <Minimize /> : <Maximize />} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} title={fullscreen ? 'Leave full screen' : 'Full screen'} onClick={toggleFullscreen} />}
          <Button size="sm" variant="danger" icon={<Trash />} aria-label="Delete" title="Delete" disabled={!!busy} onClick={() => {
            if (!confirm(`Delete ${workspace.name}? Its disk and everything on it go too.`)) return
            void act('delete', async () => { await windowsApi.remove(workspace.id); refresh(); navigate('workspaces') })
          }} />
        </div>
      </div>
      {credentials && (
        <div className="win-bar text-muted text-sm">
          Windows sign-in: <code className="chip">{credentials.username}</code> <code className="chip">{credentials.password}</code>
          <Button size="sm" variant="ghost" icon={<Copy />} onClick={() => void navigator.clipboard.writeText(credentials.password).then(() => toast('Password copied.'))}>Copy</Button>
        </div>
      )}
      <div className="win-body">
        {!running ? (
          <div className="flex h-full items-center justify-center p-6">
            <Empty icon={<AppWindow />} title={workspace.state === 'creating' ? 'Setting up Windows' : workspace.state === 'starting' ? 'Starting Windows' : workspace.state === 'stopping' ? 'Stopping' : workspace.state === 'failed' ? 'This workspace failed' : 'Stopped'}>
              {workspace.state === 'creating' ? `Its first start takes 5 to 10 minutes. Created ${since(workspace.createdAt)} ago.`
                : workspace.state === 'starting' ? 'A couple of minutes.'
                : workspace.state === 'failed' ? workspace.error ?? 'Delete it and create another.'
                : 'Its disk is kept. Start it to carry on.'}
            </Empty>
          </div>
        ) : terminal ? <div className="ws-terminal h-full"><TerminalView key={terminal.id} fill path={windowsApi.terminalPath(workspace.id, terminal.id)} title={`PowerShell ${terminals.indexOf(terminal) + 1}`} /></div>
          : <div ref={desktop.screen} className="win-screen" aria-label="Windows desktop" />}
      </div>
    </div>,
    document.body,
  )
}
