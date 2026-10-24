import type { ReactNode } from 'react'
import { DataProvider } from './app/data.tsx'
import { LauncherProvider } from './app/launcher.tsx'
import { useRoute } from './app/router.ts'
import { Shell } from './app/Shell.tsx'
import { Toasts } from './app/ui.tsx'
import { CommandPalette } from './app/CommandPalette.tsx'
import { EnvironmentPage } from './pages/EnvironmentPage.tsx'
import { InboxPage } from './pages/InboxPage.tsx'
import { JobsPage } from './pages/JobsPage.tsx'
import { LogsPage } from './pages/LogsPage.tsx'
import { SettingsPage } from './pages/SettingsPage.tsx'
import { SnapshotsPage } from './pages/SnapshotsPage.tsx'
import { WindowsPage } from './pages/WindowsPage.tsx'
import { WelcomePage } from './pages/WelcomePage.tsx'
import { WorkspacesPage } from './pages/WorkspacesPage.tsx'
import { CliAuthorize } from './cli/CliAccess.tsx'
import './workspaces/workspaces.css'

// `account` is the signed-in user's menu and `userName` their first name,
// when sign-in is on.
export function App({ account, userName }: { account?: ReactNode; userName?: string | null }) {
  const route = useRoute()
  if (route.page === 'cli') return <CliAuthorize key={route.params[0]} code={route.params[0]} account={account} />
  return (
    <Toasts>
      <DataProvider>
        <LauncherProvider>
          <Shell account={account}>
            <Page account={account} userName={userName} />
          </Shell>
          <CommandPalette />
        </LauncherProvider>
      </DataProvider>
    </Toasts>
  )
}

function Page({ account, userName }: { account?: ReactNode; userName?: string | null }) {
  const { page, params } = useRoute()
  switch (page) {
    case 'inbox': return <InboxPage />
    case 'windows': return <WindowsPage params={params} />
    case 'snapshots': return <SnapshotsPage params={params} />
    case 'jobs': return <JobsPage />
    case 'logs': return <LogsPage params={params} />
    case 'environment': return <EnvironmentPage />
    case 'settings': return <SettingsPage account={account} userName={userName} />
    case 'workspaces': return <WorkspacesPage params={params} />
    default: return <WelcomePage />
  }
}
