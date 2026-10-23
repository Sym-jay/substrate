import { useEffect, useState, type FormEvent } from 'react'
import { TaskSpec, taskIsPending, type Comparison, type Task, type TaskRunner, type Vm } from '@substrate/protocol'
import { workspaceApi } from '../workspaces/api.ts'
import { workflowApi } from './api.ts'
import '../workspaces/workspaces.css'
import './workflows.css'

const runners: Record<TaskRunner, string> = { command: 'Shell command', claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }
const stateLabels = { queued: 'Preparing', running: 'Running', succeeded: 'Finished', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', needs_input: 'Needs input' }
const active = taskIsPending
const status = (task: Task) => task.dispatchUncertain ? 'Unconfirmed' : task.error ? 'Preparation failed' : stateLabels[task.run?.state ?? 'queued']
const needsReview = (task: Task) => !active(task) && !task.reviewedAt
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.'
const newSpec = (title = ''): TaskSpec => ({ title, runner: 'command', input: '', mode: 'ask', verificationCommand: '', timeoutSeconds: 3600 })
type Selection = { kind: 'task' | 'comparison'; id: string } | null
function selection(): Selection {
  const hash = new URLSearchParams(window.location.hash.slice(1))
  return hash.get('comparison') ? { kind: 'comparison', id: hash.get('comparison')! }
    : hash.get('task') ? { kind: 'task', id: hash.get('task')! } : null
}

export function WorkflowPanel({ onOpenWorkspace }: { onOpenWorkspace: (vmId: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [comparisons, setComparisons] = useState<Comparison[]>([])
  const [vms, setVms] = useState<Vm[]>([])
  const [selected, setSelected] = useState<Selection>(selection)
  const [detail, setDetail] = useState<Task | null>(null)
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [branches, setBranches] = useState<Task[]>([])
  const [form, setForm] = useState<'task' | 'comparison' | null>(null)
  const [filter, setFilter] = useState<'all' | 'review' | 'running'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    const change = () => { setSelected(selection()); setDetail(null); setComparison(null); setBranches([]) }
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const [nextTasks, nextComparisons, nextVms] = await Promise.all([
          workflowApi.tasks(controller.signal), workflowApi.comparisons(controller.signal),
          workspaceApi.list(controller.signal).catch(() => null),
        ])
        if (controller.signal.aborted) return
        setTasks(nextTasks); setComparisons(nextComparisons)
        if (nextVms) setVms(nextVms)
        if (selected?.kind === 'task') {
          const next = await workflowApi.task(selected.id, controller.signal)
          if (!controller.signal.aborted) setDetail(next)
        } else if (selected?.kind === 'comparison') {
          const next = await workflowApi.comparison(selected.id, controller.signal)
          const variants = await Promise.all(next.taskIds.map((id) => workflowApi.task(id, controller.signal)))
          if (!controller.signal.aborted) { setComparison(next); setBranches(variants) }
        }
        if (!controller.signal.aborted) setError('')
      } catch (error) { if (!controller.signal.aborted) setError(message(error)) }
      finally { pending = false; if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    const timer = setInterval(load, 3000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [selected?.kind, selected?.id, refresh])

  const open = (next: Selection) => {
    setSelected(next); setDetail(null); setComparison(null); setBranches([]); setForm(null)
    window.location.hash = new URLSearchParams({ view: 'inbox', ...(next ? { [next.kind]: next.id } : {}) }).toString()
  }
  const changed = () => setRefresh((value) => value + 1)
  const visible = tasks.filter((task) => filter === 'review' ? needsReview(task) : filter === 'running' ? active(task) : true)

  return <section className="workspaces workflow-panel" aria-labelledby="inbox-title">
    <div className="workspace-heading workflow-heading">
      <div><h2 id="inbox-title">Tasks & results</h2><p>Start work, leave it running, and return to the result.</p></div>
      <div className="workflow-actions">
        <button className="workspace-button secondary" type="button" disabled={!vms.length} aria-expanded={form === 'comparison'} onClick={() => setForm(form === 'comparison' ? null : 'comparison')}>Compare approaches</button>
        <button className="workspace-button" type="button" disabled={!vms.length} aria-expanded={form === 'task'} onClick={() => setForm(form === 'task' ? null : 'task')}>New task</button>
      </div>
    </div>
    {form && <TaskForm key={form} kind={form} vms={vms} onCancel={() => setForm(null)} onCreated={(item) => { open(item); changed() }} />}
    {error && <div className="workspace-error" role="alert"><p>Couldn’t refresh tasks. {error}</p><button className="workspace-button secondary" type="button" onClick={changed}>Try again</button></div>}
    {selected && <button type="button" className="workflow-back" onClick={() => open(null)}>Back to inbox</button>}
    {selected?.kind === 'task' ? detail ? <TaskDetail task={detail} vm={vms.find((vm) => vm.id === detail.vmId)} onOpenWorkspace={onOpenWorkspace} onChanged={changed} /> : <p className="workspace-empty" role="status">Loading task…</p>
      : selected?.kind === 'comparison' ? comparison ? <ComparisonDetail comparison={comparison} tasks={branches} vms={vms} onChanged={changed} onOpenWorkspace={onOpenWorkspace} /> : <p className="workspace-empty" role="status">Loading comparison…</p>
      : <>
        <div className="workflow-filters" role="group" aria-label="Filter tasks">
          {([['all', `All tasks (${tasks.length})`], ['review', `Needs review (${tasks.filter(needsReview).length})`], ['running', `In progress (${tasks.filter(active).length})`]] as const).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        {loading ? <p className="workspace-empty" role="status">Loading tasks…</p> : !visible.length ? <div className="workspace-empty">
          <h3>{filter === 'review' ? 'You’re all caught up' : filter === 'running' ? 'No tasks in progress' : 'Give your workspace a task'}</h3>
          <p>{filter === 'all' ? 'Run an agent prompt or shell command. Its output and verification results stay here after you close the tab.' : 'Choose another filter or start something new.'}</p>
          {!vms.length && <button type="button" className="workspace-button secondary" onClick={() => onOpenWorkspace('')}>Create a workspace first</button>}
        </div> : <ul className="workflow-list" aria-label="Tasks">
          {visible.map((task) => <li key={task.id}><button type="button" className="workflow-row" onClick={() => open({ kind: 'task', id: task.id })}>
            <span className="workflow-row-content"><strong>{task.spec.title}</strong><span>{task.error || task.run?.error || task.run?.result || task.spec.input}</span><small>{runners[task.spec.runner]} · {vms.find((vm) => vm.id === task.vmId)?.name ?? 'Workspace unavailable'}{task.comparisonId ? ' · Comparison' : ''}</small></span>
            <span className="workflow-row-status"><span className={`task-state is-${task.error ? 'failed' : task.run?.state ?? 'queued'}`}>{status(task)}</span><small>{needsReview(task) ? 'Needs review' : task.reviewedAt ? 'Reviewed' : 'Saved to inbox'}</small></span>
          </button></li>)}
        </ul>}
        {comparisons.length > 0 && <section className="workflow-comparisons" aria-labelledby="comparisons-title"><h3 id="comparisons-title">Comparisons</h3><ul className="workflow-list">
          {comparisons.map((item) => <li key={item.id}><button type="button" className="workflow-row" onClick={() => open({ kind: 'comparison', id: item.id })}>
            <span className="workflow-row-content"><strong>{item.title}</strong><span>{item.error || (item.selectedTaskId ? 'An approach has been chosen. Both workspaces are retained.' : item.state === 'preparing' ? 'Saving one starting point for both approaches…' : 'Two independent approaches from the same saved state.')}</span></span>
            <span className="task-state">{item.state === 'preparing' ? 'Preparing' : item.state === 'failed' ? 'Failed' : item.selectedTaskId ? 'Chosen' : 'Compare results'}</span>
          </button></li>)}
        </ul></section>}
      </>}
  </section>
}

function TaskForm({ kind, vms, onCancel, onCreated }: { kind: 'task' | 'comparison'; vms: Vm[]; onCancel: () => void; onCreated: (selection: NonNullable<Selection>) => void }) {
  const [vmId, setVmId] = useState(vms.find((vm) => vm.state === 'running')?.id ?? vms[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [a, setA] = useState(newSpec(kind === 'comparison' ? 'Approach A' : ''))
  const [b, setB] = useState(newSpec('Approach B'))
  const [verification, setVerification] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const comparing = kind === 'comparison'
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const first = TaskSpec.parse({ ...a, verificationCommand: verification })
      if (comparing) {
        const second = TaskSpec.parse({ ...b, verificationCommand: verification })
        const item = await workflowApi.compare({ sourceVmId: vmId, title, approaches: [first, second] })
        onCreated({ kind: 'comparison', id: item.id })
      } else {
        const item = await workflowApi.create(vmId, first)
        onCreated({ kind: 'task', id: item.id })
      }
    } catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }
  return <form className="workspace-form workflow-form" onSubmit={submit}>
    <fieldset disabled={busy}><legend>{comparing ? 'Compare two approaches' : 'Start a task'}</legend>
      <label className="workspace-field">{comparing ? 'Starting workspace' : 'Workspace'}<select required value={vmId} onChange={(event) => setVmId(event.target.value)}>
        {vms.map((vm) => <option key={vm.id} value={vm.id} disabled={comparing && !['running', 'paused'].includes(vm.state)}>{vm.name} · {vm.state}</option>)}
      </select></label>
      {comparing && <>
        <p className="workspace-hint">Creates two additional workspaces from one saved state, then runs each approach independently. Running services and files are copied. Finish any active agent work first. Preparation can take a few minutes.</p>
        <label className="workspace-field">Comparison name<input required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Compare two checkout fixes" /></label>
      </>}
      <div className={comparing ? 'workflow-approach-fields' : 'workflow-one-field'}>
        <SpecFields value={a} onChange={setA} />
        {comparing && <SpecFields value={b} onChange={setB} />}
      </div>
      <label className="workspace-field">{comparing ? 'Verification command for both approaches (optional)' : 'Verification command (optional)'}<input maxLength={8000} value={verification} onChange={(event) => setVerification(event.target.value)} placeholder="bun test" /><span className="workspace-hint">Runs after a successful task. Its exit code and output are recorded separately.</span></label>
      {error && <p className="workspace-error" role="alert">{error}</p>}
      <div className="workflow-actions"><button type="submit" className="workspace-button">{busy ? 'Preparing…' : comparing ? 'Create forks & run approaches' : 'Run task'}</button><button type="button" className="workspace-button secondary" onClick={onCancel}>Cancel</button></div>
    </fieldset>
  </form>
}

function SpecFields({ value, onChange }: { value: TaskSpec; onChange: (spec: TaskSpec) => void }) {
  const update = (next: Partial<TaskSpec>) => onChange({ ...value, ...next })
  return <div className="workflow-spec-fields">
    <label className="workspace-field">Task name<input required maxLength={160} value={value.title} onChange={(event) => update({ title: event.target.value })} placeholder="Investigate checkout failures" /></label>
    <label className="workspace-field">Run with<select value={value.runner} onChange={(event) => update({ runner: event.target.value as TaskRunner })}>{Object.entries(runners).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label className="workspace-field">{value.runner === 'command' ? 'Shell command' : 'Agent prompt'}<textarea required maxLength={32000} rows={5} value={value.input} onChange={(event) => update({ input: event.target.value })} placeholder={value.runner === 'command' ? 'Enter a command to run in your workspace' : 'Describe the task and the result you want'} /></label>
    {value.runner !== 'command' && <label className="workspace-field">Agent permissions<select value={value.mode} onChange={(event) => update({ mode: event.target.value as TaskSpec['mode'] })}><option value="ask">Restricted; interactive approval is unavailable</option><option value="auto">Full auto inside this workspace</option></select><span className="workspace-hint">Uses the agent login already configured in this workspace. If a restricted action is needed, inspect the result and continue in a terminal.</span></label>}
    <label className="workspace-field">Time limit (minutes)<input type="number" min={1} max={1440} required value={value.timeoutSeconds / 60} onChange={(event) => update({ timeoutSeconds: Number(event.target.value) * 60 })} /></label>
  </div>
}

function TaskDetail({ task, vm, onChanged, onOpenWorkspace, compact = false }: { task: Task; vm?: Vm; onChanged: () => void; onOpenWorkspace: (id: string) => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const perform = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); onChanged() } catch (error) { setError(message(error)) } finally { setBusy(false) } }
  const run = task.run
  const elapsed = run?.startedAt ? Math.max(0, Math.round((Date.parse(run.finishedAt ?? new Date().toISOString()) - Date.parse(run.startedAt)) / 1000)) : null
  return <article className={`workflow-task-detail ${compact ? 'is-compact' : ''}`} aria-label={task.spec.title}>
    <div className="workspace-heading"><div><h3>{task.spec.title}</h3><p>{runners[task.spec.runner]} · {vm?.name ?? 'Workspace unavailable'}</p></div><span className={`task-state is-${task.error ? 'failed' : run?.state ?? 'queued'}`}>{status(task)}</span></div>
    <dl className="workflow-facts"><div><dt>Elapsed</dt><dd>{elapsed === null ? 'Not started' : elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`}</dd></div><div><dt>Task exit</dt><dd>{run?.exitCode ?? '—'}</dd></div><div><dt>Verification</dt><dd>{run?.verification ? run.verification.exitCode === null ? 'Running' : run.verification.exitCode === 0 ? 'Passed' : 'Failed' : task.spec.verificationCommand ? 'Not run yet' : 'Not configured'}</dd></div></dl>
    {task.error || run?.error ? <p className="workspace-error" role="alert">{task.error || run?.error}</p> : null}
    {vm?.state === 'paused' && active(task) && <p className="workspace-hint">This workspace is paused. Its task will continue when you resume it.</p>}
    <div className="workflow-actions">
      {vm && <button type="button" className="workspace-button secondary" onClick={() => onOpenWorkspace(vm.id)}>Open workspace</button>}
      {vm?.state === 'paused' && active(task) && <button type="button" className="workspace-button secondary" disabled={busy} onClick={() => perform(() => workspaceApi.resume(vm.id))}>Resume workspace</button>}
      {active(task) ? <button type="button" className="workspace-button secondary" disabled={busy || !vm} onClick={() => perform(() => workflowApi.cancel(task.id))}>Cancel task</button>
        : <button type="button" className="workspace-button secondary" disabled={busy} onClick={() => perform(() => workflowApi.review(task.id, !task.reviewedAt))}>{task.reviewedAt ? 'Mark unreviewed' : 'Mark reviewed'}</button>}
    </div>
    {error && <p className="workspace-error" role="alert">{error}</p>}
    <section className="workflow-output" aria-label="Task result"><h4>{active(task) ? 'Output so far' : 'Result'}</h4><pre>{run?.result || run?.stdout || run?.stderr || (active(task) ? 'Waiting for output… Work continues after you close this tab.' : 'No output was recorded.')}</pre></section>
    {run?.outputTruncated && <p className="workspace-hint">Output was capped. The most recent output is retained.</p>}
    {run?.verification && <details className="workflow-disclosure"><summary>Verification output</summary><pre>{run.verification.command}</pre><pre>{run.verification.output || 'No output yet.'}</pre></details>}
    {run?.stderr && <details className="workflow-disclosure"><summary>Progress & error output</summary><pre>{run.stderr}</pre></details>}
    {run?.stdout && run.result !== run.stdout && <details className="workflow-disclosure"><summary>Raw agent output</summary><pre>{run.stdout}</pre></details>}
    {run?.changes && <details className="workflow-disclosure"><summary>Workspace changes</summary><p className="workspace-hint">Current Git changes against HEAD, including changes that existed before this task.</p><pre>{run.changes}</pre></details>}
    <details className="workflow-disclosure"><summary>{task.spec.runner === 'command' ? 'Command & settings' : 'Prompt & settings'}</summary><pre>{task.spec.input}</pre><p className="workspace-hint">Limit: {task.spec.timeoutSeconds / 60} min · Created {new Date(task.createdAt).toLocaleString()}. Elapsed time can include pauses. “Finished” describes process completion; review the output and verification.</p></details>
  </article>
}

function ComparisonDetail({ comparison, tasks, vms, onChanged, onOpenWorkspace }: { comparison: Comparison; tasks: Task[]; vms: Vm[]; onChanged: () => void; onOpenWorkspace: (id: string) => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const choose = async (taskId: string) => {
    setBusy(true); setError('')
    try { await workflowApi.select(comparison.id, taskId); onChanged() }
    catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }
  return <section className="workflow-comparison-detail" aria-labelledby="comparison-title">
    <h3 id="comparison-title">{comparison.title}</h3>
    <p className="workspace-hint">{comparison.state === 'preparing' ? 'Saving one starting point and preparing both independent forks. You can close this tab and return later.' : comparison.sourceCheckpointId ? 'Both approaches started from the same saved environment. Compare the evidence and choose where to continue.' : 'The comparison could not be prepared.'}</p>
    {comparison.error && <p className="workspace-error" role="alert">{comparison.error}</p>}
    {error && <p className="workspace-error" role="alert">{error}</p>}
    <div className="workflow-comparison-grid">{comparison.taskIds.map((id, index) => {
      const task = tasks.find((task) => task.id === id)
      const vm = vms.find((vm) => vm.id === comparison.vmIds[index])
      return <section key={id} className="workflow-variant" aria-label={`Approach ${index ? 'B' : 'A'}`}>
        <div className="workflow-variant-heading"><h4>Approach {index ? 'B' : 'A'}</h4>{comparison.selectedTaskId === id && <strong>Chosen approach</strong>}</div>
        {task && <TaskDetail task={task} vm={vm} onChanged={onChanged} onOpenWorkspace={onOpenWorkspace} compact />}
        {comparison.state === 'ready' && task && <button type="button" className="workspace-button" disabled={busy || active(task) || !vm || comparison.selectedTaskId === id} onClick={() => choose(id)}>{comparison.selectedTaskId === id ? 'Chosen' : `Choose approach ${index ? 'B' : 'A'}`}</button>}
      </section>
    })}</div>
    <p className="workspace-hint">Choosing an approach records your preference. Both workspaces remain available; nothing is merged or deleted automatically.</p>
  </section>
}
