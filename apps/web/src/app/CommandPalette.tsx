import { AppWindow, Camera, CornerDownLeft, Inbox, Layers, LayoutTemplate, ListChecks, PanelLeft, Rocket, ScrollText, Search, Settings, SlidersHorizontal, SquareTerminal, UserRound } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AgentIcon } from './AgentIcon.tsx'
import { agentName } from './agents.ts'
import { useData } from './data.tsx'
import { useLauncher } from './launcher.tsx'
import { navigate, type Page } from './router.ts'
import { updateSettings, useSettings } from './settings.ts'

type Item = { id: string; group: string; label: string; hint?: string; keywords?: string; icon: ReactNode; run: () => void }

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
export const paletteShortcut = isMac ? '⌘K' : 'Ctrl K'
const OPEN = 'substrate:palette'
export const openPalette = () => window.dispatchEvent(new Event(OPEN))

// Whether `query`'s characters appear in `text`, in order; a lower score is a
// closer match (earlier, and more of it together).
function match(text: string, query: string) {
  const at = text.indexOf(query)
  if (at >= 0) return at
  let gaps = 0, last = -1
  for (const ch of query) {
    const next = text.indexOf(ch, last + 1)
    if (next < 0) return null
    gaps += next - last - 1
    last = next
  }
  return 100 + gaps
}

const pages: { page: Page; label: string; icon: ReactNode }[] = [
  { page: 'workspaces', label: 'Workspaces', icon: <SquareTerminal /> },
  { page: 'inbox', label: 'Inbox', icon: <Inbox /> },
  { page: 'templates', label: 'Templates', icon: <LayoutTemplate /> },
  { page: 'snapshots', label: 'Snapshots', icon: <Camera /> },
  { page: 'jobs', label: 'Jobs', icon: <ListChecks /> },
  { page: 'logs', label: 'Logs', icon: <ScrollText /> },
  { page: 'environment', label: 'Environment', icon: <Layers /> },
  { page: 'settings', label: 'Settings', icon: <Settings /> },
  { page: 'profile', label: 'Profile', icon: <UserRound /> },
]

// ⌘K (Ctrl K elsewhere): jump to a page, a workspace or a running agent, or
// launch something, by typing a few letters of it.
export function CommandPalette() {
  const { vms, windows, sessions } = useData()
  const { quickLaunch, configure } = useLauncher()
  const settings = useSettings()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(isMac ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey) return
      // Ctrl K means something in a terminal; leave it there.
      if (!isMac && (e.target as Element | null)?.closest?.('.xterm')) return
      e.preventDefault()
      setOpen((v) => !v)
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener(OPEN, onOpen)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener(OPEN, onOpen) }
  }, [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    const focused = document.activeElement as HTMLElement | null
    requestAnimationFrame(() => input.current?.focus())
    return () => focused?.focus?.()
  }, [open])

  const items = useMemo<Item[]>(() => {
    const close = (run: () => void) => () => { setOpen(false); run() }
    const all: Item[] = [
      { id: 'quick', group: 'Actions', label: 'Quick launch', hint: 'with your defaults', keywords: 'new workspace vm', icon: <Rocket />, run: close(() => void quickLaunch()) },
      { id: 'configure', group: 'Actions', label: 'Launch…', hint: 'size, agent, system', keywords: 'new workspace vm configure windows linux', icon: <SlidersHorizontal />, run: close(() => configure()) },
      { id: 'sidebar', group: 'Actions', label: settings.sidebar === 'collapsed' ? 'Expand the sidebar' : 'Collapse the sidebar', icon: <PanelLeft />, run: close(() => updateSettings({ sidebar: settings.sidebar === 'collapsed' ? 'expanded' : 'collapsed' })) },
      ...Object.entries(sessions).flatMap(([vmId, list]) => list.filter((s) => s.agent && s.state === 'running').map((s) => {
        const vm = vms?.find((v) => v.id === vmId)
        return { id: `s-${s.id}`, group: 'Running agents', label: `${agentName(s.agent)} in ${vm?.name ?? vmId}`, icon: <AgentIcon agent={s.agent!} />, run: close(() => navigate('workspaces', vmId, s.id)) }
      })),
      ...(vms ?? []).map((vm) => ({ id: vm.id, group: 'Workspaces', label: vm.name, hint: vm.state, keywords: `${vm.id} ${vm.repository ?? ''}`, icon: <SquareTerminal />, run: close(() => navigate('workspaces', vm.id)) })),
      ...(windows ?? []).map((w) => ({ id: w.id, group: 'Workspaces', label: w.name, hint: `windows · ${w.state}`, keywords: w.id, icon: <AppWindow />, run: close(() => navigate('windows', w.id)) })),
      ...pages.map((p) => ({ id: `p-${p.page}`, group: 'Pages', label: p.label, keywords: 'go to', icon: p.icon, run: close(() => navigate(p.page)) })),
    ]
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all
      .map((item) => ({ item, score: match(`${item.label} ${item.keywords ?? ''}`.toLowerCase(), q) }))
      .filter((m): m is { item: Item; score: number } => m.score !== null)
      .sort((a, b) => a.score - b.score)
      .map((m) => m.item)
  }, [query, vms, windows, sessions, settings.sidebar, quickLaunch, configure])

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.run() }
  }

  let lastGroup = ''
  return createPortal(
    <div className="palette" onPointerDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}>
      <div className="palette-panel" role="dialog" aria-label="Search" onKeyDown={onKeyDown}>
        <label className="palette-search">
          <Search />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search workspaces, pages and actions" aria-label="Search"
            role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={items[active] ? `palette-${items[active].id}` : undefined} />
          <kbd>esc</kbd>
        </label>
        <div ref={list} id="palette-list" className="palette-list" role="listbox">
          {items.length === 0 && <p className="text-muted px-3 py-6 text-center text-sm">Nothing matches “{query}”.</p>}
          {items.map((item, i) => {
            const heading = item.group !== lastGroup ? item.group : null
            lastGroup = item.group
            return (
              <div key={item.id}>
                {heading && <div className="menu-label">{heading}</div>}
                <button type="button" id={`palette-${item.id}`} role="option" aria-selected={i === active} data-index={i} className="palette-item"
                  onPointerMove={() => setActive(i)} onClick={item.run}>
                  <span className="palette-icon">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="text-faint text-xs">{item.hint}</span>}
                  {i === active && <CornerDownLeft className="palette-enter" />}
                </button>
              </div>
            )
          })}
        </div>
        <div className="palette-foot"><span>↑↓ move</span><span>↵ open</span><span>esc close</span></div>
      </div>
    </div>,
    document.body,
  )
}
