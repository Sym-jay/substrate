import { GitHubRepo } from '@substrate/protocol'
import { SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { AgentIcon } from '../app/AgentIcon.tsx'
import { agentCatalog } from '../app/agents.ts'
import { describeSize } from '../app/launch.ts'
import { sizeLabels, sizeOrder } from '../app/launcher.tsx'
import { updateSettings, useSettings } from '../app/settings.ts'
import { Card, FieldRow, PageHeader, Segmented } from '../app/ui.tsx'

const autoPause = [
  { value: 'default', label: 'Default' }, { value: 'off', label: 'Never' }, { value: '10', label: 'After 10 min idle' },
  { value: '30', label: 'After 30 min idle' }, { value: '60', label: 'After 1 h idle' }, { value: '240', label: 'After 4 h idle' },
]

// What's in every Linux workspace (images/guest), besides the agents.
const linuxTools = ['Ubuntu', 'Git', 'GitHub CLI', 'Docker', 'Node.js', 'Bun', 'Python 3', 'build-essential', 'tmux', 'ripgrep', 'jq', 'vim']
const windowsTools = ['Windows Server 2025', 'Git', 'Node.js', 'PowerShell 7', 'WSL', 'Claude Code', 'Codex']

// What new workspaces start with: the defaults Quick launch uses (and
// Configure & launch starts from), and what every workspace has installed.
export function EnvironmentPage() {
  const settings = useSettings()
  const [repository, setRepository] = useState(settings.repository)
  const [repoError, setRepoError] = useState('')

  const saveRepository = () => {
    const value = repository.trim()
    if (!value) { setRepoError(''); updateSettings({ repository: '' }); return }
    const parsed = GitHubRepo.safeParse(value)
    if (!parsed.success) return setRepoError('Use owner/repository or a github.com URL.')
    setRepoError('')
    setRepository(parsed.data)
    updateSettings({ repository: parsed.data })
  }

  return (
    <div className="page-body">
      <PageHeader title="Environment" subtitle="What new workspaces start with" />

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
        <FieldRow label="Repository" hint="Cloned into each new workspace. Leave it empty to start blank.">
          <input className="input" value={repository} onChange={(e) => setRepository(e.target.value)} onBlur={saveRepository} onKeyDown={(e) => { if (e.key === 'Enter') saveRepository() }}
            placeholder="owner/repository" autoCapitalize="none" spellCheck={false} aria-label="Repository" aria-invalid={!!repoError} />
          {repoError && <p role="alert" className="mt-1.5 text-xs text-[var(--bad)]">{repoError}</p>}
        </FieldRow>
        <FieldRow label="Size">
          <div className="grid grid-cols-3 gap-2">
            {sizeOrder.map((s) => (
              <button key={s} type="button" className="option-card" aria-pressed={settings.size === s} onClick={() => updateSettings({ size: s })}>
                <span>{sizeLabels[s]}</span><span className="text-faint text-xs">{describeSize(s)}</span>
              </button>
            ))}
          </div>
        </FieldRow>
        <FieldRow label="Disk" hint="Thin: a disk only takes the space that’s written.">
          <input className="input !w-32" type="number" min={8} max={1024} value={settings.diskGib} onChange={(e) => updateSettings({ diskGib: Math.min(1024, Math.max(8, Number(e.target.value) || 32)) })} aria-label="Disk in GiB" />
        </FieldRow>
        <FieldRow label="Auto-pause" hint="Pausing saves everything, processes included, and picks up where it left off.">
          <select className="input !w-auto" value={settings.autoPauseMinutes === 'default' ? 'default' : settings.autoPauseMinutes === null ? 'off' : String(settings.autoPauseMinutes)}
            onChange={(e) => updateSettings({ autoPauseMinutes: e.target.value === 'default' ? 'default' : e.target.value === 'off' ? null : Number(e.target.value) })}>
            {autoPause.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </FieldRow>
      </Card>

      <Card title="In every Linux workspace" className="rise" style={{ '--i': 1 } as React.CSSProperties}>
        <FieldRow label="Agents">
          <div className="flex flex-wrap gap-2">
            {agentCatalog.map((a) => <span key={a.id} className="chip normal-case"><AgentIcon agent={a.id} />{a.name}</span>)}
          </div>
        </FieldRow>
        <FieldRow label="Tools">
          <div className="flex flex-wrap gap-2">{linuxTools.map((t) => <span key={t} className="chip normal-case">{t}</span>)}</div>
        </FieldRow>
      </Card>

      <Card title="In every Windows workspace" className="rise" style={{ '--i': 2 } as React.CSSProperties}>
        <FieldRow label="Installed">
          <div className="flex flex-wrap gap-2">{windowsTools.map((t) => <span key={t} className="chip normal-case">{t}</span>)}</div>
        </FieldRow>
      </Card>
    </div>
  )
}
