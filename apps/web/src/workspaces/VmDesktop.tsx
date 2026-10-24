import type { Vm, VmGui } from '@substrate/protocol'
import { Monitor, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button, Empty } from '../app/ui.tsx'
import { workspaceApi } from './api.ts'
import { useVnc } from './VncView.tsx'

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
      catch { /* an older hostd: no desktop */ }
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

  // Closes it: it stops, and stays off until it's set up again.
  const close = useCallback(async () => {
    const next = await workspaceApi.closeGui(vm.id)
    setGui(next)
    return next
  }, [vm.id])

  return { ...gui, error, setup, close }
}

// The Desktop tab's pane: the desktop when there is one, and otherwise what
// to do about it.
export function VmDesktop({ vm, gui }: { vm: Vm; gui: ReturnType<typeof useVmGui> }) {
  if (gui.available) return <VmDesktopView vm={vm} />
  const empty = (title: string, body: string, action?: string) => (
    <div className="flex h-full items-center justify-center">
      <Empty icon={<Monitor />} title={title}>
        {body}
        {action && <div className="mt-4 flex justify-center"><Button variant="primary" onClick={() => void gui.setup()}>{action}</Button></div>}
        {gui.error && <p role="alert" className="mt-3 text-[var(--bad)]">{gui.error}</p>}
      </Empty>
    </div>
  )
  switch (gui.state) {
    case 'setting-up': return empty('Setting up a desktop', 'A minute or two. After that it starts with the workspace.')
    case 'failed': return empty('Setting up a desktop failed', 'Try again; it picks up where it stopped.', 'Try again')
    case 'off': return empty('No desktop yet', 'A light desktop with a terminal, in the browser. It takes a minute or two to set up, then starts with the workspace.', 'Set one up')
    default: return empty('No desktop while it’s off', 'Start the workspace to use its desktop.')
  }
}

function VmDesktopView({ vm }: { vm: Vm }) {
  const vnc = useVnc(vm.id, () => workspaceApi.guiConnection(vm.id))
  return (
    <div className="vm-desktop">
      <div className="vm-desktop-bar">
        <span role="status" className={vnc.state === 'error' ? 'text-[var(--bad)]' : 'text-muted'}>{vnc.status}</span>
        <span className="ml-auto" />
        {(vnc.state === 'disconnected' || vnc.state === 'error') && <Button size="sm" variant="ghost" icon={<RotateCw />} onClick={vnc.reconnect}>Reconnect</Button>}
        <Button size="sm" variant="ghost" disabled={vnc.state !== 'connected'} onClick={vnc.ctrlAltDel} title="Send Ctrl+Alt+Del">Ctrl+Alt+Del</Button>
      </div>
      <div className="vm-desktop-body"><div ref={vnc.screen} className="win-screen" aria-label={`${vm.name} desktop`} /></div>
    </div>
  )
}
