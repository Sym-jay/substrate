import { useEffect, useId, useState } from 'react'
import type { GitHubRepoInfo, GitHubStatus } from '@substrate/protocol'
import { accountApi } from './api.ts'

// The repository field of "Create workspace": suggests the user's own
// repositories once GitHub is connected, and still takes any owner/name or URL.
export function RepoPicker() {
  const listId = useId()
  const [github, setGitHub] = useState<GitHubStatus | null>(null)
  const [repos, setRepos] = useState<GitHubRepoInfo[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    accountApi.github()
      .then(async (status) => {
        setGitHub(status)
        if (status.connected) setRepos(await accountApi.repos('', controller.signal))
      })
      .catch((err: Error) => { if (!controller.signal.aborted) setError(err.message) })
    return () => controller.abort()
  }, [])

  return (
    <label className="workspace-field">
      GitHub repository
      <input name="repository" list={listId} placeholder="owner/repository or GitHub URL" autoCapitalize="none" autoComplete="off" spellCheck={false} required />
      <datalist id={listId}>
        {repos.map((repo) => <option key={repo.fullName} value={repo.fullName}>{repo.private ? 'Private' : 'Public'}{repo.description ? ` · ${repo.description}` : ''}</option>)}
      </datalist>
      <span className="workspace-hint">
        {error ? `Couldn't list your repositories: ${error}`
          : github?.connected ? `Cloned with your GitHub connection (${github.login}). Start typing to pick one of your repositories.`
          : 'Public repositories work as is. Connect GitHub under Account to clone private ones.'}
      </span>
    </label>
  )
}
