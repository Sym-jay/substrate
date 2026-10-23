import type { RunCheckpoint, Vm } from '@substrate/protocol'
import { RefreshCw, RotateCcw, Search, SquareTerminal } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AgentIcon } from '../app/AgentIcon.tsx'
import { agentName } from '../app/agents.ts'
import { useData } from '../app/data.tsx'
import { href, navigate } from '../app/router.ts'
import { Button, Empty, PageHeader, since, useToast } from '../app/ui.tsx'
import { workspaceApi } from '../workspaces/api.ts'

type Snapshot = RunCheckpoint & { vm: Vm }
const COLUMNS = 'minmax(160px, 1.2fr) minmax(220px, 2fr) minmax(150px, 1fr) 110px 150px'

// Every workspace's disk checkpoints, newest first. One is saved before each
// agent session, so a run that went wrong can be undone.
export function SnapshotsPage({ params }: { params: string[] }) {
  const { vms, putVm } = useData()
  const toast = useToast()
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null)
  const [query, setQuery] = useState('')
  const [workspace, setWorkspace] = useState(params[0] ?? 'all')
  const [busy, setBusy] = useState<string | null>(null)
  const ids = (vms ?? []).map((vm) => vm.id).join(',')

  const load = useCallback(async () => {
    if (!vms) return
    const lists = await Promise.all(vms.map(async (vm) => (await workspaceApi.checkpoints(vm.id).catch(() => [])).map((c) => ({ ...c, vm }))))
    setSnapshots(lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    // Only when the set of workspaces changes, not on every poll.
  }, [ids])
  useEffect(() => { void load() }, [load])

  const restore = async (snapshot: Snapshot) => {
    if (!confirm(`Restore ${snapshot.vm.name} to “${snapshot.label}”? Changes since then, and newer snapshots, are removed.`)) return
    setBusy(snapshot.id)
    try {
      putVm(await workspaceApi.rollback(snapshot.vm.id, snapshot.id))
      toast(`${snapshot.vm.name} is back to “${snapshot.label}”.`)
      await load()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Couldn’t restore it.', 'error')
    } finally {
      setBusy(null)
    }
  }

  const q = query.trim().toLowerCase()
  const shown = (snapshots ?? []).filter((s) => (workspace === 'all' || s.vm.id === workspace)
    && (!q || `${s.label} ${s.vm.name} ${agentName(s.agent)}`.toLowerCase().includes(q)))

  return (
    <div className="page-body">
      <PageHeader title="Snapshots" subtitle="A disk checkpoint is saved before every agent session" actions={
        <Button size="sm" icon={<RefreshCw />} onClick={() => void load()}>Refresh</Button>
      } />
      <div className="data-tools">
        <label className="data-search">
          <Search />
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search snapshots" aria-label="Search snapshots" />
        </label>
        <select className="input !w-auto" value={workspace} onChange={(e) => setWorkspace(e.target.value)} aria-label="Workspace">
          <option value="all">All workspaces</option>
          {(vms ?? []).map((vm) => <option key={vm.id} value={vm.id}>{vm.name}</option>)}
        </select>
      </div>
      <div className="data-wrap rise">
        <div className="data-table" style={{ '--cols': COLUMNS, minWidth: 840 } as React.CSSProperties} role="table" aria-label="Snapshots">
          <div className="data-row data-head" role="row">
            <span role="columnheader">Workspace</span><span role="columnheader">Snapshot</span><span role="columnheader">Before</span><span role="columnheader">Taken</span><span role="columnheader" className="text-right">Actions</span>
          </div>
          {snapshots === null ? <p className="text-muted px-4 py-8 text-sm">Loading…</p>
            : shown.length === 0 ? <Empty art title={snapshots.length ? 'Nothing matches' : 'No snapshots yet'}>{snapshots.length ? 'Try another search or workspace.' : 'One is saved before every agent session, so you can undo a run.'}</Empty>
            : shown.map((s) => {
              const stopped = s.vm.state === 'stopped' || s.vm.state === 'failed'
              return (
                <div key={s.id} className="data-row" role="row">
                  <a role="cell" href={href('workspaces', s.vm.id)} className="truncate hover:underline">{s.vm.name}</a>
                  <span role="cell" className="truncate" title={s.label}>{s.label}</span>
                  <span role="cell" className="text-muted flex min-w-0 items-center gap-2">
                    {s.agent ? <AgentIcon agent={s.agent} /> : <SquareTerminal className="size-3.5" />}
                    <span className="truncate">{agentName(s.agent)}{s.mode === 'auto' ? ' · auto' : ''}</span>
                  </span>
                  <span role="cell" className="text-faint" title={new Date(s.createdAt).toLocaleString()}>{since(s.createdAt)} ago</span>
                  <span role="cell" className="flex justify-end gap-1">
                    {s.sessionId && s.vm.state === 'running' && <Button size="sm" variant="ghost" onClick={() => navigate('workspaces', s.vm.id, s.sessionId!)}>Session</Button>}
                    <Button size="sm" variant="ghost" icon={<RotateCcw />} disabled={!stopped || !!busy} title={stopped ? 'Restore the disk to this snapshot' : 'Stop the workspace first'}
                      onClick={() => void restore(s)}>{busy === s.id ? 'Restoring…' : 'Restore'}</Button>
                  </span>
                </div>
              )
            })}
        </div>
      </div>
      <p className="text-faint text-xs">Restoring needs the workspace stopped. It rolls the disk back and removes newer snapshots.</p>
    </div>
  )
}
