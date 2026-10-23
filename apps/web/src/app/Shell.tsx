import { Activity, AppWindow, Camera, Inbox, Layers, PanelLeftClose, PanelLeftOpen, Rocket, ScrollText, Search, Settings, SquareTerminal } from 'lucide-react'
import { useSyncExternalStore, type ReactNode } from 'react'
import { openPalette, paletteShortcut } from './CommandPalette.tsx'
import { useData } from './data.tsx'
import { useLauncher } from './launcher.tsx'
import { href, useRoute, type Page } from './router.ts'
import { updateSettings, useSettings } from './settings.ts'
import { WorkspaceSidebar } from './WorkspaceSidebar.tsx'
import { Button } from './ui.tsx'

type Item = { page: Page; label: string; icon: ReactNode; badge?: number }

// Between phones and wide screens there's only room for the icons.
const narrowQuery = '(min-width: 768px) and (max-width: 1180px)'
const subscribeNarrow = (listener: () => void) => {
  const query = window.matchMedia?.(narrowQuery)
  query?.addEventListener('change', listener)
  return () => query?.removeEventListener('change', listener)
}
const isNarrow = () => window.matchMedia?.(narrowQuery).matches ?? false

// The page frame: a floating sidebar, which folds down to its icons (a
// floating tab bar on phones), and the page itself, which cross-fades when it
// changes.
export function Shell({ account, children }: { account?: ReactNode; children: ReactNode }) {
  const { page, params } = useRoute()
  const { windows, sessions } = useData()
  const { launching, configure } = useLauncher()
  const agentsWorking = Object.values(sessions).flat().filter((s) => s.agent && s.state === 'running').length
  const workspaces: Item = { page: 'workspaces', label: 'Workspaces', icon: <SquareTerminal /> }
  const windowsItem: Item[] = windows ? [{ page: 'windows', label: 'Windows', icon: <AppWindow /> }] : []
  const jobs: Item = { page: 'jobs', label: 'Jobs', icon: <Activity />, badge: agentsWorking || undefined }
  const settings: Item = { page: 'settings', label: 'Settings', icon: <Settings /> }
  const main: Item[] = [{ page: 'inbox', label: 'Inbox', icon: <Inbox /> }, workspaces, ...windowsItem, { page: 'snapshots', label: 'Snapshots', icon: <Camera /> }, jobs, { page: 'logs', label: 'Logs', icon: <ScrollText /> }]
  const setup: Item[] = [{ page: 'environment', label: 'Environment', icon: <Layers /> }, settings]
  const { sidebar } = useSettings()
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow)
  const collapsed = narrow || sidebar === 'collapsed'
  // With a workspace open, the sidebar slides over to that workspace's panel.
  const nested = page === 'workspaces' && !!params[0]

  return (
    <div className={`shell ${collapsed ? 'is-collapsed' : ''}`}>
      <aside className="sidebar card" aria-label="Main">
        <div className={`sidebar-track ${nested ? 'is-nested' : ''}`}>
        <div className="sidebar-panel" inert={nested}>
        <div className="sidebar-top">
          <a href={href('welcome')} className="sidebar-brand">
            <img src="/favicon.svg" alt="" className="size-8 shrink-0" />
            <span className="sidebar-text heading text-[15px] font-semibold tracking-tight">Substrate</span>
          </a>
          {/* Top right; folded, it slides over the logo and shows on hover. */}
          {!narrow && (
            <Button
              variant="ghost"
              className="sidebar-toggle"
              icon={collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
              title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
              onClick={() => updateSettings({ sidebar: collapsed ? 'expanded' : 'collapsed' })}
            />
          )}
        </div>
        <button type="button" className="nav-item sidebar-search" onClick={openPalette} title={`Search (${paletteShortcut})`}>
          <Search /><span className="nav-label">Search</span><kbd>{paletteShortcut}</kbd>
        </button>
        <div>
          <Nav items={main} active={page} orientation="vertical" />
          <div className="nav-rule" />
          <Nav items={setup} active={page} orientation="vertical" />
        </div>
        </div>
        <div className="sidebar-panel" inert={!nested}>
          <WorkspaceSidebar vmId={nested ? params[0] : undefined} collapsed={collapsed} narrow={narrow} />
        </div>
        </div>
        <div className="sidebar-foot">
          <Button variant="primary" className="sidebar-launch" icon={<Rocket />} live disabled={launching} onClick={() => configure()} title="Launch a VM">
            <span className="sidebar-text">{launching ? 'Launching…' : 'Launch VM'}</span>
          </Button>
          {account && <div className="sidebar-account">{account}</div>}
        </div>
      </aside>

      <nav className="tabbar card" aria-label="Main">
        <Nav items={[workspaces, ...windowsItem, jobs, settings]} active={page} orientation="horizontal">
          <li><button type="button" className="nav-item w-full" onClick={openPalette} aria-label="Search" title="Search"><Search /></button></li>
        </Nav>
      </nav>

      <main className="page" style={{ viewTransitionName: 'page' }}>{children}</main>
    </div>
  )
}

// The nav list; the current page is outlined.
function Nav({ items, active, orientation, children }: { items: Item[]; active: Page; orientation: 'vertical' | 'horizontal'; children?: ReactNode }) {
  return (
    <ul className={`nav-list is-${orientation}`}>
      {items.map((item) => (
        <li key={item.page}>
          <a href={href(item.page)} className="nav-item" aria-current={item.page === active ? 'page' : undefined} title={item.label}>
            {item.icon}
            <span className="nav-label">{item.label}</span>
            {item.badge !== undefined && <span className="nav-badge">{item.badge}</span>}
          </a>
        </li>
      ))}
      {children}
    </ul>
  )
}
