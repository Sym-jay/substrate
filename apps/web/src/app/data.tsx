import type { QuotaStatus, Session, Status, Vm, WindowsWorkspace } from '@substrate/protocol'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStatus } from '../useStatus.ts'
import { AccountApiError, accountApi } from '../account/api.ts'
import { dashboardApi, windowsApi, workspaceApi, WorkspaceApiError, type Job } from '../workspaces/api.ts'

type Data = {
  // Null until the first load.
  vms: Vm[] | null
  vmsError: string | null
  // Why there are no VMs here at all (no host, no sign-in).
  vmsUnavailable: string | null
  status: Status | null
  statusError: string | null
  jobs: Job[]
  // Each running VM's sessions.
  sessions: Record<string, Session[]>
  // Null when the server has no Windows workspaces.
  windows: WindowsWorkspace[] | null
  // The signed-in user's quota and what they've used: undefined until it's
  // in, null when the server has no quotas.
  quota: QuotaStatus | null | undefined
  refresh: () => void
  putVm: (vm: Vm) => void
  dropVm: (id: string) => void
  putWindows: (w: WindowsWorkspace) => void
}

const DataContext = createContext<Data | null>(null)

export function useData() {
  const data = useContext(DataContext)
  if (!data) throw new Error('useData outside DataProvider')
  return data
}

const message = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong')

// Runs `load` now and every `ms`, and again whenever `tick` changes; a load
// that's still going isn't started again.
function usePoll(load: (signal: AbortSignal) => Promise<void>, ms: number, tick: number) {
  const latest = useRef(load)
  latest.current = load
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    const run = async () => {
      if (pending || document.hidden) return
      pending = true
      try { await latest.current(controller.signal) } finally { pending = false }
    }
    void run()
    const timer = setInterval(run, ms)
    const onVisible = () => { if (!document.hidden) void run() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [ms, tick])
}

// Everything the pages show, polled once for all of them.
export function DataProvider({ children }: { children: ReactNode }) {
  const statusState = useStatus()
  const [tick, setTick] = useState(0)
  const [vms, setVms] = useState<Vm[] | null>(null)
  const [vmsError, setVmsError] = useState<string | null>(null)
  const [vmsUnavailable, setVmsUnavailable] = useState<string | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [sessions, setSessions] = useState<Record<string, Session[]>>({})
  const [windows, setWindows] = useState<WindowsWorkspace[] | null>(null)

  usePoll(async (signal) => {
    try {
      setVms(await workspaceApi.list(signal))
      setVmsError(null)
      setVmsUnavailable(null)
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof WorkspaceApiError && error.status === 503) setVmsUnavailable(error.message)
      else setVmsError(message(error))
    }
  }, 5_000, tick)

  usePoll(async (signal) => {
    setJobs(await dashboardApi.jobs(signal).catch(() => []))
  }, 5_000, tick)

  usePoll(async (signal) => {
    try { setWindows(await windowsApi.list(signal)) }
    catch (error) { if (!signal.aborted && error instanceof WorkspaceApiError && [401, 404, 503].includes(error.status)) setWindows(null) }
  }, 8_000, tick)

  const [quota, setQuota] = useState<QuotaStatus | null | undefined>(undefined)
  usePoll(async (signal) => {
    try { setQuota(await accountApi.quota(signal)) }
    catch (error) { if (!signal.aborted && error instanceof AccountApiError && [401, 404, 503].includes(error.status)) setQuota(null) }
  }, 60_000, tick)

  // Sessions for the VMs that are running (the others' can't be asked).
  const running = useMemo(() => (vms ?? []).filter((vm) => vm.state === 'running').map((vm) => vm.id).join(','), [vms])
  usePoll(async (signal) => {
    const ids = running ? running.split(',') : []
    const entries = await Promise.all(ids.map(async (id) => [id, await workspaceApi.sessions(id, signal).catch(() => null)] as const))
    if (signal.aborted) return
    setSessions((previous) => {
      const next: Record<string, Session[]> = {}
      for (const [id, list] of entries) next[id] = list ?? previous[id] ?? []
      return next
    })
  }, 10_000, tick + running.length)

  const refresh = useCallback(() => setTick((n) => n + 1), [])
  const putVm = useCallback((vm: Vm) => setVms((prev) => (prev ? [...prev.filter((v) => v.id !== vm.id), vm] : [vm])), [])
  const dropVm = useCallback((id: string) => setVms((prev) => prev?.filter((v) => v.id !== id) ?? null), [])
  // Replaces it, or adds it if it's new (just launched).
  const putWindows = useCallback((w: WindowsWorkspace) => setWindows((prev) => prev && (prev.some((p) => p.id === w.id) ? prev.map((p) => (p.id === w.id ? w : p)) : [...prev, w])), [])

  const status = statusState.kind === 'ok' ? statusState.status : statusState.kind === 'error' ? statusState.last : null
  const value: Data = {
    vms: vms ? [...vms].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : null,
    vmsError, vmsUnavailable, status,
    statusError: statusState.kind === 'error' ? statusState.message : null,
    jobs, sessions, windows, quota, refresh, putVm, dropVm, putWindows,
  }
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}
