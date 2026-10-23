import RFB from '@novnc/novnc'
import { useEffect, useRef, useState } from 'react'

type State = 'connecting' | 'connected' | 'disconnected' | 'error'
const labels: Record<State, string> = {
  connecting: 'Connecting…', connected: 'Connected', disconnected: 'Disconnected', error: 'Couldn’t connect',
}

// A desktop over VNC, through noVNC: a Windows workspace's, or a microVM's.
// `connect` gives a fresh WebSocket URL (tickets work once) and, if the VNC
// server has one, its password. It scales to fit, and works with touch.
export function VncView({ connect, label = 'Desktop' }: { connect: () => Promise<{ url: string; password?: string }>; label?: string }) {
  const container = useRef<HTMLDivElement>(null)
  const rfb = useRef<RFB | null>(null)
  const latest = useRef(connect)
  latest.current = connect
  const [state, setState] = useState<State>('connecting')
  const [detail, setDetail] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState('connecting')
    setDetail('')
    void latest.current().then(({ url, password }) => {
      if (cancelled || !container.current) return
      const client = new RFB(container.current, url, { credentials: password ? { password } : {}, wsProtocols: [] })
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
  }, [attempt])

  return (
    <div className="desktop-view">
      <div className="desktop-toolbar">
        <span className={`desktop-state is-${state}`} role="status">{label}: {labels[state]}{detail ? ` (${detail})` : ''}</span>
        <div className="flex gap-2">
          <button type="button" className="workspace-button secondary" disabled={state !== 'connected'} onClick={() => rfb.current?.sendCtrlAltDel()}>Ctrl+Alt+Del</button>
          {(state === 'disconnected' || state === 'error') && <button type="button" className="workspace-button secondary" onClick={() => setAttempt((n) => n + 1)}>Reconnect</button>}
        </div>
      </div>
      <div ref={container} className="desktop-screen" aria-label={label} />
    </div>
  )
}
