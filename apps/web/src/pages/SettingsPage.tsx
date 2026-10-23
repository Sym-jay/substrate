import { SquareTerminal } from 'lucide-react'
import type { ReactNode } from 'react'
import { agentCatalog } from '../app/agents.ts'
import { useData } from '../app/data.tsx'
import { describeSize } from '../app/launch.ts'
import { sizeLabels, sizeOrder } from '../app/launcher.tsx'
import { resetSettings, updateSettings, useSettings } from '../app/settings.ts'
import { Button, Card, PageHeader, Segmented } from '../app/ui.tsx'

const autoPause = [
  { value: 'default', label: 'Host default' }, { value: 'off', label: 'Never' }, { value: '10', label: 'After 10 min idle' },
  { value: '30', label: 'After 30 min idle' }, { value: '60', label: 'After 1 h idle' }, { value: '240', label: 'After 4 h idle' },
]

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="min-w-0">
        <p className="font-medium">{label}</p>
        {hint && <p className="text-faint text-xs leading-relaxed">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function SettingsPage({ account, userName }: { account?: ReactNode; userName?: string | null }) {
  const settings = useSettings()
  const { status } = useData()

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <PageHeader title="Settings" subtitle="Saved in this browser" />

      <Card title="Quick launch" className="rise">
        <Row label="Open with" hint="What a new workspace starts with.">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <button type="button" className="option-card" aria-pressed={settings.agent === null} onClick={() => updateSettings({ agent: null })}>
              <span className="flex items-center gap-2 font-semibold"><SquareTerminal className="size-4" />Shell</span>
            </button>
            {agentCatalog.map((a) => (
              <button key={a.id} type="button" className="option-card" aria-pressed={settings.agent === a.id} onClick={() => updateSettings({ agent: a.id })}>
                <span className="flex items-center gap-2 font-semibold"><span className="monogram is-sm">{a.monogram}</span>{a.name}</span>
              </button>
            ))}
          </div>
        </Row>
        <Row label="Agent permissions" hint="Full auto lets the agent run commands without asking. A disk checkpoint is saved first either way.">
          <Segmented label="Agent permissions" value={settings.mode} onChange={(mode) => updateSettings({ mode })} options={[{ value: 'ask', label: 'Ask first' }, { value: 'auto', label: 'Full auto' }]} />
        </Row>
        <Row label="Size">
          <div className="grid grid-cols-3 gap-2">
            {sizeOrder.map((s) => (
              <button key={s} type="button" className="option-card" aria-pressed={settings.size === s} onClick={() => updateSettings({ size: s })}>
                <span className="font-semibold">{sizeLabels[s]}</span><span className="text-faint text-xs">{describeSize(s)}</span>
              </button>
            ))}
          </div>
        </Row>
        <Row label="Disk" hint="Thin: a disk only takes the space that’s written.">
          <input className="input !w-32" type="number" min={8} max={1024} value={settings.diskGib} onChange={(e) => updateSettings({ diskGib: Math.min(1024, Math.max(8, Number(e.target.value) || 32)) })} aria-label="Disk in GiB" />
        </Row>
        <Row label="Auto-pause" hint="Pausing saves everything, processes included, and stops the clock on its memory.">
          <select className="input !w-auto" value={settings.autoPauseMinutes === 'default' ? 'default' : settings.autoPauseMinutes === null ? 'off' : String(settings.autoPauseMinutes)}
            onChange={(e) => updateSettings({ autoPauseMinutes: e.target.value === 'default' ? 'default' : e.target.value === 'off' ? null : Number(e.target.value) })}>
            {autoPause.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Row>
      </Card>

      <Card title="Appearance" className="rise" style={{ '--i': 1 } as React.CSSProperties}>
        <Row label="Theme">
          <Segmented label="Theme" value={settings.theme} onChange={(theme) => updateSettings({ theme })} options={[{ value: 'dark', label: 'Graphite' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} />
        </Row>
        <Row label="Motion" hint="Page and sidebar animations.">
          <Segmented label="Motion" value={settings.motion} onChange={(motion) => updateSettings({ motion })} options={[{ value: 'system', label: 'As the system says' }, { value: 'reduced', label: 'Reduced' }]} />
        </Row>
      </Card>

      <Card title="Account" className="rise" style={{ '--i': 2 } as React.CSSProperties}>
        <Row label={userName ?? 'Signed in'} hint={account ? 'Manage your account, or sign out.' : 'Sign-in is off on this server (local development).'}>{account}</Row>
      </Card>

      <Card title="About" className="rise" style={{ '--i': 3 } as React.CSSProperties}>
        <Row label="Control box">
          <span className="text-muted text-sm">{status ? `${status.control.version} · ${status.control.region}` : '—'}</span>
        </Row>
        <Row label="Reset" hint="Back to the defaults for this browser.">
          <Button size="sm" variant="danger" onClick={() => { if (confirm('Reset all settings in this browser?')) resetSettings() }}>Reset settings</Button>
        </Row>
      </Card>
    </div>
  )
}
