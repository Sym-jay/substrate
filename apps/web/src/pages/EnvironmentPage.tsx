import { SquareTerminal } from 'lucide-react'
import { AgentIcon } from '../app/AgentIcon.tsx'
import { agentCatalog } from '../app/agents.ts'
import { Slider } from '../app/Slider.tsx'
import { diskGibStops, gibLabel, memGibStops, vcpuStops } from '../app/launch.ts'
import { updateSettings, useSettings } from '../app/settings.ts'
import { Card, FieldRow, PageHeader, Segmented } from '../app/ui.tsx'

const autoPause = [
  { value: 'default', label: 'Default' }, { value: 'off', label: 'Never' }, { value: '10', label: 'After 10 min idle' },
  { value: '30', label: 'After 30 min idle' }, { value: '60', label: 'After 1 h idle' }, { value: '240', label: 'After 4 h idle' },
]

// What new workspaces start with: the defaults Quick launch uses, and that
// Launch starts from.
export function EnvironmentPage() {
  const settings = useSettings()

  return (
    <div className="page-body">
      <PageHeader title="Environment" subtitle="Your defaults: what Quick launch starts, and where Launch begins" />

      <Card title="New workspaces" className="rise">
        <FieldRow label="Open with" hint="The first session in a new workspace.">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <button type="button" className="option-card" aria-pressed={settings.agent === null} onClick={() => updateSettings({ agent: null })}>
              <span className="flex items-center gap-2"><SquareTerminal className="size-4" />Shell</span>
            </button>
            {agentCatalog.map((a) => (
              <button key={a.id} type="button" className="option-card" aria-pressed={settings.agent === a.id} onClick={() => updateSettings({ agent: a.id })}>
                <span className="flex items-center gap-2"><AgentIcon agent={a.id} className="size-3.5" />{a.name}</span>
              </button>
            ))}
          </div>
        </FieldRow>
        <FieldRow label="Agent permissions" hint="Full auto lets the agent run commands without asking. A disk checkpoint is saved first either way.">
          <Segmented label="Agent permissions" value={settings.mode} onChange={(mode) => updateSettings({ mode })} options={[{ value: 'ask', label: 'Ask first' }, { value: 'auto', label: 'Full auto' }]} />
        </FieldRow>
        <FieldRow label="Size" hint="Disks are thin: one only takes the space that’s written.">
          <div className="flex flex-col gap-5">
            <Slider label="vCPU" stops={vcpuStops} value={settings.vcpus} onChange={(vcpus) => updateSettings({ vcpus })} format={(n) => `${n} vCPU`} tick={String} />
            <Slider label="Memory" stops={memGibStops} value={settings.memMib / 1024} onChange={(gib) => updateSettings({ memMib: gib * 1024 })} format={gibLabel} tick={String} />
            <Slider label="Disk" stops={diskGibStops} value={settings.diskGib} onChange={(diskGib) => updateSettings({ diskGib })} format={gibLabel} tick={(g) => (g >= 1024 ? '1T' : String(g))} />
          </div>
        </FieldRow>
        <FieldRow label="Auto-pause" hint="Pausing saves everything, processes included, and picks up where it left off.">
          <select className="input !w-auto" value={settings.autoPauseMinutes === 'default' ? 'default' : settings.autoPauseMinutes === null ? 'off' : String(settings.autoPauseMinutes)}
            onChange={(e) => updateSettings({ autoPauseMinutes: e.target.value === 'default' ? 'default' : e.target.value === 'off' ? null : Number(e.target.value) })}>
            {autoPause.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </FieldRow>
      </Card>

    </div>
  )
}
