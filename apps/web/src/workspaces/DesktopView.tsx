import RFB from '@novnc/novnc'
import { useEffect, useRef, useState } from 'react'
import { windowsApi } from './api.ts'

export type DesktopState = 'connecting' | 'connected' | 'disconnected' | 'error'
const labels: Record<DesktopState, string> = {
  connecting: 'Connecting…', connected: 'Connected', disconnected: 'Disconnected', error: 'Couldn’t connect',
}

// A Windows workspace's desktop, through noVNC, drawn into `screen` while
// `enabled`. It scales to fit, and works with touch (tap to click, drag to
// move the pointer). The page around it shows the status and the controls.
export function useDesktop(workspaceId: string, enabled: boolean) {
  const screen = useRef<HTMLDivElement>(null)
  const rfb = useRef<RFB | null>(null)
  const [state, setState] = useState<DesktopState>('connecting')
  const [detail, setDetail] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setState('connecting')
    setDetail('')
    void windowsApi.desktop(workspaceId).then(({ url, password }) => {
      if (cancelled || !screen.current) return
      const client = new RFB(screen.current, url, { credentials: { password }, wsProtocols: [] })
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
  }, [workspaceId, attempt, enabled])

  return {
    screen,
    state,
    status: `${labels[state]}${detail ? `: ${detail}` : ''}`,
    ctrlAltDel: () => rfb.current?.sendCtrlAltDel(),
    reconnect: () => setAttempt((n) => n + 1),
  }
}
