import { Camera, Ellipsis, Layers, LayoutTemplate, ListChecks, PanelLeftClose, PanelLeftOpen, ScrollText, Search, Settings, SquarePlus, SquareTerminal } from 'lucide-react'
import { useSyncExternalStore, type ReactNode } from 'react'
import type { Profile } from '../pages/ProfilePage.tsx'
import { AccountCorner } from './AccountCorner.tsx'
import { ActionCenter } from './ActionCenter.tsx'
import { openPalette, paletteShortcut } from './CommandPalette.tsx'
import { useData } from './data.tsx'
import { useLauncher } from './launcher.tsx'
import { Wordmark } from './Logo.tsx'
import { href, navigate, useRoute, type Page } from './router.ts'
import { updateSettings, useSettings } from './settings.ts'
import { WorkspaceSidebar } from './WorkspaceSidebar.tsx'
import { Button, Menu, MenuItem, useHoverWave } from './ui.tsx'

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
// floating tab bar on phones), the page itself, which cross-fades when it
// changes, and the inbox and account in the page's top right corner.
export function Shell({ profile, children }: { profile?: Profile; children: ReactNode }) {
  const { page, params } = useRoute()
  const { sessions } = useData()
  const { launching, configure } = useLauncher()
  const agentsWorking = Object.values(sessions).flat().filter((s) => s.agent && s.state === 'running').length
  const workspaces: Item = { page: 'workspaces', label: 'Workspaces', icon: <SquareTerminal /> }
  const jobs: Item = { page: 'jobs', label: 'Jobs', icon: <ListChecks />, badge: agentsWorking || undefined }
  const settings: Item = { page: 'settings', label: 'Settings', icon: <Settings /> }
  const templates: Item = { page: 'templates', label: 'Templates', icon: <LayoutTemplate /> }
  const snapshots: Item = { page: 'snapshots', label: 'Snapshots', icon: <Camera /> }
  const logs: Item = { page: 'logs', label: 'Logs', icon: <ScrollText /> }
  const environment: Item = { page: 'environment', label: 'Environment', icon: <Layers /> }
  const main: Item[] = [workspaces, templates, snapshots, jobs, logs]
  const setup: Item[] = [environment, settings]
  // On phones, the pages the tab bar has no room for.
  const more: Item[] = [snapshots, logs, environment, settings]
  const { sidebar } = useSettings()
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow)
  const collapsed = narrow || sidebar === 'collapsed'
  // With a workspace open, the sidebar slides over to that workspace's panel.
  const nested = page === 'workspaces' && !!params[0]
  const searchWave = useHoverWave()

  return (
    <div className={`shell ${collapsed ? 'is-collapsed' : ''}`}>
      <aside className="sidebar card" aria-label="Main">
        <div className={`sidebar-track ${nested ? 'is-nested' : ''}`}>
        <div className="sidebar-panel" inert={nested}>
        <div className="sidebar-top">
          {/* The wordmark; folded, its first letter stands in. */}
          <a href={href('welcome')} className="sidebar-brand" aria-label="Substrate">
            <span className="brand-mark"><Wordmark short /></span>
            <span className="sidebar-text"><Wordmark /></span>
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
        <button type="button" className="nav-item sidebar-search" onClick={openPalette} title={`Search (${paletteShortcut})`} {...searchWave.handlers}>
          <span ref={searchWave.field} className="nav-flow" aria-hidden />
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
        {/* In a workspace's panel there's no launching; the panel is that workspace's. */}
        {!nested && (
          <div className="sidebar-foot">
            <Button variant="primary" className="sidebar-launch" icon={<SquarePlus />} live disabled={launching} onClick={() => configure()} title="Launch a VM">
              <span className="sidebar-text">{launching ? 'Launching…' : 'Launch VM'}</span>
            </Button>
          </div>
        )}
      </aside>

      <nav className="tabbar card" aria-label="Main">
        <Nav items={[workspaces, templates, jobs]} active={page} orientation="horizontal">
          <li><button type="button" className="nav-item w-full" onClick={openPalette} aria-label="Search" title="Search"><Search /></button></li>
          {/* The rest of the pages; it's the current one while you're on any of them. */}
          <li>
            <Menu align="end" button={({ open, toggle }) => (
              <button type="button" className="nav-item w-full" aria-haspopup="menu" aria-expanded={open} aria-label="More pages" title="More"
                aria-current={more.some((m) => m.page === page) ? 'page' : undefined} onClick={toggle}><Ellipsis /></button>
            )}>
              {(close) => more.map((m) => (
                <MenuItem key={m.page} icon={m.icon} current={m.page === page} onClick={() => { close(); navigate(m.page) }}>{m.label}</MenuItem>
              ))}
            </Menu>
          </li>
        </Nav>
      </nav>

      <main className="page" style={{ viewTransitionName: 'page' }}>
        {/* Not inside a workspace: that view is the workspace's own. */}
        {/* Phones have no sidebar: the logo sits top left (the welcome page has its own). */}
        {!nested && page !== 'welcome' && (
          <a href={href('welcome')} className="mobile-brand" aria-label="Substrate"><Wordmark /></a>
        )}
        {!nested && (
          <div className="page-corner">
            <ActionCenter />
            <AccountCorner profile={profile} />
          </div>
        )}
        {children}
      </main>
    </div>
  )
}

// The nav list; the current page is filled in blue.
function Nav({ items, active, orientation, children }: { items: Item[]; active: Page; orientation: 'vertical' | 'horizontal'; children?: ReactNode }) {
  return (
    <ul className={`nav-list is-${orientation}`}>
      {items.map((item) => <li key={item.page}><NavLink item={item} current={item.page === active} /></li>)}
      {children}
    </ul>
  )
}

// One page in the nav. Hovered, the ASCII wave runs inside it, as in a
// primary button.
function NavLink({ item, current }: { item: Item; current: boolean }) {
  const wave = useHoverWave()
  return (
    <a href={href(item.page)} className="nav-item" aria-current={current ? 'page' : undefined} title={item.label} {...wave.handlers}>
      <span ref={wave.field} className="nav-flow" aria-hidden />
      {item.icon}
      <span className="nav-label">{item.label}</span>
      {item.badge !== undefined && <span className="nav-badge">{item.badge}</span>}
    </a>
  )
}
