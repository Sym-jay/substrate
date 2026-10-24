import { VmName, sizeCeiling, type Agent, type AgentMode, type Quota } from '@substrate/protocol'
import { AppWindow, ArrowLeft, ArrowRight, SquareTerminal } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { accountApi, windowsApi } from '../workspaces/api.ts'
import { AgentIcon } from './AgentIcon.tsx'
import { Slider } from './Slider.tsx'
import { agentCatalog } from './agents.ts'
import { useData } from './data.tsx'
import { diskGibStops, gibLabel, launch, memGibStops, randomName, vcpuStops, windowsSize, type LaunchConfig } from './launch.ts'
import { navigate } from './router.ts'
import { updateSettings, useSettings, type Settings } from './settings.ts'
import { Button, Modal, Segmented, useToast } from './ui.tsx'

type Os = 'linux' | 'windows'
// Where Launch starts: a Linux workspace from the saved defaults, changed by
// these, or a Windows one.
export type LaunchPreset = Partial<LaunchConfig> & { os?: Os }

type Launcher = {
  launching: boolean
  // Launches with the saved defaults, changed by `overrides`.
  quickLaunch: (overrides?: Partial<LaunchConfig>) => Promise<void>
  // Opens Launch, starting from `preset`.
  configure: (preset?: LaunchPreset) => void
}

const LauncherContext = createContext<Launcher | null>(null)
export function useLauncher() {
  const launcher = useContext(LauncherContext)
  if (!launcher) throw new Error('useLauncher outside LauncherProvider')
  return launcher
}

const fromSettings = (s: Settings): LaunchConfig => ({ vcpus: s.vcpus, memMib: s.memMib, diskGib: s.diskGib, agent: s.agent, mode: s.mode, autoPauseMinutes: s.autoPauseMinutes, repository: s.repository || undefined })

export function LauncherProvider({ children }: { children: ReactNode }) {
  const settings = useSettings()
  const toast = useToast()
  const { putVm, putWindows, refresh, windows } = useData()
  const [launching, setLaunching] = useState(false)
  const [preset, setPreset] = useState<LaunchPreset | null>(null)

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

  const runWindows = useCallback(async (name: string) => {
    setLaunching(true)
    toast(`Creating ${name}. Its first start takes 5 to 10 minutes.`)
    try {
      const created = await windowsApi.create({ name })
      putWindows(created)
      refresh()
      navigate('windows', created.id)
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Couldn’t create it.', 'error')
    } finally {
      setLaunching(false)
    }
  }, [putWindows, refresh, toast])

  const quickLaunch = useCallback((overrides: Partial<LaunchConfig> = {}) => run({ ...fromSettings(settings), ...overrides }), [run, settings])
  const configure = useCallback((p: LaunchPreset = {}) => setPreset(p), [])
  const close = useCallback(() => setPreset(null), [])

  return (
    <LauncherContext.Provider value={{ launching, quickLaunch, configure }}>
      {children}
      <Modal open={!!preset} title="Launch a workspace" onClose={close} className="launch-modal">
        {preset && (
          <LaunchForm
            initial={{ ...fromSettings(settings), ...preset }}
            os={preset.os ?? 'linux'}
            windowsOffered={windows !== null}
            busy={launching}
            onLaunch={(config, remember) => {
              if (remember) updateSettings({ vcpus: config.vcpus, memMib: config.memMib, diskGib: config.diskGib, agent: config.agent, mode: config.mode, autoPauseMinutes: config.autoPauseMinutes })
              close()
              void run(config)
            }}
            onLaunchWindows={(name) => { close(); void runWindows(name) }}
          />
        )}
      </Modal>
    </LauncherContext.Provider>
  )
}

// The stops at or under a limit; at least the first, so a slider always has one.
const upTo = (stops: number[], most: number) => {
  const allowed = stops.filter((n) => n <= most)
  return allowed.length ? allowed : stops.slice(0, 1)
}
// The stop nearest a value.
const nearestStop = (stops: number[], value: number) => stops.reduce((best, s) => (Math.abs(s - value) < Math.abs(best - value) ? s : best))

const autoPauseChoices: { value: string; label: string }[] = [
  { value: 'default', label: 'Default' }, { value: 'off', label: 'Never' },
  { value: '10', label: 'After 10 min idle' }, { value: '30', label: 'After 30 min idle' },
  { value: '60', label: 'After 1 h idle' }, { value: '240', label: 'After 4 h idle' },
]

type Step = 'basics' | 'size' | 'agent' | 'review'
const stepLabels: Record<Step, string> = { basics: 'Basics', size: 'Size', agent: 'Agent', review: 'Review' }

