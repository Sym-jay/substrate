import { useEffect, useRef, useState, type FormEvent } from 'react'
import { VmName, VmSizes, type Agent, type Session, type Vm, type VmSizeName } from '@substrate/protocol'
import { workspaceApi, WorkspaceApiError } from './api.ts'
import { TerminalView } from './TerminalView.tsx'
import './workspaces.css'

const spec = ({ vcpus, memMib }: { vcpus: number; memMib: number }) => `${vcpus} vCPU · ${memMib / 1024} GB`
const sizes: { id: VmSizeName; label: string }[] = [
  { id: 'small', label: 'Small' }, { id: 'medium', label: 'Medium' }, { id: 'large', label: 'Standard' },
]
const agents: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', agy: 'Antigravity' }
type StartMode = 'terminal' | 'blank'
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.'

export function WorkspacePanel() {
  const [vms, setVms] = useState<Vm[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('vm'))
  const [refresh, setRefresh] = useState(0)
  const selectedVm = vms.find((vm) => vm.id === selected)

  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const next = await workspaceApi.list(controller.signal)
        if (controller.signal.aborted) return
        setVms(next)
        setError('')
        setUnavailable(false)
      } catch (error) {
        if (controller.signal.aborted) return
        setUnavailable(error instanceof WorkspaceApiError && error.status === 503)
        setError(errorMessage(error))
      } finally {
        pending = false
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    const timer = setInterval(load, 5_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [refresh])

  useEffect(() => {
    const onHash = () => setSelected(new URLSearchParams(window.location.hash.slice(1)).get('vm'))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const open = (vm: Vm) => {
    window.location.hash = new URLSearchParams({ vm: vm.id }).toString()
    setSelected(vm.id)
  }

  return (
    <section className="workspaces" aria-labelledby="workspaces-title">
      <div className="workspace-heading">
        <div>
          <h2 id="workspaces-title">Workspaces</h2>
          <p>Your projects and their running sessions.</p>
        </div>
        <button className="workspace-button" type="button" disabled={loading || unavailable} aria-expanded={showCreate} onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Cancel' : 'New workspace'}
        </button>
      </div>

      {showCreate && <CreateWorkspace onCreated={(vm) => {
        setVms((prev) => [...prev.filter((v) => v.id !== vm.id), vm])
        setShowCreate(false)
        open(vm)
        setRefresh((n) => n + 1)
      }} />}

      {loading ? <p className="workspace-empty" role="status">Loading workspaces…</p> : unavailable ? (
        <div className="workspace-empty">
          <h3>No sandbox host configured</h3>
          <p>Workspaces appear here once the control API can reach hostd.</p>
          <button type="button" className="workspace-button secondary" onClick={() => setRefresh((n) => n + 1)}>Check again</button>
        </div>
      ) : error ? (
        <div className="workspace-error" role="alert">
          <p>Couldn’t refresh workspaces. {error}</p>
          <button type="button" className="workspace-button secondary" onClick={() => setRefresh((n) => n + 1)}>Try again</button>
        </div>
      ) : vms.length === 0 ? (
        <div className="workspace-empty">
          <h3>A place to keep your work running</h3>
          <p>Create a workspace to open a shell or start a coding agent.</p>
        </div>
      ) : null}

      {vms.length > 0 && (
        <ul className="workspace-list" aria-label="Virtual machines">
          {vms.map((vm) => (
            <li key={vm.id}>
              <button type="button" className={`workspace-row ${selected === vm.id ? 'is-selected' : ''}`} aria-pressed={selected === vm.id} onClick={() => open(vm)}>
                <span className="workspace-row-title"><span className={`status-dot ${vm.state === 'running' ? 'is-running' : ''}`} /><strong>{vm.name}</strong></span>
                <span className="workspace-row-meta">{spec(vm)}<span className="workspace-vm-state">{vm.state}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selectedVm && <WorkspaceSessions key={selectedVm.id} vm={selectedVm} onChange={(vm) => setVms((prev) => prev.map((v) => v.id === vm.id ? vm : v))} />}
      {!loading && !error && selected && !selectedVm && <p className="workspace-hint">That workspace is no longer available. Select another workspace to continue.</p>}
    </section>
  )
}

function CreateWorkspace({ onCreated }: { onCreated: (vm: Vm) => void }) {
  const [size, setSize] = useState<VmSizeName>('large')
  const [mode, setMode] = useState<StartMode>('terminal')
  const [agent, setAgent] = useState<Agent>('claude')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim()
    if (!VmName.safeParse(name).success) { setError('Use lowercase letters, digits and dashes, starting with a letter or digit.'); return }
    setBusy(true)
    setError('')
    try {
      const vm = await workspaceApi.create({ name, size })
      // A blank workspace opens straight into its agent.
      if (mode === 'blank') await workspaceApi.createSession(vm.id, { agent })
      onCreated(vm)
    } catch (error) { setError(errorMessage(error)); setBusy(false) }
  }
  return (
    <form className="workspace-form" onSubmit={submit} aria-label="Create workspace" aria-busy={busy}>
      <fieldset disabled={busy}>
        <label className="workspace-field">Workspace name<input name="name" required maxLength={31} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="e.g. substrate" /></label>
        <fieldset className="workspace-sizes">
          <legend>Size</legend>
          {sizes.map((option) => <label key={option.id}>
            <input type="radio" name="size" value={option.id} checked={size === option.id} onChange={() => setSize(option.id)} />
            <span><strong>{option.label}</strong><small>{spec(VmSizes[option.id])}</small></span>
          </label>)}
        </fieldset>
        <label className="workspace-field">Start mode<select value={mode} onChange={(e) => setMode(e.target.value as StartMode)}>
          <option value="terminal">Terminal only</option><option value="blank">Blank workspace with an agent</option>
        </select></label>
        {mode === 'blank' && <label className="workspace-field">Agent<select value={agent} onChange={(e) => setAgent(e.target.value as Agent)}>
          {Object.entries(agents).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>}
        {error && <p role="alert" className="workspace-error">{error}</p>}
        <button className="workspace-button" type="submit">{busy ? 'Creating workspace…' : 'Create workspace'}</button>
      </fieldset>
    </form>
  )
}

function WorkspaceSessions({ vm, onChange }: { vm: Vm; onChange: (vm: Vm) => void }) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [active, setActive] = useState<string | null>(() => new URLSearchParams(window.location.hash.slice(1)).get('session'))
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [operation, setOperation] = useState<'start' | 'pause' | 'resume' | null>(null)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const selected = sessions.find((session) => session.id === active)

  useEffect(() => {
    if (vm.state !== 'running') { setLoading(false); return }
    const controller = new AbortController()
    const load = async () => {
      try {
        const list = await workspaceApi.sessions(vm.id, controller.signal)
        if (controller.signal.aborted) return
        setSessions(list)
        setError('')
        setActive((previous) => previous && list.some((s) => s.id === previous) ? previous : list[0]?.id ?? null)
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    const timer = setInterval(load, 5_000)
    return () => { controller.abort(); clearInterval(timer); generation.current++ }
  }, [vm.id, vm.state])

  useEffect(() => {
    if (!active) return
    const hash = new URLSearchParams(window.location.hash.slice(1))
    hash.set('vm', vm.id)
    hash.set('session', active)
    history.replaceState(null, '', `#${hash}`)
  }, [active, vm.id])

  const changeState = async (action: 'start' | 'pause' | 'resume') => {
    if (busy) return
    const current = generation.current
    setBusy(true)
    setOperation(action)
    setError('')
    try {
      const updated = await workspaceApi[action](vm.id)
      onChange(updated)
    }
    catch (error) { if (current === generation.current) setError(errorMessage(error)) }
    finally { setBusy(false); setOperation(null) }
  }

  const create = async () => {
    if (busy) return
    const current = generation.current
    setBusy(true)
    setError('')
    try {
      const session = await workspaceApi.createSession(vm.id)
      if (current !== generation.current) return
      setSessions((previous) => [...previous.filter((s) => s.id !== session.id), session])
      setActive(session.id)
    } catch (error) { if (current === generation.current) setError(errorMessage(error)) }
    finally { if (current === generation.current) setBusy(false) }
  }

  return (
    <section className="workspace-sessions" aria-label={`${vm.name} sessions`}>
      <div className="workspace-heading">
        <h3>{vm.name}</h3>
        <div className="flex flex-wrap justify-end gap-2">
          {vm.state === 'stopped' || vm.state === 'failed'
            ? <button className="workspace-button secondary" type="button" disabled={busy} onClick={() => changeState('start')}>{operation === 'start' ? 'Starting…' : 'Start'}</button>
            : vm.state === 'paused'
              ? <button className="workspace-button" type="button" disabled={busy} onClick={() => changeState('resume')}>{operation === 'resume' ? 'Resuming…' : 'Resume'}</button>
              : <>
                <button className="workspace-button secondary" type="button" disabled={busy || vm.state !== 'running'} onClick={() => changeState('pause')}>{operation === 'pause' || vm.state === 'pausing' ? 'Saving…' : 'Pause'}</button>
                <button className="workspace-button secondary" type="button" disabled={busy || loading || vm.state !== 'running'} onClick={create}>{busy && !operation ? 'Starting…' : 'New session'}</button>
              </>}
        </div>
      </div>
      {vm.state !== 'running' ? <p className="workspace-hint">{
        vm.state === 'paused' ? 'Paused. Your processes and terminal sessions are saved. Resume to continue.'
          : vm.state === 'pausing' ? 'Saving your workspace. This can take a moment.'
          : vm.state === 'resuming' ? 'Restoring your workspace…'
          : vm.state === 'starting' ? 'Your workspace is starting…'
          : vm.lastError ? `This workspace failed: ${vm.lastError}` : 'Start this workspace to open a terminal.'
      }</p>
        : loading ? <p className="workspace-hint" role="status">Loading sessions…</p>
        : sessions.length === 0 && !error ? <p className="workspace-hint">Start a session to open a terminal.</p> : null}
      {error && <p role="alert" className="workspace-error">{error}</p>}
      {sessions.length > 0 && <div className="session-picker" role="group" aria-label="Select terminal session">
        {sessions.map((session, i) => <button type="button" key={session.id} aria-pressed={session.id === active} onClick={() => setActive(session.id)}>{label(session, i)}{session.state === 'exited' ? ' · ended' : ''}</button>)}
      </div>}
      {selected && vm.state === 'running' && <TerminalView key={selected.id} path={workspaceApi.terminalPath(vm.id, selected.id)} title={label(selected, sessions.indexOf(selected))} />}
      {vm.state === 'paused' && vm.lastError && <p role="alert" className="workspace-error">{vm.lastError}. Your saved session is available to retry.</p>}
      {selected && vm.state === 'running' && <p className="workspace-hint">Closing this tab leaves the session running. Open this workspace again to return to it.</p>}
    </section>
  )
}

const label = (session: Session, i: number) => `${session.agent ? agents[session.agent] : 'Shell'} ${i + 1}`
