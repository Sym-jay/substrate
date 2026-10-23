import type { Vm } from '@substrate/protocol'
import { ArrowLeft, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react'
import { useState } from 'react'
import { useData } from './data.tsx'
import { useLauncher } from './launcher.tsx'
import { href } from './router.ts'
import { updateSettings } from './settings.ts'
import { Button, Segmented, Shimmer, gb } from './ui.tsx'

type Filter = 'all' | 'running' | 'inactive'
const isActive = (vm: Vm) => vm.state === 'running' || vm.state === 'starting' || vm.state === 'resuming'
const tone = (vm: Vm) => (vm.state === 'running' ? 'is-ok' : vm.state === 'paused' ? 'is-warn' : vm.state === 'failed' ? 'is-bad' : isActive(vm) ? 'is-busy' : '')

// What the sidebar becomes with a workspace open: a way back, and the
// workspaces to switch between. Folded, just a letter for each.
export function WorkspaceSidebar({ vmId, collapsed, narrow }: { vmId?: string; collapsed: boolean; narrow: boolean }) {
  const { vms, sessions, vmsUnavailable } = useData()
  const { configure } = useLauncher()
  const [filter, setFilter] = useState<Filter>('all')
  const shown = (vms ?? []).filter((vm) => filter === 'all' || (filter === 'running') === isActive(vm))

  return (
    <>
      <div className="ws-side-head">
        <a href={href('workspaces')} className="btn btn-ghost btn-sm btn-icon ws-side-back" aria-label="All workspaces" title="All workspaces"><ArrowLeft /></a>
        <span className="sidebar-text heading min-w-0 flex-1 truncate text-[15px] font-semibold">Workspaces</span>
        {!narrow && (
          <Button variant="ghost" size="sm" className="ws-side-toggle" icon={collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            aria-expanded={!collapsed} aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            onClick={() => updateSettings({ sidebar: collapsed ? 'expanded' : 'collapsed' })} />
        )}
      </div>

      <div className="ws-side-tools">
        <Segmented label="Show" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'running', label: 'On' }, { value: 'inactive', label: 'Off' }]} />
        <Button size="sm" variant="ghost" icon={<Plus />} disabled={!!vmsUnavailable} onClick={() => configure()} aria-label="New workspace" title="New workspace" />
      </div>

      <ul className="ws-side-list" aria-label="Workspaces">
        {shown.map((vm) => {
          const working = (sessions[vm.id] ?? []).filter((s) => s.agent && s.state === 'running').length
          return (
            <li key={vm.id}>
              <a href={href('workspaces', vm.id)} className={`ws-item ${vm.state === 'running' ? 'is-running' : ''}`} aria-current={vm.id === vmId ? 'true' : undefined} title={`${vm.name} · ${vm.state}`}>
                {vm.state === 'running' && <Shimmer />}
                <span className={`dot ${tone(vm)}`} />
                <span className={`ws-mark ${tone(vm)}`} aria-hidden>{vm.name.slice(0, 1).toUpperCase()}</span>
                <span className="sidebar-text min-w-0 flex-1">
                  <span className="block truncate">{vm.name}</span>
                  <span className="text-faint block truncate text-xs">{vm.vcpus} vCPU · {gb(vm.memMib)}{vm.state !== 'running' ? ` · ${vm.state}` : working ? ` · ${working} agent${working === 1 ? '' : 's'}` : ''}</span>
                </span>
              </a>
            </li>
          )
        })}
        {vms && shown.length === 0 && <li className="sidebar-text text-faint px-2 py-3 text-xs">{vms.length ? 'None here.' : 'No workspaces yet.'}</li>}
      </ul>
    </>
  )
}
