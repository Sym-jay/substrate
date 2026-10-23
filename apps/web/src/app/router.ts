import { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'

// Pages live in the URL's hash (#/workspaces/vm-1/session-2), so links and
// reloads work wherever the app is served from.
export type Page = 'welcome' | 'inbox' | 'workspaces' | 'windows' | 'snapshots' | 'jobs' | 'logs' | 'environment' | 'settings'
export type Route = { page: Page; params: string[] }

const pages: Page[] = ['welcome', 'inbox', 'workspaces', 'windows', 'snapshots', 'jobs', 'logs', 'environment', 'settings']

export function parse(hash: string): Route {
  const [first = '', ...params] = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  const page = pages.includes(first as Page) ? (first as Page) : 'welcome'
  return { page, params: page === first ? params : [] }
}

let route = parse(location.hash)
const listeners = new Set<() => void>()
const update = () => {
  route = parse(location.hash)
  for (const listener of listeners) listener()
}
window.addEventListener('hashchange', () => transition(update))

export function useRoute() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, () => route)
}

export const href = (page: Page, ...params: string[]) => `#/${[page, ...params].map(encodeURIComponent).join('/')}`

// Goes to a page. Within the same page (a different VM, say) it replaces the
// history entry rather than adding one.
export function navigate(page: Page, ...params: string[]) {
  const next = href(page, ...params)
  if (location.hash === next) return
  if (page === route.page) history.replaceState(null, '', next)
  else history.pushState(null, '', next)
  transition(update)
}

// Page changes cross-fade where the browser has view transitions.
let lastPage = route.page
function transition(change: () => void) {
  const nextPage = parse(location.hash).page
  const animate = nextPage !== lastPage && 'startViewTransition' in document && document.documentElement.dataset.motion !== 'reduced'
  lastPage = nextPage
  if (!animate) return change()
  ;(document as Document & { startViewTransition: (cb: () => void) => unknown }).startViewTransition(() => flushSync(change))
}
