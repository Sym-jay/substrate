import type { ReactNode } from 'react'
import { DataProvider } from './app/data.tsx'
import { LauncherProvider } from './app/launcher.tsx'
import { useRoute } from './app/router.ts'
import { Shell } from './app/Shell.tsx'
import { Toasts } from './app/ui.tsx'
import { ComputePage } from './pages/ComputePage.tsx'
import { HomePage } from './pages/HomePage.tsx'
import { JobsPage } from './pages/JobsPage.tsx'
import { LogsPage } from './pages/LogsPage.tsx'
import { SettingsPage } from './pages/SettingsPage.tsx'
import { WindowsPage } from './pages/WindowsPage.tsx'
import { WorkspacesPage } from './pages/WorkspacesPage.tsx'
import './workspaces/workspaces.css'

// `account` is the signed-in user's menu and `userName` their first name,
// when sign-in is on.
export function App({ account, userName }: { account?: ReactNode; userName?: string | null }) {
  return (
    <Toasts>
      <DataProvider>
        <LauncherProvider>
          <Shell account={account}>
            <Page account={account} userName={userName} />
          </Shell>
        </LauncherProvider>
      </DataProvider>
    </Toasts>
  )
}

function Page({ account, userName }: { account?: ReactNode; userName?: string | null }) {
  const { page, params } = useRoute()
  switch (page) {
    case 'workspaces': return <WorkspacesPage params={params} />
    case 'windows': return <WindowsPage params={params} />
    case 'jobs': return <JobsPage />
    case 'compute': return <ComputePage />
    case 'logs': return <LogsPage params={params} />
    case 'settings': return <SettingsPage account={account} userName={userName} />
    default: return <HomePage userName={userName} />
  }
}
