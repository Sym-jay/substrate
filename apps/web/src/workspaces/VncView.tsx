import RFB from '@novnc/novnc'
import { useEffect, useRef, useState } from 'react'

export type DesktopState = 'connecting' | 'connected' | 'disconnected' | 'error'
const labels: Record<DesktopState, string> = {
  connecting: 'Connecting…', connected: 'Connected', disconnected: 'Disconnected', error: 'Couldn’t connect',
}

// A desktop over VNC, through noVNC, drawn into `screen` while `enabled`: a
// Windows workspace's, or a microVM's. `connect` gives a fresh WebSocket URL
// (tickets work once) and, if the VNC server has one, its password; `target`
// names what it connects to, and a new one reconnects. It scales to fit, and
// works with touch (tap to click, drag to move the pointer). The page around
// it shows the status and the controls.
export function useVnc(target: string, connect: () => Promise<{ url: string; password?: string }>, enabled = true) {
  const screen = useRef<HTMLDivElement>(null)
  const rfb = useRef<RFB | null>(null)
  const latest = useRef(connect)
  latest.current = connect
  const [state, setState] = useState<DesktopState>('connecting')
  const [detail, setDetail] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setState('connecting')
    setDetail('')
    void latest.current().then(({ url, password }) => {
      if (cancelled || !screen.current) return
      const client = new RFB(screen.current, url, { credentials: password ? { password } : {}, wsProtocols: [] })
      client.scaleViewport = true
      client.focusOnClick = true
      client.background = '#000'
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
  }, [target, attempt, enabled])

  return {
    screen,
    state,
    status: `${labels[state]}${detail ? `: ${detail}` : ''}`,
    ctrlAltDel: () => rfb.current?.sendCtrlAltDel(),
    reconnect: () => setAttempt((n) => n + 1),
  }
}