// Launch, a step at a time: what and where from, how big, what opens in it,
// then a last look. Windows has no agent step.
function LaunchForm({ initial, os: initialOs, windowsOffered, busy, onLaunch, onLaunchWindows }: {
  initial: LaunchConfig
  os: Os
  windowsOffered: boolean
  busy: boolean
  onLaunch: (config: LaunchConfig, remember: boolean) => void
  onLaunchWindows: (name: string) => void
}) {
  const [os, setOs] = useState<Os>(windowsOffered ? initialOs : 'linux')
  const [step, setStep] = useState<Step>('basics')
  // The furthest step reached; the step bar can jump back to any up to it.
  const [reached, setReached] = useState(0)
  const [name, setName] = useState(initial.name ?? '')
  const [placeholder] = useState(randomName)
  const [source, setSource] = useState<'blank' | 'github'>(initial.repository ? 'github' : 'blank')
  const [repository, setRepository] = useState(initial.repository ?? '')
  const [vcpus, setVcpus] = useState(initial.vcpus)
  const [memGib, setMemGib] = useState(initial.memMib / 1024)
  const [diskGib, setDiskGib] = useState(initial.diskGib)
  const [agent, setAgent] = useState<Agent | null>(initial.agent)
  const [mode, setMode] = useState<AgentMode>(initial.mode)
  const [autoPause, setAutoPause] = useState(initial.autoPauseMinutes === 'default' ? 'default' : initial.autoPauseMinutes === null ? 'off' : String(initial.autoPauseMinutes))
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  // The plan's limits, once they're in. Sizes over them aren't offered.
  const [limits, setLimits] = useState<Quota | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    accountApi.quota(controller.signal).then((q) => setLimits(q.limits), () => {})
    return () => controller.abort()
  }, [])
  const most = limits ? sizeCeiling(limits) : null
  const vcpuChoices = most ? upTo(vcpuStops, most.vcpus) : vcpuStops
  const memChoices = most ? upTo(memGibStops, most.memMib / 1024) : memGibStops
  const diskChoices = limits ? upTo(diskGibStops, limits.maxDiskGib) : diskGibStops
  // What's chosen, within the plan: a saved default over it lands on its top stop.
  const cpu = nearestStop(vcpuChoices, vcpus)
  const mem = nearestStop(memChoices, memGib)
  const disk = nearestStop(diskChoices, diskGib)
  const capped = !!most && (vcpuChoices.length < vcpuStops.length || memChoices.length < memGibStops.length || diskChoices.length < diskGibStops.length)
  const windows = os === 'windows'
  const steps: Step[] = windows ? ['basics', 'size', 'review'] : ['basics', 'size', 'agent', 'review']
  const at = steps.indexOf(step)
  const agentName = agent ? agentCatalog.find((a) => a.id === agent)?.name ?? agent : 'Shell'

  // What's wrong with the basics, if anything.
  const basicsError = () => {
    if (name && !VmName.safeParse(name).success) return 'Names use lowercase letters, digits and dashes, starting with a letter or digit.'
    if (!windows && source === 'github' && !repository.trim()) return 'Which repository? owner/name or a GitHub URL.'
    return ''
  }
  const go = (to: number) => {
    const problem = to > at && step === 'basics' ? basicsError() : ''
    setError(problem)
    if (problem) return
    setStep(steps[to]!)
    setReached((r) => Math.max(r, to))
  }
  const chooseOs = (next: Os) => {
    setOs(next)
    setError('')
    // The steps differ between the two; start them over from here.
    setReached(0)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (at < steps.length - 1) return go(at + 1)
    if (windows) return onLaunchWindows(name || placeholder)
    onLaunch({
      name: name || placeholder, vcpus: cpu, memMib: mem * 1024, diskGib: disk, agent, mode,
      repository: source === 'github' ? repository.trim() : undefined,
      autoPauseMinutes: autoPause === 'default' ? 'default' : autoPause === 'off' ? null : Number(autoPause),
    }, remember)
  }

  const summary = windows
    ? `Windows · ${windowsSize.vcpus} vCPU · ${windowsSize.memGib} GB`
    : `${cpu} vCPU · ${gibLabel(mem)} · ${gibLabel(disk)} disk`

  return (
    <form onSubmit={submit} className="modal-form">
      <ol className="launch-steps" aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s}>
            <button type="button" className="launch-step" aria-current={s === step ? 'step' : undefined} disabled={i > reached} onClick={() => go(i)}>
              <span className="launch-step-n">{String(i + 1).padStart(2, '0')}</span>{stepLabels[s]}
            </button>
          </li>
        ))}
      </ol>

      <div className="modal-body launch-body" key={step}>
        {step === 'basics' && <>
          {windowsOffered && (
            <div className="field">System
              <div className="grid grid-cols-2 gap-2">
                <button type="button" aria-pressed={!windows} onClick={() => chooseOs('linux')} className="option-card">
                  <span className="flex items-center gap-2 font-semibold"><SquareTerminal className="size-4" />Linux</span>
                  <span className="text-faint text-xs">Agents, terminals, Docker</span>
                </button>
                <button type="button" aria-pressed={windows} onClick={() => chooseOs('windows')} className="option-card">
                  <span className="flex items-center gap-2 font-semibold"><AppWindow className="size-4" />Windows</span>
                  <span className="text-faint text-xs">A desktop in the browser</span>
                </button>
              </div>
            </div>
          )}
          <label className="field">Name
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={31} autoCapitalize="none" spellCheck={false} autoFocus />
          </label>
          {!windows && (
            <div className="field">Start from
              <Segmented label="Start from" value={source} onChange={setSource} options={[{ value: 'blank', label: 'Blank' }, { value: 'github', label: 'GitHub repository' }]} />
              {source === 'github' && <input className="input mt-1" value={repository} onChange={(e) => setRepository(e.target.value)} placeholder="owner/repository or https://github.com/…" autoCapitalize="none" spellCheck={false} />}
            </div>
          )}
        </>}

        {step === 'size' && <>
          <Slider label="vCPU" stops={windows ? vcpuStops : vcpuChoices} value={windows ? windowsSize.vcpus : cpu} onChange={setVcpus} format={(n) => `${n} vCPU`} tick={String} disabled={windows} />
          <Slider label="Memory" stops={windows ? memGibStops : memChoices} value={windows ? windowsSize.memGib : mem} onChange={setMemGib} format={gibLabel} tick={String} disabled={windows} />
          {windows ? (
            <p className="text-muted text-sm leading-relaxed">
              Every Windows workspace is this size: Windows Server 2025 with Git, Node.js, PowerShell 7, WSL, Claude Code and Codex. Its first start takes 5 to 10 minutes; one can be on at a time, and it stops itself when idle.
            </p>
          ) : (
            <>
              <Slider label="Disk" stops={diskChoices} value={disk} onChange={setDiskGib} format={gibLabel} tick={(g) => (g >= 1024 ? '1T' : String(g))} />
              {capped && most && limits && <p className="text-faint text-xs">Your plan allows up to {most.vcpus} vCPU, {gibLabel(most.memMib / 1024)} and a {gibLabel(limits.maxDiskGib)} disk per workspace.</p>}
            </>
          )}
        </>}

        {step === 'agent' && <>
          <div className="field">Open with
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
            <span className="text-faint text-xs font-normal normal-case tracking-normal">A disk checkpoint is saved before the agent starts, so you can roll back.</span>
          </div>}
          <label className="field">Auto-pause
            <select className="input" value={autoPause} onChange={(e) => setAutoPause(e.target.value)}>
              {autoPauseChoices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
        </>}

        {step === 'review' && <>
          <dl className="launch-review">
            <dt>System</dt><dd>{windows ? 'Windows' : 'Linux'}</dd>
            <dt>Name</dt><dd>{name || placeholder}</dd>
            {!windows && <><dt>Start from</dt><dd>{source === 'github' ? repository.trim() : 'Blank'}</dd></>}
            <dt>Size</dt><dd>{summary.replace(/^Windows · /, '')}</dd>
            {!windows && <><dt>Opens with</dt><dd>{agentName}{agent ? ` · ${mode === 'auto' ? 'full auto' : 'asks first'}` : ''}</dd></>}
            {!windows && <><dt>Auto-pause</dt><dd>{autoPauseChoices.find((c) => c.value === autoPause)?.label}</dd></>}
          </dl>
          {!windows && (
            <label className="launch-remember">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 accent-[var(--accent)]" />
              Make these my Quick launch defaults
            </label>
          )}
        </>}

        {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
      </div>

      <div className="modal-foot">
        {at > 0 ? <Button icon={<ArrowLeft />} onClick={() => go(at - 1)}>Back</Button> : <span />}
        <span className="launch-foot-end">
          <span className="launch-summary">{summary}</span>
          {at < steps.length - 1
            ? <Button type="submit" variant="primary" size="lg">Next<ArrowRight /></Button>
            : <Button type="submit" variant="primary" size="lg" live disabled={busy}>{busy ? 'Launching…' : windows ? 'Launch Windows' : 'Launch'}</Button>}
        </span>
      </div>
    </form>
  )
}
