import type { Agent, AgentMode, VmSizeName } from '@substrate/protocol'
import { useSyncExternalStore } from 'react'

// This browser's preferences: what Quick launch starts, and how the app looks.
export type Settings = {
  // null: a plain shell.
  agent: Agent | null
  mode: AgentMode
  size: VmSizeName
  diskGib: number
  // For new workspaces; 'default' leaves hostd's.
  autoPauseMinutes: number | null | 'default'
  theme: 'dark' | 'light' | 'system'
  motion: 'system' | 'reduced'
}

export const defaultSettings: Settings = {
  agent: 'claude',
  mode: 'ask',
  size: 'large',
  diskGib: 32,
  autoPauseMinutes: 'default',
  theme: 'dark',
  motion: 'system',
}

const KEY = 'substrate:settings'
const listeners = new Set<() => void>()

// Storage can be missing or refuse (private windows, blocked site data);
// the defaults stand in.
function read(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Settings> | null
    return { ...defaultSettings, ...saved }
  } catch {
    return defaultSettings
  }
}

let current = read()

export function getSettings() {
  return current
}

export function updateSettings(change: Partial<Settings>) {
  current = { ...current, ...change }
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* kept for this visit only */ }
  applyAppearance()
  for (const listener of listeners) listener()
}

export function resetSettings() {
  try { localStorage.removeItem(KEY) } catch { /* nothing saved */ }
  current = defaultSettings
  applyAppearance()
  for (const listener of listeners) listener()
}

export function useSettings() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, getSettings)
}

const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true

// Sets <html data-theme> (and data-motion) from the settings; run before the
// first render so there's no flash of the wrong theme.
export function applyAppearance() {
  const { theme, motion } = current
  const root = document.documentElement
  root.dataset.theme = theme === 'system' ? (systemDark() ? 'dark' : 'light') : theme
  root.dataset.motion = motion
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', root.dataset.theme === 'dark' ? '#000000' : '#e9ebef')
}

window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (current.theme === 'system') applyAppearance()
})
