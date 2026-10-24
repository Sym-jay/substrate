import { useEffect, useState, type FormEvent } from 'react'
import type { AgentKeyInfo, AgentKeyName, GitHubStatus, QuotaStatus } from '@substrate/protocol'
import { accountApi } from './api.ts'
import '../workspaces/workspaces.css'
import './account.css'

const keyLabels: Record<AgentKeyName, { name: string; for: string; placeholder: string }> = {
  anthropic: { name: 'Anthropic', for: 'Claude Code', placeholder: 'sk-ant-…' },
  openai: { name: 'OpenAI', for: 'Codex', placeholder: 'sk-…' },
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.'

// The signed-in user's agent keys, GitHub connection and this month's use.
export function AccountPanel() {
  // GitHub's OAuth redirect comes back to /?github=connected (or failed).
  const [notice] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const result = params.get('github')
    if (!result) return ''
    params.delete('github')
    history.replaceState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`)
    return result === 'connected' ? 'GitHub is connected.' : "GitHub wasn't connected. Try again."
  })
  return (
    <section className="workspaces account" aria-labelledby="account-title">
      <div className="workspace-heading">
        <div>
          <h2 id="account-title">Account</h2>
          <p>Your keys and GitHub reach only your own workspaces.</p>
        </div>
      </div>
      {notice && <p role="status" className="workspace-hint">{notice}</p>}
      <AgentKeys />
      <GitHubConnection />
      <QuotaUse />
    </section>
  )
}

function AgentKeys() {
  const [keys, setKeys] = useState<AgentKeyInfo[] | null>(null)
  const [editing, setEditing] = useState<AgentKeyName | null>(null)
  const [error, setError] = useState('')
  const load = () => accountApi.keys().then(setKeys, (err) => setError(errorMessage(err)))
  useEffect(() => { void load() }, [])

  const save = async (name: AgentKeyName, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem('value') as HTMLInputElement
    setError('')
    try {
      await accountApi.setKey(name, input.value.trim())
      input.value = ''
      setEditing(null)
      await load()
    } catch (err) { setError(errorMessage(err)) }
  }
  const remove = async (name: AgentKeyName) => {
    setError('')
    try { await accountApi.removeKey(name); await load() } catch (err) { setError(errorMessage(err)) }
  }

  return (
    <div className="account-block">
      <h3>Agent API keys</h3>
      <p className="workspace-hint">Kept encrypted, and sent only into your workspaces, where new sessions get them as environment variables. They're never shown again.</p>
      {(Object.keys(keyLabels) as AgentKeyName[]).map((name) => {
        const key = keys?.find((k) => k.name === name)
        const label = keyLabels[name]
        return (
          <div key={name} className="account-row">
            <div className="account-row-text">
              <strong>{label.name}</strong>
              <small>For {label.for} · {key ? `ends in ${key.hint}, set ${new Date(key.updatedAt).toLocaleDateString()}` : 'not set'}</small>
            </div>
            {editing === name ? (
              <form className="account-inline-form" onSubmit={(event) => save(name, event)}>
                <input name="value" type="password" required minLength={8} autoComplete="off" spellCheck={false} placeholder={label.placeholder} aria-label={`${label.name} API key`} autoFocus />
                <button className="workspace-button" type="submit">Save</button>
                <button className="workspace-button secondary" type="button" onClick={() => setEditing(null)}>Cancel</button>
              </form>
            ) : (
              <div className="account-actions">
                <button className="workspace-button secondary" type="button" onClick={() => setEditing(name)}>{key ? 'Replace' : 'Add'}</button>
                {key && <button className="workspace-button secondary" type="button" onClick={() => remove(name)}>Remove</button>}
              </div>
            )}
          </div>
        )
      })}
      {error && <p role="alert" className="workspace-error">{error}</p>}
    </div>
  )
}

function GitHubConnection() {
  const [status, setStatus] = useState<GitHubStatus | null>(null)
  const [pasting, setPasting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = () => accountApi.github().then(setStatus, (err) => setError(errorMessage(err)))
  useEffect(() => { void load() }, [])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try { await action() } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  const connect = () => run(async () => { window.location.href = await accountApi.githubAuthorizeUrl() })
  const paste = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem('token') as HTMLInputElement
    return run(async () => {
      await accountApi.setGitHubToken(input.value.trim())
      input.value = ''
      setPasting(false)
      await load()
    })
  }
  const disconnect = () => run(async () => { await accountApi.disconnectGitHub(); await load() })

  return (
    <div className="account-block">
      <h3>GitHub</h3>
      <p className="workspace-hint">Lets a new workspace start from one of your repositories, private ones included.</p>
      {status?.connected ? (
        <div className="account-row">
          <div className="account-row-text"><strong>Connected</strong><small>as {status.login}</small></div>
          <div className="account-actions"><button className="workspace-button secondary" type="button" disabled={busy} onClick={disconnect}>Disconnect</button></div>
        </div>
      ) : status && (
        <>
          <div className="account-actions">
            {status.oauth && <button className="workspace-button" type="button" disabled={busy} onClick={connect}>Connect with GitHub</button>}
            {!pasting && <button className="workspace-button secondary" type="button" disabled={busy} onClick={() => setPasting(true)}>Use a token instead</button>}
          </div>
          {pasting && (
            <form className="account-inline-form" onSubmit={paste}>
              <input name="token" type="password" required minLength={20} autoComplete="off" spellCheck={false} placeholder="github_pat_…" aria-label="GitHub token" autoFocus />
              <button className="workspace-button" type="submit" disabled={busy}>Save</button>
              <button className="workspace-button secondary" type="button" onClick={() => setPasting(false)}>Cancel</button>
            </form>
          )}
          {pasting && <p className="workspace-hint">A fine-grained token limited to the repositories you want, with read access to their contents (and write, to push).</p>}
        </>
      )}
      {error && <p role="alert" className="workspace-error">{error}</p>}
    </div>
  )
}

// Very large limits are how "no limit" is written.
const limit = (value: number, unit = '') => value >= 1_000_000 || (unit === '' && value >= 1_000) ? 'no limit' : `${value}${unit}`

function QuotaUse() {
  const [quota, setQuota] = useState<QuotaStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { accountApi.quota().then(setQuota, (err) => setError(errorMessage(err))) }, [])
  if (error) return <div className="account-block"><h3>This month</h3><p className="workspace-error">{error}</p></div>
  if (!quota) return null
  const { limits, used } = quota
  const rows: [string, string][] = [
    ['Workspaces', `${used.vms} of ${limit(limits.maxVms)}`],
    ['Disk', `${used.totalDiskGib} GiB of ${limit(limits.maxTotalDiskGib, ' GiB')} (each up to ${limits.maxDiskGib} GiB)`],
    ['Running time', `${used.runningHours} h of ${limit(limits.maxRunningHours, ' h')}`],
    ['Sizes', limits.sizes.join(', ')],
    ['Internet access', limits.egress === 'open' ? 'Open' : 'Allowlisted sites only'],
  ]
  return (
    <div className="account-block">
      <h3>This month</h3>
      <dl className="account-quota">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </div>
  )
}
