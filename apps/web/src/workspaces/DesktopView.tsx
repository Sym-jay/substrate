import RFB from '@novnc/novnc'
import { useEffect, useRef, useState } from 'react'
import { windowsApi } from './api.ts'

type State = 'connecting' | 'connected' | 'disconnected' | 'error'
const labels: Record<State, string> = {
  connecting: 'Connecting…', connected: 'Connected', disconnected: 'Disconnected', error: 'Couldn’t connect',
}

// A Windows workspace's desktop, through noVNC. It scales to fit, and works
// with touch (tap to click, drag to move the pointer).
export function DesktopView({ workspaceId }: { workspaceId: string }) {
  const container = useRef<HTMLDivElement>(null)
  const rfb = useRef<RFB | null>(null)
  const [state, setState] = useState<State>('connecting')
  const [detail, setDetail] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState('connecting')
    setDetail('')
    void windowsApi.desktop(workspaceId).then(({ url, password }) => {
      if (cancelled || !container.current) return
      const client = new RFB(container.current, url, { credentials: { password }, wsProtocols: [] })
      client.scaleViewport = true
      client.focusOnClick = true
      client.addEventListener('connect', () => setState('connected'))
      client.addEventListener('disconnect', (event) => {
        const clean = (event as CustomEvent<{ clean: boolean }>).detail?.clean
        setState(clean ? 'disconnected' : 'error')
      })
      client.addEventListener('securityfailure', (event) => setDetail((event as CustomEvent<{ reason?: string }>).detail?.reason ?? 'VNC sign-in failed'))
      rfb.current = client
    }).catch((error: Error) => {
      if (cancelled) return
      setState('error')
      setDetail(error.message)
    })
    return () => {
      cancelled = true
      rfb.current?.disconnect()
      rfb.current = null
    }
  }, [workspaceId, attempt])

  return (
    <div className="desktop-view">
      <div className="desktop-toolbar">
        <span className={`desktop-state is-${state}`} role="status">{labels[state]}{detail ? `: ${detail}` : ''}</span>
        <div className="flex gap-2">
          <button type="button" className="workspace-button secondary" disabled={state !== 'connected'} onClick={() => rfb.current?.sendCtrlAltDel()}>Ctrl+Alt+Del</button>
          {(state === 'disconnected' || state === 'error') && <button type="button" className="workspace-button secondary" onClick={() => setAttempt((n) => n + 1)}>Reconnect</button>}
        </div>
      </div>
      <div ref={container} className="desktop-screen" aria-label="Windows desktop" />
    </div>
  )
}
