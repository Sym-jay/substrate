import type { AccountSshKey, SshToken } from '@substrate/protocol'
import { useEffect, useState, type FormEvent } from 'react'
import { sshApi } from './api.ts'

const message = (error: unknown) => (error instanceof Error ? error.message : 'That didn’t work. Try again.')
const field = 'w-full rounded-lg border border-[var(--workspace-line)] bg-transparent px-3 py-2 text-sm'
const code = 'block overflow-x-auto whitespace-pre rounded-lg bg-[var(--workspace-tint)] p-3 font-mono text-xs'

// SSH into your workspaces with your own keys. Keys on your account are
// trusted by every workspace of yours; a token lets ssh-proxy.mjs reach them
// through the control box (no open ports). Then `ssh name.substrate`.
export function SshAccessPanel({ example = 'my-workspace' }: { example?: string }) {
  const [keys, setKeys] = useState<AccountSshKey[]>([])
  const [tokens, setTokens] = useState<SshToken[]>([])
  const [created, setCreated] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const origin = window.location.origin

  const load = async () => {
    try { const [k, t] = await Promise.all([sshApi.keys(), sshApi.tokens()]); setKeys(k); setTokens(t) }
    catch (e) { setError(message(e)) }
  }
  useEffect(() => { void load() }, [])

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label); setError('')
    try { await work(); await load() } catch (e) { setError(message(e)) } finally { setBusy('') }
  }
  const addKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    void run('key', async () => {
      await sshApi.addKey(String(data.get('key') ?? '').trim(), String(data.get('name') ?? '').trim())
      form.reset()
    })
  }
  const addToken = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const name = String(new FormData(form).get('name') ?? '').trim() || 'my computer'
    void run('token', async () => {
      setCreated((await sshApi.createToken(name)).token)
      form.reset()
    })
  }

  return (
    <section id="ssh-access" aria-labelledby="ssh-access-title" className="workspaces space-y-5 text-sm">
      <div>
        <h2 id="ssh-access-title" className="text-lg font-semibold">SSH access</h2>
        <p className="workspace-hint">Use your own SSH keys, from your terminal or VS Code Remote-SSH: <code>ssh {example}.substrate</code>. Nothing is opened to the internet; the connection goes through Substrate.</p>
      </div>
      {error && <p role="alert" className="workspace-error">{error}</p>}

      <div className="space-y-3">
        <h3 className="font-medium">1. Your public keys <span className="text-[var(--workspace-muted)]">({keys.length})</span></h3>
        <p className="workspace-hint !mt-0">Every workspace of yours trusts these, as user <code>dev</code>. Removing one takes effect on your running workspaces straight away.</p>
        {keys.length > 0 && <ul className="divide-y divide-[var(--workspace-line)]">
          {keys.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0"><p className="truncate font-medium">{key.name}</p><p className="truncate font-mono text-xs text-[var(--workspace-muted)]">{key.fingerprint}</p></div>
              <button type="button" className="workspace-button secondary" disabled={!!busy} onClick={() => void run('remove', () => sshApi.removeKey(key.id))}>Remove</button>
            </li>
          ))}
        </ul>}
        <form className="space-y-2" onSubmit={addKey}>
          <textarea className={field + ' min-h-20 font-mono text-xs'} name="key" required placeholder="ssh-ed25519 AAAA… you@computer (the contents of ~/.ssh/id_ed25519.pub)" aria-label="Public key" />
          <div className="flex flex-wrap gap-2">
            <input className={field + ' flex-1'} name="name" maxLength={64} placeholder="Name (optional)" aria-label="Key name" />
            <button className="workspace-button" disabled={!!busy}>{busy === 'key' ? 'Adding…' : 'Add key'}</button>
          </div>
        </form>
      </div>

      <div className="space-y-3">
        <h3 className="font-medium">2. A token for this computer</h3>
        <p className="workspace-hint !mt-0">It lets the SSH proxy reach your workspaces. It's shown once; revoke it here if the computer is lost.</p>
        {tokens.length > 0 && <ul className="divide-y divide-[var(--workspace-line)]">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0"><p className="truncate font-medium">{t.name}</p><p className="text-xs text-[var(--workspace-muted)]">{t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : 'not used yet'}</p></div>
              <button type="button" className="workspace-button secondary" disabled={!!busy} onClick={() => void run('revoke', () => sshApi.revokeToken(t.id))}>Revoke</button>
            </li>
          ))}
        </ul>}
        <form className="flex flex-wrap gap-2" onSubmit={addToken}>
          <input className={field + ' flex-1'} name="name" maxLength={64} placeholder="Where it's for, e.g. laptop" aria-label="Token name" />
          <button className="workspace-button" disabled={!!busy}>{busy === 'token' ? 'Creating…' : 'Create token'}</button>
        </form>
        {created && <div className="space-y-2" role="status">
          <p className="font-medium">Save this as <code>~/.substrate/config.json</code> now; the token isn't shown again:</p>
          <code className={code}>{JSON.stringify({ url: origin, token: created }, null, 2)}</code>
          <button type="button" className="workspace-button secondary" onClick={() => void navigator.clipboard.writeText(JSON.stringify({ url: origin, token: created }, null, 2))}>Copy</button>
        </div>}
      </div>

      <div className="space-y-2">
        <h3 className="font-medium">3. Set up SSH (once per computer)</h3>
        <p className="workspace-hint !mt-0">Fetch the proxy (it needs Node 22+ or Bun), keep your config private, and add this to <code>~/.ssh/config</code>:</p>
        <code className={code}>{`mkdir -p ~/.substrate && curl -fsSL ${origin}/ssh-proxy.mjs -o ~/.substrate/ssh-proxy.mjs
chmod 600 ~/.substrate/config.json`}</code>
        <code className={code}>{`Host *.substrate
  User dev
  ProxyCommand node ~/.substrate/ssh-proxy.mjs %h
  ServerAliveInterval 30`}</code>
        <p className="workspace-hint">Then <code>ssh {example}.substrate</code>. A paused or stopped workspace starts when you connect.</p>
      </div>
    </section>
  )
}
