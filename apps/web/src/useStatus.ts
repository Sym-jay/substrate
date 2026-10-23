import { Status } from '@substrate/protocol'
import { useEffect, useState } from 'react'

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; status: Status; at: Date }
  | { kind: 'error'; message: string; last: Status | null }

export function useStatus(intervalMs = 10_000): State {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/api/status')
        if (!res.ok) throw new Error(`control API returned ${res.status}`)
        const status = Status.parse(await res.json())
        if (!cancelled) setState({ kind: 'ok', status, at: new Date() })
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setState((prev) => ({
          kind: 'error',
          message,
          last: prev.kind === 'ok' ? prev.status : prev.kind === 'error' ? prev.last : null,
        }))
      }
    }
    load()
    const timer = setInterval(load, intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [intervalMs])

  return state
}
