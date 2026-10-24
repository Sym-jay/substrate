import type { GitHubRepoInfo, GitHubStatus } from '@substrate/protocol'
import { Lock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { accountApi } from './api.ts'
import { ConnectGitHubButton } from './Connectors.tsx'

const message = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong. Try again.')

// Picks one of your GitHub repositories, private ones included, once GitHub
// is connected; until then, a button that connects it, and comes back to
// Launch after. `value` is owner/name.
export function RepoPicker({ value, onChange }: { value: string; onChange: (fullName: string) => void }) {
  // undefined while it's asked; null when it couldn't be.
  const [status, setStatus] = useState<GitHubStatus | null | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [repos, setRepos] = useState<GitHubRepoInfo[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    accountApi.github().then(setStatus, () => setStatus(null))
  }, [])

  // Your repositories, searched on GitHub as you type.
  useEffect(() => {
    if (!status?.connected) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      accountApi.repos(query.trim(), controller.signal).then(setRepos, (err) => { if (!controller.signal.aborted) setError(message(err)) })
    }, query ? 250 : 0)
    return () => { clearTimeout(timer); controller.abort() }
  }, [status?.connected, query])

  if (status === undefined) return <p className="text-muted text-sm">Checking GitHub…</p>
  if (!status?.connected) {
    return (
      <div className="repo-connect">
        <p className="text-muted text-sm leading-relaxed">Connect GitHub to start from one of your repositories, private ones included.</p>
        <ConnectGitHubButton status={status} returnTo="launch" onError={setError} />
        {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
      </div>
    )
  }

  return (
    <div className="repo-picker">
      <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${status.login}’s repositories`} autoCapitalize="none" spellCheck={false} aria-label="Search repositories" />
      <div className="repo-list" role="listbox" aria-label="Repositories">
        {repos === null ? <p className="text-muted px-3 py-2 text-sm">Loading your repositories…</p>
          : repos.length === 0 ? <p className="text-muted px-3 py-2 text-sm">{query ? 'No repositories match.' : 'No repositories yet.'}</p>
          : repos.map((repo) => (
            <button key={repo.fullName} type="button" role="option" aria-selected={value === repo.fullName} className="repo-option" onClick={() => onChange(repo.fullName)}>
              <span className="flex min-w-0 items-center gap-2"><span className="truncate">{repo.fullName}</span>{repo.private && <Lock className="size-3 shrink-0 text-[var(--faint)]" aria-label="Private" />}</span>
              {repo.description && <span className="text-faint truncate text-xs">{repo.description}</span>}
            </button>
          ))}
      </div>
      {error && <p role="alert" className="text-sm text-[var(--bad)]">{error}</p>}
      <p className="text-faint text-xs">Connected as {status.login}.</p>
    </div>
  )
}
