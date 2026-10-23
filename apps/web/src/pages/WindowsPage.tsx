import { VmName, type Session, type WindowsCredentials, type WindowsWorkspace } from '@substrate/protocol'
import { AppWindow, ChevronLeft, Copy, KeyRound, Maximize, Minimize, Monitor, Play, Plus, RotateCw, Square, SquareTerminal, Trash } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useData } from '../app/data.tsx'
import { href, navigate } from '../app/router.ts'
import { Button, Empty, PageHeader, Sheet, Shimmer, StateBadge, since, useToast } from '../app/ui.tsx'
import { windowsApi } from '../workspaces/api.ts'
import { useDesktop } from '../workspaces/DesktopView.tsx'
import { TerminalView } from '../workspaces/TerminalView.tsx'

const idleChoices = [null, 15, 30, 60, 120, 240]
const idleLabel = (m: number | null) => (m === null ? 'never' : m < 60 ? `${m} min idle` : `${m / 60} h idle`)
const stateText: Record<WindowsWorkspace['state'], string> = {
  creating: 'setting up', starting: 'starting', running: 'running', stopping: 'stopping', stopped: 'stopped', failed: 'failed',
}
const tone = (w: WindowsWorkspace) => (w.state === 'running' ? 'is-ok' : w.state === 'failed' ? 'is-bad' : w.state === 'stopped' ? '' : 'is-busy')

// Windows workspaces: a grid of cards. Opening one fills the window with its
// desktop, and its PowerShell terminals as tabs beside it.
export function WindowsPage({ params }: { params: string[] }) {
  const [id, view = 'desktop'] = params
  const { windows } = useData()
  const [creating, setCreating] = useState(false)
  const opened = windows?.find((w) => w.id === id)

  // #/windows/new (from the Workspaces page or ⌘K) opens New straight away.
  useEffect(() => {
    if (id !== 'new') return
    setCreating(true)
    navigate('windows')
  }, [id])

  if (windows === null) {
    return <div className="card card-pad"><Empty icon={<AppWindow />} title="Windows workspaces aren’t set up here">They aren’t available here yet.</Empty></div>
  }
  return (
    <div className="page-body">
      <PageHeader
        title="Windows"
        subtitle="Windows Server 2025 · 16 vCPU · 64 GB · $1.63/h while on, one on at a time. Stops itself when idle."
        actions={<Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>New</Button>}
      />
      {windows === undefined ? null : windows.length === 0
        ? <div className="card card-pad"><Empty icon={<AppWindow />} title="No Windows workspaces">Create one: its first start takes 5 to 10 minutes.</Empty></div>
        : <ul className="win-grid">{windows.map((w) => <WindowsCard key={w.id} workspace={w} />)}</ul>}
      {opened && <WindowsFull key={opened.id} workspace={opened} view={view} />}
      <Sheet open={creating} title="New Windows workspace" onClose={() => setCreating(false)}>
        <CreateWindows onCreated={(w) => { setCreating(false); navigate('windows', w.id) }} />
      </Sheet>
    </div>
  )
}

function WindowsCard({ workspace: w }: { workspace: WindowsWorkspace }) {
  const { putWindows } = useData()
  const toast = useToast()
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null)
  const running = w.state === 'running'
  const act = async (action: 'start' | 'stop') => {
    setBusy(action)
    try { putWindows(await windowsApi[action](w.id)) }
    catch (e) { toast(e instanceof Error ? e.message : `Couldn’t ${action} it.`, 'error') }
    finally { setBusy(null) }
  }
  return (
    <li className="win-card">
      <a href={href('windows', w.id)} className={`win-card-screen ${running ? 'is-running' : ''}`} aria-label={`Open ${w.name}`}>
        {running && <Shimmer />}
        <Monitor />
        <span className="label">{running ? 'Open desktop' : stateText[w.state]}</span>
      </a>
      <div className="win-card-foot">
        <span className={`dot ${tone(w)}`} />
        <a href={href('windows', w.id)} className="min-w-0 flex-1">
          <span className="block truncate">{w.name}</span>
          <span className="text-faint block truncate text-xs">{stateText[w.state]} · created {since(w.createdAt)} ago</span>
        </a>
        {w.state === 'stopped' && <Button size="sm" variant="primary" icon={<Play />} disabled={!!busy} onClick={() => void act('start')}>{busy === 'start' ? 'Starting…' : 'Start'}</Button>}
        {running && <Button size="sm" variant="ghost" icon={<Square />} disabled={!!busy} onClick={() => void act('stop')}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</Button>}
      </div>
    </li>
  )
}

function CreateWindows({ onCreated }: { onCreated: (w: WindowsWorkspace) => void }) {
  const { refresh } = useData()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim()
    if (!VmName.safeParse(name).success) return setError('Use lowercase letters, digits and dashes, starting with a letter or digit.')
    setBusy(true)
    setError('')
    try { const w = await windowsApi.create({ name }); refresh(); onCreated(w) }
    catch (e) { setError(e instanceof Error ? e.message : 'Couldn’t create it.') }
    finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <label className="field">Name<input className="input" name="name" required maxLength={31} autoCapitalize="none" spellCheck={false} placeholder="e.g. windows-dev" /></label>
      <p className="text-muted text-sm leading-relaxed">Windows Server 2025 with Git, Node, PowerShell 7, Claude Code, Codex and WSL. 16 vCPU and 64 GB, at $1.63 an hour while it’s on; stopped, only its disk costs (about $9 a month).</p>
      {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
      <Button type="submit" variant="primary" size="lg" icon={<Plus />} disabled={busy}>{busy ? 'Creating…' : 'Create Windows workspace'}</Button>
    </form>
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
        <a href={href('windows')} className="btn btn-ghost btn-sm btn-icon" aria-label="All Windows workspaces" title="All Windows workspaces"><ChevronLeft /></a>
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
            void act('delete', async () => { await windowsApi.remove(workspace.id); refresh(); navigate('windows') })
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
