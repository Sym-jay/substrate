import type { VmLogs } from '@substrate/protocol'
import { RefreshCw, ScrollText, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useData } from '../app/data.tsx'
import { navigate } from '../app/router.ts'
import { Button, Card, Empty, PageHeader, Segmented } from '../app/ui.tsx'
import { dashboardApi } from '../workspaces/api.ts'

type Source = 'console' | 'host'

// A workspace's logs: its console (boot, kernel, services) and what the host
// logged about it (starts, pauses, recoveries, alerts).
export function LogsPage({ params }: { params: string[] }) {
  const { vms } = useData()
  const vmId = params[0] ?? vms?.[0]?.id
  const vm = vms?.find((v) => v.id === vmId)
  const [source, setSource] = useState<Source>('console')
  const [lines, setLines] = useState(200)
  const [follow, setFollow] = useState(true)
  const [filter, setFilter] = useState('')
  const [logs, setLogs] = useState<VmLogs | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const viewer = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    if (!vmId) return
    const controller = new AbortController()
    const load = async () => {
      try {
        setLogs(await dashboardApi.logs(vmId, lines, controller.signal))
        setError('')
      } catch (e) {
        if (controller.signal.aborted) return
        const message = e instanceof Error ? e.message : 'Couldn’t read the logs.'
        setError(/\(404\)/.test(message) ? 'The host doesn’t serve logs yet: deploy the newest hostd (bun run deploy:host).' : message)
      }
    }
    void load()
    if (!follow) return () => controller.abort()
    const timer = setInterval(load, 5_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [vmId, lines, follow, tick])

  const text = logs ? logs[source] : ''
  const shown = filter ? text.split('\n').filter((l) => l.toLowerCase().includes(filter.toLowerCase())).join('\n') : text

  // Stay at the bottom as lines arrive, unless you've scrolled up to read.
  useEffect(() => {
    const el = viewer.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [shown])

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader title="Logs" subtitle="A workspace’s console, and what the host did with it" actions={
        <Button size="sm" icon={<RefreshCw />} onClick={() => setTick((n) => n + 1)}>Refresh</Button>
      } />
      {!vms?.length ? <Card><Empty icon={<ScrollText />} title="No workspaces">Logs appear here for each workspace.</Empty></Card> : (
        <Card className="rise">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <select className="input !w-auto" value={vmId} onChange={(e) => navigate('logs', e.target.value)} aria-label="Workspace">
              {vms.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.state})</option>)}
            </select>
            <Segmented label="Source" value={source} onChange={setSource} options={[{ value: 'console', label: 'Console' }, { value: 'host', label: 'Host events' }]} />
            <select className="input !w-auto" value={lines} onChange={(e) => setLines(Number(e.target.value))} aria-label="Lines">
              {[100, 200, 500, 1000].map((n) => <option key={n} value={n}>Last {n} lines</option>)}
            </select>
            <label className="text-muted flex items-center gap-2 text-sm"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="size-4 accent-zinc-400" />Follow</label>
            <label className="relative ml-auto min-w-48 flex-1 sm:flex-none">
              <Search className="text-faint pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <input className="input !pl-9" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter lines" aria-label="Filter lines" />
            </label>
          </div>
          {error ? <p role="alert" className="text-sm text-[var(--bad)]">{error}</p> : (
            <pre ref={viewer} className="log-view" onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
              {logs === null ? 'Loading…' : shown || (filter ? 'No lines match.' : source === 'console' ? `Nothing on ${vm?.name ?? 'its'} console yet.` : 'The host hasn’t logged anything about it recently.')}
            </pre>
          )}
        </Card>
      )}
    </div>
  )
}
