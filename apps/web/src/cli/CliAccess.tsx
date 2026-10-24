import { useEffect, useState, type ReactNode } from 'react'
import { CliDeviceInfo, CliSession } from '@substrate/protocol'
import { Button, Card } from '../app/ui.tsx'
import { navigate } from '../app/router.ts'
import { request, WorkspaceApiError } from '../workspaces/api.ts'

const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
const message = (error: unknown) => error instanceof Error ? error.message : 'Could not reach the server. Try again.'

// A login link only previews a request; granting access is an explicit action.
export function CliAuthorize({ code, account }: { code?: string; account?: ReactNode }) {
  const [info, setInfo] = useState<CliDeviceInfo | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true)
  const [retryable, setRetryable] = useState(false), [refresh, setRefresh] = useState(0)
  const load = async () => CliDeviceInfo.parse(await request(`/api/cli/device/${encodeURIComponent(code ?? '')}`))
  useEffect(() => {
    let live = true
    setLoading(true); setError(''); setRetryable(false); setInfo(null)
    void load().then((next) => { if (live) setInfo(next) }).catch((error) => {
      if (!live) return
      const retry = !(error instanceof WorkspaceApiError) || error.status >= 500 || error.status === 429
      setRetryable(retry)
      setError(retry ? 'Couldn’t load this CLI request. Check your connection, then try again.' : message(error))
    }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [code, refresh])
  const decide = async (approve: boolean) => {
    setBusy(true); setError('')
    try { await request(`/api/cli/device/${encodeURIComponent(code ?? '')}/${approve ? 'approve' : 'deny'}`, post); setInfo(await load()) }
    catch (error) { setError(message(error)); await load().then(setInfo).catch(() => {}) }
    finally { setBusy(false) }
  }
  const answered = info && info.state !== 'pending'
  return <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-6 px-5 py-10">
    <header className="flex items-center justify-between gap-4"><a className="flex items-center gap-3 font-semibold" href="#/welcome"><img src="/favicon.svg" alt="" className="size-9" />Substrate</a>{account}</header>
    <Card>
      <h1 className="text-xl font-semibold tracking-tight">{answered ? info.state === 'denied' ? 'CLI access declined' : 'CLI access approved' : 'Authorize your CLI'}</h1>
      {loading && <p role="status" className="text-muted mt-4 text-sm">Loading the login request…</p>}
      {error && <p role="alert" className="mt-4 text-sm">{error}</p>}
      {error && retryable && !info && <Button className="mt-4" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>Try again</Button>}
      {info && <>
        <p className="text-muted mt-4 text-sm leading-relaxed">{answered ? info.state === 'denied' ? 'No CLI credential was issued. You can close this tab.' : 'Return to your terminal to finish signing in. You can close this tab.' : 'Only approve if you just ran substrate login. Check that this code matches the one in your terminal.'}</p>
        <p className="my-6 break-all text-center font-mono text-3xl font-semibold tracking-wider" aria-label={`Login code ${info.userCode}`}>{info.userCode}</p>
        <dl className="space-y-3 text-sm"><div><dt className="text-muted">Device name (provided by the CLI)</dt><dd className="mt-1 break-words font-medium">{info.name}</dd></div></dl>
        {!answered && <>
          <p className="text-muted mt-5 text-sm leading-relaxed">This grants access to your Substrate account, including creating and deleting workspaces, running commands, and reading task results. Access lasts 30 days. Revoke it at any time in Settings.</p>
          <p className="text-muted mt-3 text-xs">This request expires {new Date(info.expiresAt).toLocaleTimeString()}.</p>
          <div className="mt-6 flex flex-wrap gap-3"><Button variant="primary" disabled={busy} onClick={() => void decide(true)}>{busy ? 'Saving…' : 'Approve CLI access'}</Button><Button disabled={busy} onClick={() => void decide(false)}>Decline</Button></div>
        </>}
      </>}
      <Button className="mt-5" variant="ghost" onClick={() => navigate('settings')}>Manage CLI sessions</Button>
    </Card>
  </main>
}

export function CliSessions() {
  const [sessions, setSessions] = useState<CliSession[]>([]), [loading, setLoading] = useState(true)
  const [error, setError] = useState(''), [busy, setBusy] = useState<string | null>(null)
  const load = async () => {
    setError('')
    try { setSessions(CliSession.array().parse(await request('/api/cli/sessions'))) }
    catch (error) { setError(error instanceof WorkspaceApiError && error.status === 404 ? 'CLI access is not available on this server yet.' : message(error)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const revoke = async (id: string) => {
    setBusy(id); setError('')
    try { await request(`/api/cli/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); await load() }
    catch (error) { setError(message(error)) }
    finally { setBusy(null) }
  }
  return <Card title="CLI access">
    <p className="text-muted break-words text-sm leading-relaxed">Run <code>substrate login --url {window.location.origin}</code> on your computer, then approve its code in this browser. Sessions can manage your account until revoked or expired.</p>
    {loading ? <p role="status" className="text-muted mt-4 text-sm">Loading CLI sessions…</p> : <>
      {!error && !sessions.length && <p className="text-muted mt-4 text-sm">No active CLI sessions.</p>}
      <ul className="mt-4">{sessions.map((session) => <li className="list-row" key={session.id}><div className="min-w-0 flex-1"><p className="break-words font-medium">{session.name}</p><p className="text-muted mt-1 text-xs">Expires {new Date(session.expiresAt).toLocaleDateString()} · {session.lastUsedAt ? `last used ${new Date(session.lastUsedAt).toLocaleString()}` : 'not used yet'}</p></div><Button size="sm" variant="danger" disabled={busy !== null} onClick={() => void revoke(session.id)}>{busy === session.id ? 'Revoking…' : 'Revoke'}</Button></li>)}</ul>
    </>}
    {error && <p role="alert" className="mt-4 text-sm">{error}</p>}
    {!loading && <Button className="mt-3" size="sm" onClick={() => void load()}>Refresh sessions</Button>}
  </Card>
}
