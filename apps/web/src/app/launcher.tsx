import { VmName, type Agent, type AgentMode, type VmSizeName } from '@substrate/protocol'
import { Rocket, SquareTerminal } from 'lucide-react'
import { createContext, useCallback, useContext, useState, type FormEvent, type ReactNode } from 'react'
import { AgentIcon } from './AgentIcon.tsx'
import { agentCatalog } from './agents.ts'
import { useData } from './data.tsx'
import { describeSize, launch, randomName, type LaunchConfig } from './launch.ts'
import { navigate } from './router.ts'
import { updateSettings, useSettings, type Settings } from './settings.ts'
import { Button, Segmented, Sheet, useToast } from './ui.tsx'

type Launcher = {
  launching: boolean
  // Launches with the saved defaults, changed by `overrides`.
  quickLaunch: (overrides?: Partial<LaunchConfig>) => Promise<void>
  // Opens Configure & launch, starting from `preset`.
  configure: (preset?: Partial<LaunchConfig>) => void
}

const LauncherContext = createContext<Launcher | null>(null)
export function useLauncher() {
  const launcher = useContext(LauncherContext)
  if (!launcher) throw new Error('useLauncher outside LauncherProvider')
  return launcher
}

const fromSettings = (s: Settings): LaunchConfig => ({ size: s.size, diskGib: s.diskGib, agent: s.agent, mode: s.mode, autoPauseMinutes: s.autoPauseMinutes, repository: s.repository || undefined })
export const sizeLabels: Record<VmSizeName, string> = { small: 'Small', medium: 'Medium', large: 'Standard' }
export const sizeOrder: VmSizeName[] = ['small', 'medium', 'large']

export function LauncherProvider({ children }: { children: ReactNode }) {
  const settings = useSettings()
  const toast = useToast()
  const { putVm, refresh } = useData()
  const [launching, setLaunching] = useState(false)
  const [preset, setPreset] = useState<Partial<LaunchConfig> | null>(null)

  const run = useCallback(async (config: LaunchConfig) => {
    setLaunching(true)
    const name = config.name || randomName()
    toast(`Launching ${name}${config.repository ? ` from ${config.repository}` : ''}…`)
    try {
      const { vm, sessionId, warning } = await launch({ ...config, name })
      putVm(vm)
      refresh()
      if (warning) toast(warning, 'error')
      else toast(`${vm.name} is up${config.agent ? `, with ${agentCatalog.find((a) => a.id === config.agent)?.name}` : ''}.`)
      navigate('workspaces', vm.id, ...(sessionId ? [sessionId] : []))
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Launching failed.', 'error')
    } finally {
      setLaunching(false)
    }
  }, [putVm, refresh, toast])

  const quickLaunch = useCallback((overrides: Partial<LaunchConfig> = {}) => run({ ...fromSettings(settings), ...overrides }), [run, settings])
  const configure = useCallback((p: Partial<LaunchConfig> = {}) => setPreset(p), [])

  return (
    <LauncherContext.Provider value={{ launching, quickLaunch, configure }}>
      {children}
      <Sheet open={!!preset} title="Configure & launch" onClose={() => setPreset(null)}>
        <LaunchForm
          initial={{ ...fromSettings(settings), ...preset }}
          busy={launching}
          onLaunch={(config, remember) => {
            if (remember) updateSettings({ size: config.size, diskGib: config.diskGib, agent: config.agent, mode: config.mode, autoPauseMinutes: config.autoPauseMinutes })
            setPreset(null)
            void run(config)
          }}
        />
      </Sheet>
    </LauncherContext.Provider>
  )
}

const autoPauseChoices: { value: string; label: string }[] = [
  { value: 'default', label: 'Default' }, { value: 'off', label: 'Never' },
  { value: '10', label: 'After 10 min idle' }, { value: '30', label: 'After 30 min idle' },
  { value: '60', label: 'After 1 h idle' }, { value: '240', label: 'After 4 h idle' },
]

