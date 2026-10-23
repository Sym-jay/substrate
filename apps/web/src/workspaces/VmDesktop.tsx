import type { Vm, VmGui } from '@substrate/protocol'
import { useCallback, useEffect, useState } from 'react'
import { workspaceApi } from './api.ts'
import { VncView } from './VncView.tsx'

// A microVM's desktop: whether it has one (something answering VNC on it),
// asked every few seconds while it runs, and setting one up.
export function useVmGui(vm: Vm) {
  const [gui, setGui] = useState<VmGui>({ state: 'unavailable', available: false })
  const [error, setError] = useState('')
  const running = vm.state === 'running'

  useEffect(() => {
    if (!running) { setGui({ state: 'unavailable', available: false }); return }
    const controller = new AbortController()
    const load = async () => {
      try { setGui(await workspaceApi.gui(vm.id, controller.signal)) }
      catch { /* an older hostd: no desktop, and the button stays off */ }
    }
    void load()
    const timer = setInterval(load, 5_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [vm.id, running])

  const setup = useCallback(async () => {
    setError('')
    try { setGui(await workspaceApi.setupGui(vm.id)) }
    catch (e) { setError(e instanceof Error ? e.message : 'Couldn’t set up a desktop.') }
  }, [vm.id])

  return { ...gui, error, setup }
}

const why: Record<VmGui['state'], string> = {
  ready: 'Open its desktop',
  off: 'This workspace has no desktop. Set one up below.',
  'setting-up': 'Setting up a desktop…',
  failed: 'Setting up a desktop failed. Try again below.',
  unavailable: 'Start the workspace to use its desktop.',
}

// The Desktop tab: on only when there's a desktop to open.
export function DesktopTab({ gui, selected, onOpen }: { gui: VmGui; selected: boolean; onOpen: () => void }) {
  return (
    <button type="button" aria-pressed={selected && gui.available} disabled={!gui.available} title={why[gui.state]} onClick={onOpen}>
      Desktop{gui.state === 'setting-up' ? ' · setting up…' : ''}
    </button>
  )
}

// Under the tabs, when there's no desktop yet: what to do about it.
export function DesktopSetup({ gui }: { gui: ReturnType<typeof useVmGui> }) {
  if (gui.state !== 'off' && gui.state !== 'failed' && !gui.error) return null
  return (
    <p className="workspace-hint">
      {gui.state === 'failed' ? 'Setting up a desktop failed. ' : 'No desktop in this workspace. '}
      <button type="button" className="underline underline-offset-2" onClick={() => void gui.setup()}>
        {gui.state === 'failed' ? 'Try again' : 'Set one up'}
      </button>
      {' '}(a light desktop with a terminal; a minute or two, then it starts with the workspace).
      {gui.error && <span role="alert" className="workspace-error block">{gui.error}</span>}
    </p>
  )
}

export function VmDesktopView({ vm }: { vm: Vm }) {
  return <VncView label={`${vm.name} desktop`} connect={() => workspaceApi.guiConnection(vm.id)} />
}
