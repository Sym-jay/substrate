import { VmName, type Session, type WindowsCredentials, type WindowsWorkspace } from '@substrate/protocol'
import { AppWindow, ChevronLeft, Copy, KeyRound, Monitor, Play, Plus, Square, SquareTerminal, Trash } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useData } from '../app/data.tsx'
import { href, navigate } from '../app/router.ts'
import { Button, Empty, Sheet, StateBadge, since, useToast } from '../app/ui.tsx'
import { windowsApi } from '../workspaces/api.ts'
import { DesktopView } from '../workspaces/DesktopView.tsx'
import { TerminalView } from '../workspaces/TerminalView.tsx'

const idleChoices = [null, 15, 30, 60, 120, 240]
const idleLabel = (m: number | null) => (m === null ? 'Never' : m < 60 ? `After ${m} min idle` : `After ${m / 60} h idle`)
const stateText: Record<WindowsWorkspace['state'], string> = {
  creating: 'setting up', starting: 'starting', running: 'running', stopping: 'stopping', stopped: 'stopped', failed: 'failed',
}

// Windows workspaces: the list on the left; on the right, the desktop and
// PowerShell terminals, as tabs.
export function WindowsPage({ params }: { params: string[] }) {
  const [id, view = 'desktop'] = params
  const { windows } = useData()
  const [creating, setCreating] = useState(false)
  const selected = windows?.find((w) => w.id === id)

  useEffect(() => {
    if (id || !windows?.length || window.matchMedia('(max-width: 767px)').matches) return
    navigate('windows', windows[0]!.id)
  }, [id, windows])

  if (windows === null) {
    return <div className="card card-pad"><Empty icon={<AppWindow />} title="Windows workspaces aren’t set up here">The control box turns them on once the stack has their subnet and an image.</Empty></div>
  }
  return (
    <div className="ws-layout">
      <aside className={`ws-list card ${id ? 'is-secondary' : ''}`} aria-label="Windows workspaces">
        <div className="flex items-center justify-between gap-2 px-1">
          <h1 className="heading text-lg font-semibold">Windows</h1>
          <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setCreating(true)}>New</Button>
        </div>
        <p className="text-faint px-1 text-xs leading-relaxed">Windows Server 2025 · 16 vCPU · 64 GB · $1.63/h while on, one on at a time. Stops itself when idle.</p>
        {windows.length === 0 ? <Empty icon={<AppWindow />} title="No Windows workspaces">Create one: its first start takes 5 to 10 minutes.</Empty> : (
          <ul className="flex flex-col gap-1 overflow-y-auto">
            {windows.map((w) => (
              <li key={w.id}>
                <a href={href('windows', w.id)} className="ws-item" aria-current={w.id === id ? 'true' : undefined}>
                  <span className={`dot ${w.state === 'running' ? 'is-ok' : w.state === 'failed' ? 'is-bad' : w.state === 'stopped' ? '' : 'is-busy'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{w.name}</span>
                    <span className="text-faint block truncate text-xs">{stateText[w.state]}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <section className={`ws-detail ${id ? '' : 'is-secondary'}`}>
        {selected ? <WindowsDetail key={selected.id} workspace={selected} view={view} />
          : <div className="card card-pad h-full"><Empty icon={<Monitor />} title="Pick a Windows workspace">Its desktop and PowerShell terminals open here.</Empty></div>}
      </section>
      <Sheet open={creating} title="New Windows workspace" onClose={() => setCreating(false)}>
        <CreateWindows onCreated={(w) => { setCreating(false); navigate('windows', w.id) }} />
      </Sheet>
    </div>
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

function WindowsDetail({ workspace, view }: { workspace: WindowsWorkspace; view: string }) {
  const { putWindows, refresh } = useData()
  const toast = useToast()
  const [terminals, setTerminals] = useState<Session[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [credentials, setCredentials] = useState<WindowsCredentials | null>(null)
  const running = workspace.state === 'running'
  const terminal = terminals.find((t) => t.id === view)

  useEffect(() => {
    if (!running) { setTerminals([]); return }
    const controller = new AbortController()
    const load = async () => { try { setTerminals(await windowsApi.terminals(workspace.id, controller.signal)) } catch { /* shown elsewhere */ } }
    void load()
    const timer = setInterval(load, 5_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [workspace.id, running])

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(label)
    try { await work() } catch (e) { toast(e instanceof Error ? e.message : 'That didn’t work.', 'error') } finally { setBusy(null) }
  }

  return (
    <div className="ws-pane card">
      <header className="ws-head">
        <a href={href('windows')} className="btn btn-ghost btn-sm btn-icon md:hidden" aria-label="All Windows workspaces"><ChevronLeft /></a>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{workspace.name}</h2>
            <StateBadge state={workspace.state} label={stateText[workspace.state]} />
          </div>
          <p className="text-faint truncate text-xs">{workspace.instanceType} · created {since(workspace.createdAt)} ago{workspace.error ? ` · ${workspace.error}` : ''}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {workspace.state === 'stopped'
            ? <Button variant="primary" size="sm" icon={<Play />} disabled={!!busy} onClick={() => act('start', async () => putWindows(await windowsApi.start(workspace.id)))}>{busy === 'start' ? 'Starting…' : 'Start'}</Button>
            : <Button size="sm" icon={<Square />} disabled={!!busy || !['running', 'starting', 'creating'].includes(workspace.state)} onClick={() => act('stop', async () => putWindows(await windowsApi.stop(workspace.id)))}>{busy === 'stop' || workspace.state === 'stopping' ? 'Stopping…' : 'Stop'}</Button>}
          <select className="input !min-h-8 !w-auto !py-1 text-xs" aria-label="Auto-stop" value={workspace.idleStopMinutes ?? 'off'} disabled={!!busy}
            onChange={(e) => { const idleStopMinutes = e.target.value === 'off' ? null : Number(e.target.value); void act('settings', async () => putWindows(await windowsApi.update(workspace.id, { idleStopMinutes }))) }}>
            {idleChoices.map((m) => <option key={m ?? 'off'} value={m ?? 'off'}>Auto-stop: {idleLabel(m)}</option>)}
          </select>
          <Button size="sm" variant="ghost" icon={<KeyRound />} onClick={() => credentials ? setCredentials(null) : act('sign-in', async () => setCredentials(await windowsApi.credentials(workspace.id)))}>Sign-in</Button>
          <Button size="sm" variant="danger" icon={<Trash />} aria-label="Delete" disabled={!!busy} onClick={() => {
            if (!confirm(`Delete ${workspace.name}? Its disk and everything on it go too.`)) return
            void act('delete', async () => { await windowsApi.remove(workspace.id); refresh(); navigate('windows') })
          }} />
        </div>
      </header>
      {credentials && (
        <div className="text-muted flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-4 py-2 text-sm">
          Windows sign-in: <code className="chip">{credentials.username}</code> <code className="chip">{credentials.password}</code>
          <Button size="sm" variant="ghost" icon={<Copy />} onClick={() => void navigator.clipboard.writeText(credentials.password).then(() => toast('Password copied.'))}>Copy</Button>
        </div>
      )}
      <div className="ws-tabs">
        <div className="ws-tab-list" role="tablist" aria-label="Desktop and terminals">
          <a role="tab" href={href('windows', workspace.id)} aria-selected={view === 'desktop'} className="ws-tab"><Monitor className="size-3.5" />Desktop</a>
          {terminals.map((t, i) => (
            <a key={t.id} role="tab" href={href('windows', workspace.id, t.id)} aria-selected={t.id === view} className={`ws-tab ${t.state === 'exited' ? 'is-ended' : ''}`}><SquareTerminal className="size-3.5" />PowerShell {i + 1}</a>
          ))}
        </div>
        <div className="ml-auto shrink-0">
          <Button size="sm" variant="secondary" icon={<Plus />} disabled={!running || busy === 'terminal'} onClick={() => act('terminal', async () => {
            const t = await windowsApi.createTerminal(workspace.id)
            setTerminals((prev) => [...prev, t])
            navigate('windows', workspace.id, t.id)
          })}>{busy === 'terminal' ? 'Opening…' : 'PowerShell'}</Button>
        </div>
      </div>
      <div className="ws-terminal overflow-y-auto">
        {!running ? (
          <div className="flex h-full items-center justify-center">
            <Empty icon={<AppWindow />} title={workspace.state === 'creating' ? 'Setting up Windows' : workspace.state === 'starting' ? 'Starting Windows' : workspace.state === 'stopping' ? 'Stopping' : workspace.state === 'failed' ? 'This workspace failed' : 'Stopped'}>
              {workspace.state === 'creating' ? 'Its first start takes 5 to 10 minutes.'
                : workspace.state === 'starting' ? 'A couple of minutes.'
                : workspace.state === 'failed' ? workspace.error ?? 'Delete it and create another.'
                : 'Its disk is kept. Start it to carry on.'}
            </Empty>
          </div>
        ) : terminal ? <TerminalView key={terminal.id} fill path={windowsApi.terminalPath(workspace.id, terminal.id)} title={`PowerShell ${terminals.indexOf(terminal) + 1}`} />
          : <DesktopView workspaceId={workspace.id} />}
      </div>
    </div>
  )
}