function LaunchForm({ initial, busy, onLaunch }: { initial: LaunchConfig; busy: boolean; onLaunch: (config: LaunchConfig, remember: boolean) => void }) {
  const [name, setName] = useState(initial.name ?? '')
  const [placeholder] = useState(randomName)
  const [source, setSource] = useState<'blank' | 'github'>(initial.repository ? 'github' : 'blank')
  const [repository, setRepository] = useState(initial.repository ?? '')
  const [size, setSize] = useState<VmSizeName>(initial.size)
  const [diskGib, setDiskGib] = useState(initial.diskGib)
  const [agent, setAgent] = useState<Agent | null>(initial.agent)
  const [mode, setMode] = useState<AgentMode>(initial.mode)
  const [autoPause, setAutoPause] = useState(initial.autoPauseMinutes === 'default' ? 'default' : initial.autoPauseMinutes === null ? 'off' : String(initial.autoPauseMinutes))
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (name && !VmName.safeParse(name).success) return setError('Names use lowercase letters, digits and dashes, starting with a letter or digit.')
    if (source === 'github' && !repository.trim()) return setError('Which repository? owner/name or a GitHub URL.')
    onLaunch({
      name: name || placeholder, size, diskGib, agent, mode,
      repository: source === 'github' ? repository.trim() : undefined,
      autoPauseMinutes: autoPause === 'default' ? 'default' : autoPause === 'off' ? null : Number(autoPause),
    }, remember)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <label className="field">Name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={31} autoCapitalize="none" spellCheck={false} />
      </label>

      <div className="field">Start from
        <Segmented label="Start from" value={source} onChange={setSource} options={[{ value: 'blank', label: 'Blank' }, { value: 'github', label: 'GitHub repository' }]} />
        {source === 'github' && <input className="input mt-1" value={repository} onChange={(e) => setRepository(e.target.value)} placeholder="owner/repository or https://github.com/…" autoCapitalize="none" spellCheck={false} />}
      </div>

      <div className="field">Size
        <div className="grid grid-cols-3 gap-2">
          {sizeOrder.map((s) => (
            <button key={s} type="button" aria-pressed={size === s} onClick={() => setSize(s)} className="option-card">
              <span className="font-semibold">{sizeLabels[s]}</span>
              <span className="text-faint text-xs">{describeSize(s)}</span>
            </button>
          ))}
        </div>
      </div>

      <label className="field">Disk (GiB)
        <input className="input" type="number" min={8} max={1024} value={diskGib} onChange={(e) => setDiskGib(Number(e.target.value))} required />
      </label>

      <div className="field">Open with
        <div className="grid grid-cols-2 gap-2">
          <button type="button" aria-pressed={agent === null} onClick={() => setAgent(null)} className="option-card">
            <span className="flex items-center gap-2 font-semibold"><SquareTerminal className="size-4" />Shell</span>
            <span className="text-faint text-xs">A plain terminal</span>
          </button>
          {agentCatalog.map((a) => (
            <button key={a.id} type="button" aria-pressed={agent === a.id} onClick={() => setAgent(a.id)} className="option-card">
              <span className="flex items-center gap-2 font-semibold"><AgentIcon agent={a.id} className="size-3.5" />{a.name}</span>
              <span className="text-faint text-xs">{a.maker}</span>
            </button>
          ))}
        </div>
      </div>

      {agent && <div className="field">Permissions
        <Segmented label="Agent permissions" value={mode} onChange={setMode} options={[{ value: 'ask', label: 'Ask first' }, { value: 'auto', label: 'Full auto' }]} />
        <span className="text-faint text-xs font-normal">A disk checkpoint is saved before the agent starts, so you can roll back.</span>
      </div>}

      <label className="field">Auto-pause
        <select className="input" value={autoPause} onChange={(e) => setAutoPause(e.target.value)}>
          {autoPauseChoices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>

      <label className="text-muted flex items-center gap-2.5 text-sm">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 accent-zinc-400" />
        Make these my Quick launch defaults
      </label>

      {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
      <Button type="submit" variant="primary" size="lg" icon={<Rocket />} disabled={busy}>{busy ? 'Launching…' : 'Launch'}</Button>
    </form>
  )
}
