import { windowsApi } from './api.ts'
import { VncView } from './VncView.tsx'

// A Windows workspace's desktop (TightVNC, with its own password).
export function DesktopView({ workspaceId }: { workspaceId: string }) {
  return <VncView label="Windows desktop" connect={() => windowsApi.desktop(workspaceId)} />
}
