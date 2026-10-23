import { Activity, AppWindow, Cpu, House, Inbox, Rocket, ScrollText, Settings, SquareTerminal } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useData } from './data.tsx'
import { useLauncher } from './launcher.tsx'
import { href, useRoute, type Page } from './router.ts'
import { Button } from './ui.tsx'

type Item = { page: Page; label: string; icon: ReactNode; badge?: number }

// The page frame: a floating sidebar (a floating tab bar on phones) and the
// page itself, which cross-fades when it changes.
export function Shell({ account, children }: { account?: ReactNode; children: ReactNode }) {
  const { page } = useRoute()
  const { windows, sessions, status } = useData()
  const { launching, quickLaunch } = useLauncher()
  const agentsWorking = Object.values(sessions).flat().filter((s) => s.agent && s.state === 'running').length
  const items: Item[] = [
    { page: 'home', label: 'Home', icon: <House /> },
    { page: 'inbox', label: 'Inbox', icon: <Inbox /> },
    { page: 'workspaces', label: 'Workspaces', icon: <SquareTerminal /> },
    ...(windows ? [{ page: 'windows' as const, label: 'Windows', icon: <AppWindow /> }] : []),
    { page: 'jobs', label: 'Jobs', icon: <Activity />, badge: agentsWorking || undefined },
    { page: 'compute', label: 'Compute', icon: <Cpu /> },
    { page: 'logs', label: 'Logs', icon: <ScrollText /> },
    { page: 'settings', label: 'Settings', icon: <Settings /> },
  ]
  const host = status?.host.configured ? status.host : null

  return (
    <div className="shell">
      <aside className="sidebar card" aria-label="Main">
        <a href={href('home')} className="sidebar-brand">
          <img src="/favicon.svg" alt="" className="size-8 shrink-0" />
          <span className="sidebar-text">
            <span className="text-chrome block text-[15px] font-semibold tracking-tight">Substrate</span>
            <span className="text-faint block text-[11px]">Sandboxes for coding agents</span>
          </span>
        </a>
        <Button variant="chrome" className="sidebar-launch" icon={<Rocket />} disabled={launching} onClick={() => quickLaunch()} title="Quick launch">
          <span className="sidebar-text">{launching ? 'Launching…' : 'Quick launch'}</span>
        </Button>
        <FlowNav items={items} active={page} orientation="vertical" />
        <div className="sidebar-foot">
          {host && (
            <a href={href('compute')} className="sidebar-host" title={`Host ${host.state}`}>
              <span className={`dot ${host.state === 'running' ? 'is-ok' : host.state === 'stopped' ? '' : 'is-busy'}`} />
              <span className="sidebar-text truncate">Host {host.state} · {host.instanceType}</span>
            </a>
          )}
          {account && <div className="sidebar-account">{account}</div>}
        </div>
      </aside>

      <nav className="tabbar card" aria-label="Main">
        <FlowNav items={items} active={page} orientation="horizontal" />
      </nav>

      <main className="page" style={{ viewTransitionName: 'page' }}>{children}</main>
    </div>
  )
}

// The nav list, with a polished-silver pill behind the current page. Moving
// to another page, the pill's leading edge goes first and the trailing edge
// follows, so it stretches and settles like something poured.
function FlowNav({ items, active, orientation }: { items: Item[]; active: Page; orientation: 'vertical' | 'horizontal' }) {
  const list = useRef<HTMLUListElement>(null)
  const [pill, setPill] = useState<{ start: number; end: number; forward: boolean; moving: boolean } | null>(null)
  const vertical = orientation === 'vertical'

  useLayoutEffect(() => {
    const measure = () => {
      const el = list.current?.querySelector<HTMLElement>(`[data-page="${active}"]`)
      if (!el || !list.current) return
      const size = vertical ? list.current.clientHeight : list.current.clientWidth
      if (!size) return
      const start = vertical ? el.offsetTop : el.offsetLeft
      const end = size - start - (vertical ? el.offsetHeight : el.offsetWidth)
      setPill((prev) => (prev && prev.start === start && prev.end === end ? prev : { start, end, forward: !prev || start >= prev.start, moving: !!prev && prev.start !== start }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (list.current) observer.observe(list.current)
    return () => observer.disconnect()
  }, [active, items.length, vertical])

  useEffect(() => {
    if (!pill?.moving) return
    const timer = setTimeout(() => setPill((p) => (p ? { ...p, moving: false } : p)), 650)
    return () => clearTimeout(timer)
  }, [pill?.moving, pill?.start])

  const [a, b] = vertical ? ['top', 'bottom'] : ['left', 'right']
  const lead = pill?.forward ? b : a
  const trail = pill?.forward ? a : b
  return (
    <ul ref={list} className={`flow-nav is-${orientation}`}>
      {pill && (
        <span
          aria-hidden
          className={`flow-pill ${pill.moving ? 'is-moving' : ''}`}
          style={{
            [a]: pill.start,
            [b]: pill.end,
            transition: `${lead} 0.34s var(--ease-lead), ${trail} 0.6s var(--ease-flow) 0.05s`,
          }}
        />
      )}
      {items.map((item) => (
        <li key={item.page}>
          <a href={href(item.page)} data-page={item.page} className="flow-item" aria-current={item.page === active ? 'page' : undefined} title={item.label}>
            {item.icon}
            <span className="flow-label">{item.label}</span>
            {item.badge !== undefined && <span className="flow-badge">{item.badge}</span>}
          </a>
        </li>
      ))}
    </ul>
  )
}
