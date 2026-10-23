import { windowsApi } from './api.ts'
import { useVnc } from './VncView.tsx'

export type { DesktopState } from './VncView.tsx'

// A Windows workspace's desktop (TightVNC, with its own password), drawn into
// `screen` while `enabled`.
export function useDesktop(workspaceId: string, enabled: boolean) {
  return useVnc(workspaceId, () => windowsApi.desktop(workspaceId), enabled)
}
