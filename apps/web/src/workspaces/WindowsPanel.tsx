import { useEffect, useState, type FormEvent } from 'react'
import { VmName, type Session, type WindowsCredentials, type WindowsWorkspace, type WindowsWorkspaceState } from '@substrate/protocol'
import { windowsApi, WorkspaceApiError } from './api.ts'
import { DesktopView } from './DesktopView.tsx'
import { TerminalView } from './TerminalView.tsx'
import './workspaces.css'

const stateLabels: Record<WindowsWorkspaceState, string> = {
  creating: 'setting up', starting: 'starting', running: 'running', stopping: 'stopping', stopped: 'stopped', failed: 'failed',
}
const idleChoices = [null, 15, 30, 60, 120, 240]
const idleLabel = (m: number | null) => m === null ? 'Never' : m < 60 ? `After ${m} min idle` : `After ${m / 60} h idle`
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.'

// Windows workspaces (M9): an instance each, with its desktop and terminals
// in the browser. Hidden when the server doesn't have them set up.
export function WindowsPanel() {
  const [workspaces, setWorkspaces] = useState<WindowsWorkspace[]>([])
  const [available, setAvailable] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const selectedWorkspace = workspaces.find((w) => w.id === selected)
  const replace = (w: WindowsWorkspace) => setWorkspaces((prev) => prev.map((p) => p.id === w.id ? w : p))

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      try {
        const next = await windowsApi.list(controller.signal)
        if (controller.signal.aborted) return
        setWorkspaces(next)
        setAvailable(true)
        setError('')
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof WorkspaceApiError && [401, 404, 503].includes(error.status)) setAvailable(false)
        else setError(errorMessage(error))
      }
    }
    void load()
    const timer = setInterval(load, 5_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [refresh])

  if (!available) return null
  return (
    <section className="workspaces" aria-labelledby="windows-title">
      <div className="workspace-heading">
        <div>
          <h2 id="windows-title">Windows workspaces</h2>
          <p>Windows Server 2025, 16 vCPU and 64 GB, with its desktop in the browser. $1.63 an hour while on.</p>
        </div>
        <button className="workspace-button" type="button" aria-expanded={showCreate} onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Cancel' : 'New Windows workspace'}
        </button>
      </div>

      {showCreate && <CreateWindowsWorkspace onCreated={(w) => {
        setWorkspaces((prev) => [...prev.filter((p) => p.id !== w.id), w])
        setShowCreate(false)
        setSelected(w.id)
        setRefresh((n) => n + 1)
      }} />}

      {error && <div className="workspace-error" role="alert">
        <p>Couldn’t refresh Windows workspaces. {error}</p>
        <button type="button" className="workspace-button secondary" onClick={() => setRefresh((n) => n + 1)}>Try again</button>
      </div>}

      {workspaces.length > 0 && (
        <ul className="workspace-list" aria-label="Windows workspaces">
          {workspaces.map((w) => (
            <li key={w.id}>
              <button type="button" className={`workspace-row ${selected === w.id ? 'is-selected' : ''}`} aria-pressed={selected === w.id} onClick={() => setSelected(w.id)}>
                <span className="workspace-row-title"><span className={`status-dot ${w.state === 'running' ? 'is-running' : ''}`} /><strong>{w.name}</strong></span>
                <span className="workspace-row-meta">Windows<span className="workspace-vm-state">{stateLabels[w.state]}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selectedWorkspace && <WindowsWorkspaceView key={selectedWorkspace.id} workspace={selectedWorkspace} onChange={replace} onDeleted={() => {
        setWorkspaces((prev) => prev.filter((w) => w.id !== selectedWorkspace.id))
        setSelected(null)
      }} />}
    </section>
  )
}

function CreateWindowsWorkspace({ onCreated }: { onCreated: (w: WindowsWorkspace) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim()
    if (!VmName.safeParse(name).success) { setError('Use lowercase letters, digits and dashes, starting with a letter or digit.'); return }
    setBusy(true)
    setError('')
    try { onCreated(await windowsApi.create({ name })) }
    catch (error) { setError(errorMessage(error)); setBusy(false) }
  }
  return (
    <form className="workspace-form" onSubmit={submit} aria-label="Create Windows workspace" aria-busy={busy}>
      <fieldset disabled={busy}>
        <label className="workspace-field">Workspace name<input name="name" required maxLength={31} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="e.g. windows-dev" /></label>
        <p className="workspace-hint">Comes with Git, Node, PowerShell 7, Claude Code, Codex and WSL. The first start takes 5 to 10 minutes.</p>
        {error && <p role="alert" className="workspace-error">{error}</p>}
        <button className="workspace-button" type="submit">{busy ? 'Creating…' : 'Create Windows workspace'}</button>
      </fieldset>
    </form>
  )
}

type View = { kind: 'desktop' } | { kind: 'terminal'; id: string }

function WindowsWorkspaceView({ workspace, onChange, onDeleted }: { workspace: WindowsWorkspace; onChange: (w: WindowsWorkspace) => void; onDeleted: () => void }) {
  const [terminals, setTerminals] = useState<Session[]>([])
  const [view, setView] = useState<View>({ kind: 'desktop' })
  const [busy, setBusy] = useState<'start' | 'stop' | 'delete' | 'terminal' | 'settings' | null>(null)
  const [credentials, setCredentials] = useState<WindowsCredentials | null>(null)
  const [error, setError] = useState('')
  const running = workspace.state === 'running'
  const terminal = view.kind === 'terminal' ? terminals.find((t) => t.id === view.id) : undefined

  useEffect(() => {
    if (!running) { setTerminals([]); return }
    const controller = new AbortController()
    const load = async () => {
      try {
        const list = await windowsApi.terminals(workspace.id, controller.signal)
        if (!controller.signal.aborted) setTerminals(list)
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error))
      }
    }
    void load()
    const timer = setInterval(load, 5_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [workspace.id, running])

  const act = async (action: 'start' | 'stop' | 'delete' | 'terminal' | 'settings', work: () => Promise<void>) => {
    setBusy(action)
    setError('')
    try { await work() }
    catch (error) { setError(errorMessage(error)) }
    finally { setBusy(null) }
  }
  const remove = () => {
    if (!confirm(`Delete ${workspace.name}? Its disk and everything on it are deleted.`)) return
    void act('delete', async () => { await windowsApi.remove(workspace.id); onDeleted() })
  }
  const newTerminal = () => act('terminal', async () => {
    const created = await windowsApi.createTerminal(workspace.id)
    setTerminals((previous) => [...previous.filter((t) => t.id !== created.id), created])
    setView({ kind: 'terminal', id: created.id })
  })
  const showCredentials = () => {
    if (credentials) return setCredentials(null)
    void act('settings', async () => setCredentials(await windowsApi.credentials(workspace.id)))
  }

  return (
    <section className="workspace-sessions" aria-label={`${workspace.name}`}>
      <div className="workspace-heading">
        <h3>{workspace.name}</h3>
        <div className="flex flex-wrap justify-end gap-2">
          {workspace.state === 'stopped'
            ? <button className="workspace-button" type="button" disabled={!!busy} onClick={() => void act('start', async () => onChange(await windowsApi.start(workspace.id)))}>{busy === 'start' ? 'Starting…' : 'Start'}</button>
            : <button className="workspace-button secondary" type="button" disabled={!!busy || !['running', 'starting', 'creating'].includes(workspace.state)} onClick={() => void act('stop', async () => onChange(await windowsApi.stop(workspace.id)))}>{busy === 'stop' || workspace.state === 'stopping' ? 'Stopping…' : 'Stop'}</button>}
          <button className="workspace-button secondary" type="button" disabled={!!busy} onClick={remove}>{busy === 'delete' ? 'Deleting…' : 'Delete'}</button>
        </div>
      </div>

      <div className="workspace-autopause">
        <label>Auto-stop
          <select value={workspace.idleStopMinutes ?? 'off'} disabled={!!busy} onChange={(e) => {
            const idleStopMinutes = e.target.value === 'off' ? null : Number(e.target.value)
            void act('settings', async () => onChange(await windowsApi.update(workspace.id, { idleStopMinutes })))
          }}>
            {idleChoices.map((m) => <option key={m ?? 'off'} value={m ?? 'off'}>{idleLabel(m)}</option>)}
          </select>
        </label>
        <button type="button" className="workspace-button secondary" disabled={busy === 'settings'} onClick={showCredentials}>{credentials ? 'Hide sign-in' : 'Windows sign-in'}</button>
      </div>
      {credentials && <p className="workspace-hint">
        User <code>{credentials.username}</code>, password <code>{credentials.password}</code>{' '}
        <button type="button" className="workspace-button secondary" onClick={() => void navigator.clipboard.writeText(credentials.password)}>Copy</button>
      </p>}

      {!running && <p className="workspace-hint">{
        workspace.state === 'creating' ? 'Setting up Windows. The first start takes 5 to 10 minutes.'
          : workspace.state === 'starting' ? 'Starting Windows. This takes a couple of minutes.'
          : workspace.state === 'stopping' ? 'Stopping. Everything on its disk is kept.'
          : workspace.state === 'stopped' ? 'Stopped. Its disk is kept; start it to carry on.'
          : `This workspace failed${workspace.error ? `: ${workspace.error}` : '.'}`
      }</p>}
      {error && <p role="alert" className="workspace-error">{error}</p>}

      {running && <>
        <div className="session-picker" role="group" aria-label="Desktop or terminal">
          <button type="button" aria-pressed={view.kind === 'desktop'} onClick={() => setView({ kind: 'desktop' })}>Desktop</button>
          {terminals.map((t, i) => <button type="button" key={t.id} aria-pressed={view.kind === 'terminal' && view.id === t.id} onClick={() => setView({ kind: 'terminal', id: t.id })}>PowerShell {i + 1}{t.state === 'exited' ? ' · ended' : ''}</button>)}
          <button type="button" disabled={!!busy} onClick={() => void newTerminal()}>{busy === 'terminal' ? 'Opening…' : '+ PowerShell'}</button>
        </div>
        {view.kind === 'desktop'
          ? <DesktopView workspaceId={workspace.id} />
          : terminal && <TerminalView key={terminal.id} path={windowsApi.terminalPath(workspace.id, terminal.id)} title={`PowerShell ${terminals.indexOf(terminal) + 1}`} />}
        <p className="workspace-hint">Stops by itself when no one has used it for a while and its CPU is quiet; its disk is kept.</p>
      </>}
    </section>
  )
}
