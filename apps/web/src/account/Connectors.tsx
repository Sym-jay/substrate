import type { GitHubStatus } from '@substrate/protocol'
import { useEffect, useState } from 'react'
import { Button } from '../app/ui.tsx'
import { accountApi } from './api.ts'
import { markGitHubReturn, type GitHubReturn } from './githubReturn.ts'

const message = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong. Try again.')

// GitHub's mark (Simple Icons, CC0).
export function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

// Connects GitHub: off to GitHub (OAuth), then back to `returnTo`. Shown
// whether or not this server can do it yet; if it can't, pressing it says so.
export function ConnectGitHubButton({ status, returnTo, size, label = 'Connect GitHub', onError }: {
  // null when it couldn't be asked.
  status: GitHubStatus | null
  returnTo: GitHubReturn
  size?: 'sm' | 'md'
  label?: string
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const connect = async () => {
    onError('')
    if (!status?.oauth) {
      onError(status ? 'Connecting GitHub isn’t set up on this server yet.' : 'Couldn’t reach your account. Sign in, or try again.')
      return
    }
    setBusy(true)
    try {
      const url = await accountApi.githubAuthorizeUrl()
      markGitHubReturn(returnTo)
      window.location.href = url
    } catch (err) {
      onError(message(err))
      setBusy(false)
    }
  }
  return <Button size={size} className="btn-github" icon={<GitHubMark />} disabled={busy} onClick={() => void connect()}>{busy ? 'Opening GitHub…' : label}</Button>
}

// Apps your workspaces can reach. GitHub for now: connecting it goes through
// GitHub (OAuth), and lets a new workspace start from your repositories.
export function Connectors() {
  // undefined while it's asked; null when it couldn't be.
  const [github, setGitHub] = useState<GitHubStatus | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Not knowing is no error here: Connect says what's wrong if it's pressed.
  const load = () => accountApi.github().then(setGitHub, () => setGitHub(null))
  useEffect(() => { void load() }, [])

  const disconnect = async () => {
    setBusy(true)
    setError('')
    try { await accountApi.disconnectGitHub(); await load() } catch (err) { setError(message(err)) } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="connector">
        <span className="connector-icon"><GitHubMark /></span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-medium">
            GitHub
            {github?.connected && <span className="connector-state"><span className="dot is-ok" />Connected</span>}
          </p>
          <p className="text-faint text-xs leading-relaxed">
            {github?.connected ? `As ${github.login}. New workspaces can start from your repositories, private ones included.` : 'Start new workspaces from your repositories, private ones included.'}
          </p>
          {error && <p role="alert" className="mt-1 text-xs text-[var(--bad)]">{error}</p>}
        </div>
        <div className="shrink-0">
          {github === undefined ? <span className="text-faint text-xs">Checking…</span>
            : github?.connected ? <Button size="sm" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button>
            : <ConnectGitHubButton size="sm" status={github} returnTo="settings" label="Connect" onError={setError} />}
        </div>
      </div>
      <p className="text-faint text-xs">More connectors are on the way.</p>
    </div>
  )
}
