import type { Vm, WindowsWorkspace } from '@substrate/protocol'
import { ChevronDown, Copy, Ellipsis, GitBranch, Layers, LayoutTemplate, Pause, Play, Plus, Rocket, ScrollText, Search, SlidersHorizontal, Square, Trash } from 'lucide-react'
import { useState } from 'react'
import { useData } from '../app/data.tsx'
import { gibLabel, windowsSizeOf } from '../app/launch.ts'
import { useLauncher } from '../app/launcher.tsx'
import { href, navigate } from '../app/router.ts'
import { useSettings } from '../app/settings.ts'
import { Button, Empty, Menu, MenuItem, PageHeader, Shimmer, StateBadge, gb, since, useToast } from '../app/ui.tsx'
import { windowsApi, workspaceApi } from '../workspaces/api.ts'

// Linux and Windows workspaces in one list.
type Row =
  | { kind: 'linux'; id: string; name: string; state: string; createdAt: string; vm: Vm }
  | { kind: 'windows'; id: string; name: string; state: string; createdAt: string; w: WindowsWorkspace }

type StateFilter = 'all' | 'running' | 'paused' | 'stopped' | 'failed'
type TypeFilter = 'all' | 'linux' | 'windows'
const isBusy = (state: string) => ['creating', 'starting', 'resuming', 'pausing', 'stopping', 'deleting'].includes(state)
const matchesState = (state: string, filter: StateFilter) =>
  filter === 'all' || (filter === 'running' ? state === 'running' || isBusy(state) : state === filter)

// How long an awake workspace has before it pauses itself.
function pauses(row: Row) {
  if (row.kind === 'windows') {
    const m = row.w.idleStopMinutes
    return row.state === 'running' ? { main: m === null ? 'never' : `${m} min idle`, sub: 'then stops' } : null
  }
  const { vm } = row
  if (vm.state !== 'running') return null
  const idle = vm.autoPauseMinutes === undefined ? 'default' : vm.autoPauseMinutes === null ? 'never idle' : `${vm.autoPauseMinutes} min idle`
  const awake = vm.awakeSince ?? vm.startedAt
  const hoursLeft = vm.maxAwakeHours && awake ? Math.max(0, vm.maxAwakeHours - (Date.now() - Date.parse(awake)) / 3_600_000) : null
  return { main: idle, sub: hoursLeft === null ? null : `or in ${hoursLeft < 1 ? `${Math.ceil(hoursLeft * 60)} min` : `${Math.floor(hoursLeft)} h`}` }
}

