import { useState } from 'react'
import type { UpdateVm, Vm } from '@substrate/protocol'
import { workspaceApi } from './api.ts'

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.'

const autoPauseChoices = [null, 5, 10, 30, 60, 240]
const maxRunChoices = [null, 4, 8, 12, 24, 48, 72]
const idleFor = (minutes: number) => minutes < 60 || minutes % 60 ? `After ${minutes} min idle` : `After ${minutes / 60} h idle`
const runFor = (hours: number) => `After ${hours} h`
// A value set elsewhere (the CLI) still shows, among the usual choices.
const withCurrent = (choices: (number | null)[], current: number | null) =>
  choices.includes(current) ? choices : [...choices, current].sort((a, b) => (a ?? 0) - (b ?? 0))

// When the VM pauses itself: after being idle this long (docs/m4.md), and
// after running this long even if busy, so a stuck agent can't run forever (docs/m7.md).
export function PauseSettings({ vm, onChange }: { vm: Vm; onChange: (vm: Vm) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // An older hostd doesn't have the settings.
  if (vm.autoPauseMinutes === undefined) return null
  const change = async (input: UpdateVm) => {
    setBusy(true)
    setError('')
    try { onChange(await workspaceApi.update(vm.id, input)) }
    catch (error) { setError(errorMessage(error)) }
    finally { setBusy(false) }
  }
  const value = (v: string) => (v === 'off' ? null : Number(v))
  return (
    <div className="workspace-autopause">
      <label>Auto-pause
        <select value={vm.autoPauseMinutes ?? 'off'} disabled={busy} onChange={(e) => void change({ autoPauseMinutes: value(e.target.value) })}>
          {withCurrent(autoPauseChoices, vm.autoPauseMinutes).map((m) => <option key={m ?? 'off'} value={m ?? 'off'}>{m === null ? 'Off' : idleFor(m)}</option>)}
        </select>
      </label>
      {vm.maxAwakeHours !== undefined && <label>Max run
        <select value={vm.maxAwakeHours ?? 'off'} disabled={busy} onChange={(e) => void change({ maxAwakeHours: value(e.target.value) })}>
          {withCurrent(maxRunChoices, vm.maxAwakeHours).map((h) => <option key={h ?? 'off'} value={h ?? 'off'}>{h === null ? 'No limit' : runFor(h)}</option>)}
        </select>
      </label>}
      {error && <p role="alert" className="workspace-error">{error}</p>}
    </div>
  )
}
