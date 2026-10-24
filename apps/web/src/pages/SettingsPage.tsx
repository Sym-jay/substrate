import { CliSessions } from '../cli/CliAccess.tsx'
import type { ReactNode } from 'react'
import { useData } from '../app/data.tsx'
import { resetSettings, updateSettings, useSettings } from '../app/settings.ts'
import { Button, Card, FieldRow, PageHeader, Segmented } from '../app/ui.tsx'
import { Connectors } from '../account/Connectors.tsx'
import { SshAccessPanel } from '../workspaces/SshAccessPanel.tsx'

export function SettingsPage({ account, userName }: { account?: ReactNode; userName?: string | null }) {
  const settings = useSettings()
  const { status } = useData()

  return (
    <div className="page-body">
      <PageHeader title="Settings" subtitle="Browser preferences and account access" />

      <Card title="Appearance" className="rise" style={{ '--i': 0 } as React.CSSProperties}>
        <FieldRow label="Motion" hint="Page transitions and the ASCII animations.">
          <Segmented label="Motion" value={settings.motion} onChange={(motion) => updateSettings({ motion })} options={[{ value: 'system', label: 'As the system says' }, { value: 'reduced', label: 'Reduced' }]} />
        </FieldRow>
      </Card>

      <Card title="Account" className="rise" style={{ '--i': 1 } as React.CSSProperties}>
        <FieldRow label={userName ?? 'Signed in'} hint={account ? 'Manage your account, or sign out.' : 'Sign-in is off on this server (local development).'}>{account}</FieldRow>
      </Card>

      <Card title="App connectors" className="rise" style={{ '--i': 2 } as React.CSSProperties}>
        <Connectors />
      </Card>

      {/* Keys and tokens belong to a signed-in account. */}
      {account && (
        <Card title="SSH access" className="rise" style={{ '--i': 2 } as React.CSSProperties}>
          <div className="workspaces"><SshAccessPanel /></div>
        </Card>
      )}

      <CliSessions />

      <Card title="About" className="rise" style={{ '--i': 2 } as React.CSSProperties}>
        <FieldRow label="Version">
          <span className="text-muted text-sm">{status?.control.version ?? '—'}</span>
        </FieldRow>
        <FieldRow label="Reset" hint="Back to the defaults for this browser.">
          <Button size="sm" variant="danger" onClick={() => { if (confirm('Reset all settings in this browser?')) resetSettings() }}>Reset settings</Button>
        </FieldRow>
      </Card>
    </div>
  )
}