// Every workspace, with search, filters and bulk actions; opening one shows its
// terminals (or its desktop, for Windows).
export function WorkspacesTable() {
  const { vms, windows, sessions, vmsUnavailable, putVm, dropVm, putWindows, refresh } = useData()
  const { launching, quickLaunch, configure } = useLauncher()
  const settings = useSettings()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)

  const rows: Row[] = [
    ...(vms ?? []).map((vm) => ({ kind: 'linux' as const, id: vm.id, name: vm.name, state: vm.state, createdAt: vm.createdAt, vm })),
    ...(windows ?? []).map((w) => ({ kind: 'windows' as const, id: w.id, name: w.name, state: w.state, createdAt: w.createdAt, w })),
  ]
  const q = query.trim().toLowerCase()
  const shown = rows.filter((r) => matchesState(r.state, stateFilter) && (typeFilter === 'all' || r.kind === typeFilter)
    && (!q || `${r.name} ${r.id} ${r.kind === 'linux' ? r.vm.repository ?? '' : ''}`.toLowerCase().includes(q)))
  const picked = shown.filter((r) => selected.has(r.id))
  const allPicked = shown.length > 0 && picked.length === shown.length

  const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const open = (r: Row) => (r.kind === 'linux' ? navigate('workspaces', r.id) : navigate('windows', r.id))

  // One action on one workspace; true if it went through.
  const act = async (r: Row, action: 'start' | 'resume' | 'pause' | 'stop' | 'delete') => {
    if (r.kind === 'linux') {
      if (action === 'delete') { await workspaceApi.remove(r.id); dropVm(r.id) }
      else putVm(await workspaceApi[action](r.id))
    } else {
      if (action === 'delete') await windowsApi.remove(r.id)
      else putWindows(await windowsApi[action === 'resume' ? 'start' : action === 'pause' ? 'stop' : action](r.id))
    }
  }
  const run = async (targets: Row[], action: 'start' | 'resume' | 'pause' | 'stop' | 'delete', label: string) => {
    if (action === 'delete' && !confirm(`Delete ${targets.length === 1 ? targets[0]!.name : `${targets.length} workspaces`}? Disks, sessions and snapshots go too.`)) return
    setBusy(label)
    const failures: string[] = []
    for (const r of targets) {
      try { await act(r, action) } catch (e) { failures.push(`${r.name}: ${e instanceof Error ? e.message : 'failed'}`) }
    }
    setBusy(null)
    setSelected(new Set())
    refresh()
    if (failures.length) toast(failures.join(' · '), 'error')
    else toast(`${label}: ${targets.length === 1 ? targets[0]!.name : `${targets.length} workspaces`}.`)
  }
  const fork = async (vm: Vm) => {
    setBusy('fork')
    toast(`Forking ${vm.name}…`)
    try { const copy = await workspaceApi.fork(vm.id, {}); putVm(copy); refresh(); toast(`${copy.name} is a copy of ${vm.name}.`) }
    catch (e) { toast(e instanceof Error ? e.message : 'Couldn’t fork it.', 'error') }
    finally { setBusy(null) }
  }

  const canPause = picked.filter((r) => r.kind === 'linux' && r.state === 'running')
  const canStop = picked.filter((r) => r.state === 'running' || (r.kind === 'linux' && r.state === 'paused'))

  return (
    <div className="page-body">
      <PageHeader title="Workspaces" subtitle="Every Linux and Windows workspace you have" actions={
        <div className="split">
          <Button variant="primary" icon={<Plus />} disabled={launching || !!vmsUnavailable} onClick={() => configure()}>New</Button>
          <Menu align="end" button={({ toggle }) => <Button variant="secondary" icon={<ChevronDown />} aria-label="More ways to create" onClick={toggle} />}>
            {(close) => (
              <>
                {/* Quick launch starts what the Environment page says. */}
                <MenuItem icon={<Rocket />} hint={`${settings.vcpus} vCPU · ${gibLabel(settings.memMib / 1024)}`} disabled={launching || !!vmsUnavailable} onClick={() => { close(); void quickLaunch() }}>Quick launch</MenuItem>
                <MenuItem icon={<SlidersHorizontal />} disabled={!!vmsUnavailable} onClick={() => { close(); configure() }}>Launch…</MenuItem>
                <MenuItem icon={<Layers />} onClick={() => { close(); navigate('environment') }}>Edit defaults…</MenuItem>
              </>
            )}
          </Menu>
        </div>
      } />

      <div className="data-tools">
        <label className="data-search">
          <Search />
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, id, repository" aria-label="Search workspaces" />
        </label>
        <select className="input !w-auto" value={stateFilter} onChange={(e) => setStateFilter(e.target.value as StateFilter)} aria-label="State">
          <option value="all">Any state</option><option value="running">Running</option><option value="paused">Paused</option><option value="stopped">Stopped</option><option value="failed">Failed</option>
        </select>
        {windows && (
          <select className="input !w-auto" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TypeFilter)} aria-label="Type">
            <option value="all">Any type</option><option value="linux">Linux</option><option value="windows">Windows</option>
          </select>
        )}
        <span className="text-faint ml-auto text-xs">{shown.length} of {rows.length}</span>
      </div>

      {picked.length > 0 && (
        <div className="data-bulk" role="toolbar" aria-label="Selected workspaces">
          <span className="mr-2">{picked.length} selected</span>
          <Button size="sm" variant="ghost" icon={<Pause />} disabled={!canPause.length || !!busy} onClick={() => void run(canPause, 'pause', 'Paused')}>Pause{canPause.length !== picked.length && canPause.length ? ` ${canPause.length}` : ''}</Button>
          <Button size="sm" variant="ghost" icon={<Square />} disabled={!canStop.length || !!busy} onClick={() => void run(canStop, 'stop', 'Stopped')}>Stop{canStop.length !== picked.length && canStop.length ? ` ${canStop.length}` : ''}</Button>
          <Button size="sm" variant="danger" icon={<Trash />} disabled={!!busy} onClick={() => void run(picked, 'delete', 'Deleted')}>Delete</Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <div className="data-wrap rise">
        <div className="data-table ws-table" role="table" aria-label="Workspaces">
          <div className="data-row data-head" role="row">
            <input type="checkbox" aria-label="Select all" checked={allPicked} onChange={() => setSelected(allPicked ? new Set() : new Set(shown.map((r) => r.id)))} />
            <span role="columnheader">Name</span><span role="columnheader" className="ws-id">ID</span><span role="columnheader">Type</span><span role="columnheader">State</span>
            <span role="columnheader">Size</span><span role="columnheader" className="ws-created">Created</span><span role="columnheader" title="When it pauses itself: after this long idle, or at the latest">Pauses</span>
            <span role="columnheader" className="text-right">Actions</span>
          </div>
          {vmsUnavailable && !windows ? <Empty art title="No workspaces here">{vmsUnavailable}</Empty>
            : !vms && !windows ? <p className="text-muted px-4 py-8 text-sm">Loading…</p>
            : shown.length === 0 ? (
              <Empty art title={rows.length ? 'Nothing matches' : 'No workspaces yet'}>
                {rows.length ? 'Try another search or filter.' : <>Launch one with your defaults, or pick its size, repository and agent.<div className="mt-4 flex justify-center gap-2"><Button variant="primary" icon={<Rocket />} disabled={launching || !!vmsUnavailable} onClick={() => void quickLaunch()}>Quick launch</Button><Button icon={<SlidersHorizontal />} disabled={!!vmsUnavailable} onClick={() => configure()}>Configure</Button></div></>}
              </Empty>
            ) : shown.map((r) => {
              const running = r.state === 'running'
              const agents = r.kind === 'linux' ? (sessions[r.id] ?? []).filter((s) => s.agent && s.state === 'running').length : 0
              const timer = pauses(r)
              return (
                <div key={r.id} className={`data-row ${running ? 'is-running' : ''}`} role="row">
                  {running && <Shimmer />}
                  <input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  <span role="cell" className="min-w-0">
                    <a href={r.kind === 'linux' ? href('workspaces', r.id) : href('windows', r.id)} className="block truncate hover:underline">{r.name}</a>
                    <span className="text-faint block truncate text-xs">
                      {r.kind === 'linux' ? [r.vm.repository, agents ? `${agents} agent${agents === 1 ? '' : 's'} working` : null].filter(Boolean).join(' · ') || ' ' : ' '}
                    </span>
                  </span>
                  <button type="button" role="cell" className="data-id ws-id flex min-w-0 items-center gap-1.5 text-left hover:text-[var(--ink)]" title="Copy the id"
                    onClick={() => void navigator.clipboard.writeText(r.id).then(() => toast('Id copied.'))}>
                    <span className="truncate">{r.id}</span><Copy className="size-3 shrink-0" />
                  </button>
                  <span role="cell" className="text-muted">{r.kind === 'linux' ? 'Linux' : 'Windows'}</span>
                  <span role="cell"><StateBadge state={r.state} /></span>
                  <span role="cell" className="text-muted">{r.kind === 'linux' ? `${r.vm.vcpus} vCPU · ${gb(r.vm.memMib)}` : `${windowsSizeOf(r.w).vcpus} vCPU · ${windowsSizeOf(r.w).memGib} GB`}</span>
                  <span role="cell" className="ws-created text-faint truncate" title={new Date(r.createdAt).toLocaleString()}>{since(r.createdAt)}</span>
                  <span role="cell" className="min-w-0">{timer ? <><span className="block truncate">{timer.main}</span>{timer.sub && <span className="text-faint block truncate text-xs">{timer.sub}</span>}</> : <span className="text-faint">—</span>}</span>
                  <span role="cell" className="flex items-center justify-end gap-1">
                    {running || isBusy(r.state) ? <Button size="sm" variant="ghost" onClick={() => open(r)}>Open</Button>
                      : r.state === 'paused' ? <Button size="sm" variant="ghost" icon={<Play />} disabled={!!busy} onClick={() => void run([r], 'resume', 'Resumed')}>Resume</Button>
                      : r.state === 'stopped' ? <Button size="sm" variant="ghost" icon={<Play />} disabled={!!busy} onClick={() => void run([r], 'start', 'Started')}>Start</Button>
                      : <Button size="sm" variant="ghost" onClick={() => open(r)}>Open</Button>}
                    <Menu align="end" button={({ toggle: t }) => <Button size="sm" variant="ghost" icon={<Ellipsis />} aria-label={`More for ${r.name}`} onClick={t} />}>
                      {(close) => (
                        <>
                          <MenuItem onClick={() => { close(); open(r) }}>Open</MenuItem>
                          {r.kind === 'linux' && running && <MenuItem icon={<Pause />} disabled={!!busy} onClick={() => { close(); void run([r], 'pause', 'Paused') }}>Pause</MenuItem>}
                          {(running || (r.kind === 'linux' && r.state === 'paused')) && <MenuItem icon={<Square />} disabled={!!busy} onClick={() => { close(); void run([r], 'stop', 'Stopped') }}>Stop</MenuItem>}
                          {r.kind === 'linux' && <MenuItem icon={<GitBranch />} hint="a copy, as it is now" disabled={!!busy || (r.state !== 'running' && r.state !== 'paused')} onClick={() => { close(); void fork(r.vm) }}>Fork</MenuItem>}
                          {r.kind === 'linux' && <MenuItem icon={<LayoutTemplate />} hint="soon" onClick={() => { close(); toast('Saving a workspace as a template is on the way.') }}>Save as template</MenuItem>}
                          {r.kind === 'linux' && <MenuItem icon={<ScrollText />} onClick={() => { close(); navigate('logs', r.id) }}>Logs</MenuItem>}
                          <MenuItem icon={<Trash />} disabled={!!busy} onClick={() => { close(); void run([r], 'delete', 'Deleted') }}>Delete</MenuItem>
                        </>
                      )}
                    </Menu>
                  </span>
                </div>
              )
            })}
        </div>
      </div>
    </div>
  )
}
