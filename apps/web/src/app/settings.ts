import { DEFAULT_VM_SIZE, VmSizes, type Agent, type AgentMode, type VmSizeName } from '@substrate/protocol'
import { useSyncExternalStore } from 'react'

// This browser's preferences: what Quick launch starts, and how the app looks.
export type Settings = {
  // null: a plain shell.
  agent: Agent | null
  mode: AgentMode
  vcpus: number
  memMib: number
  diskGib: number
  // For new workspaces; 'default' leaves hostd's.
  autoPauseMinutes: number | null | 'default'
  // A GitHub repository new workspaces clone; empty for none.
  repository: string
  motion: 'system' | 'reduced'
  sidebar: 'expanded' | 'collapsed'
}

export const defaultSettings: Settings = {
  agent: 'claude',
  mode: 'ask',
  ...VmSizes[DEFAULT_VM_SIZE],
  diskGib: 32,
  autoPauseMinutes: 'default',
  repository: '',
  motion: 'system',
  sidebar: 'expanded',
}

const KEY = 'substrate:settings'
const listeners = new Set<() => void>()

// Storage can be missing or refuse (private windows, blocked site data);
// the defaults stand in.
function read(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as (Partial<Settings> & { size?: VmSizeName }) | null
    // Saved before custom sizes: a preset's name.
    const preset = saved?.size && saved.vcpus === undefined ? VmSizes[saved.size] : undefined
    return { ...defaultSettings, ...preset, ...saved }
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

// Sets <html data-motion> from the settings; run before the first render so
// nothing animates that shouldn't. (Light only for now: no theme to set.)
export function applyAppearance() {
  document.documentElement.dataset.motion = current.motion
}
