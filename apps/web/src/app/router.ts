import { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'

// Pages live in the URL's hash (#/workspaces/vm-1/session-2), so links and
// reloads work wherever the app is served from.
export type Page = 'welcome' | 'workspaces' | 'windows' | 'snapshots' | 'jobs' | 'logs' | 'environment' | 'settings' | 'profile'
export type Route = { page: Page; params: string[] }

const pages: Page[] = ['welcome', 'workspaces', 'windows', 'snapshots', 'jobs', 'logs', 'environment', 'settings', 'profile']

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

// Like navigate, but in place of the current history entry: for a page that
// only sends you on, so Back doesn't land on it again.
export function redirect(page: Page, ...params: string[]) {
  history.replaceState(null, '', href(page, ...params))
  transition(update)
}

// Page changes cross-fade where the browser has view transitions.
let lastPage = route.page
function transition(change: () => void) {
  const nextPage = parse(location.hash).page
  const animate = nextPage !== lastPage && 'startViewTransition' in document && document.documentElement.dataset.motion !== 'reduced'
  lastPage = nextPage
  if (!animate) return change()
  const view = (document as Document & { startViewTransition: (cb: () => void) => { ready: Promise<void> } }).startViewTransition(() => flushSync(change))
  // A redirect mid-transition skips this one; the page still changes.
  view.ready.catch(() => {})
}
