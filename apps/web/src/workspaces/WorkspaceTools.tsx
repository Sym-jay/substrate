import { useEffect, useState, type FormEvent } from 'react'
import { VmName, VmSizes, type Vm, type VmSizeName, type RunCheckpoint } from '@substrate/protocol'
import { workspaceApi } from './api.ts'

const message = (error: unknown) => error instanceof Error ? error.message : 'The request failed. Try again.'
const field = 'input'

export function WorkspaceTools({ vm, onChange, onFork, onDeleted }: {
  vm: Vm; onChange: (vm: Vm) => void; onFork: (vm: Vm) => void; onDeleted: () => void
}) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [points, setPoints] = useState<RunCheckpoint[]>([])
  const [refresh, setRefresh] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [restore, setRestore] = useState<RunCheckpoint | null>(null)
  const [preview, setPreview] = useState<{ url: string; basePath: string } | null>(null)
  const [ssh, setSsh] = useState<{ url: string; expiresAt: string } | null>(null)
  const [size, setSize] = useState<VmSizeName>(() => Object.entries(VmSizes).find(([, spec]) => spec.vcpus === vm.vcpus && spec.memMib === vm.memMib)?.[0] as VmSizeName ?? 'large')
  const stopped = vm.state === 'stopped' || vm.state === 'failed'
  const ready = vm.state === 'running' || vm.state === 'paused'

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try { const points = await workspaceApi.checkpoints(vm.id); if (!cancelled) setPoints(points) }
      catch { /* The main controls still work against an older hostd. */ }
    }
    void load()
    const timer = setInterval(load, 10_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [vm.id, refresh])

  async function perform(label: string, action: () => Promise<void>) {
    if (busy) return
    setBusy(label); setError('')
    try { await action(); setRefresh((n) => n + 1) }
    catch (error) { setError(message(error)) }
    finally { setBusy('') }
  }
  const submit = (event: FormEvent<HTMLFormElement>, action: (data: FormData) => Promise<void>, label: string) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    void perform(label, () => action(data))
  }
  const downloadSsh = () => {
    if (!ssh) return
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...ssh, vmId: vm.id }, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `${vm.id}-ssh.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }

  return <section aria-label="Workspace tools" className="mt-6 space-y-5 border-t border-[var(--line)] pt-5 text-sm ">
    {vm.lastError && <p role="alert" className="workspace-error">{vm.lastError}</p>}
    {error && <p role="alert" className="workspace-error">{error}</p>}
    {busy && <p role="status" className="workspace-hint">{busy}</p>}

    <details>
      <summary className="cursor-pointer py-2 font-medium">Fork workspace</summary>
      <p className="workspace-hint">Copy the files, running processes, and terminal sessions into an independent workspace. Saving the running state can take a minute.</p>
      <form className="mt-3 flex flex-wrap gap-2" onSubmit={(event) => submit(event, async (data) => {
        const name = String(data.get('name') ?? '').trim()
        if (name && !VmName.safeParse(name).success) throw new Error('Use lowercase letters, digits and dashes for the fork name')
        onFork(await workspaceApi.fork(vm.id, { name: name || undefined }))
      }, 'Forking workspace…')}>
        <input className={field + ' flex-1'} name="name" aria-label="Fork name" maxLength={31} placeholder="New workspace name (optional)" />
        <button className="workspace-button secondary" disabled={!!busy || !ready}>Create fork</button>
      </form>
    </details>

    <details>
      <summary className="cursor-pointer py-2 font-medium">Size and disk</summary>
      {vm.state === 'running' && <>
        <p className="workspace-hint">Stop the workspace before resizing. Stopping ends its running processes; files stay on disk.</p>
        <button type="button" className="workspace-button secondary mt-3" disabled={!!busy} onClick={() => perform('Stopping workspace…', async () => onChange(await workspaceApi.stop(vm.id)))}>Stop workspace</button>
      </>}
      {vm.state === 'paused' && <p className="workspace-hint">Resume and then stop this workspace before resizing. A paused memory snapshot keeps its original CPU and memory size.</p>}
      <form className="mt-3 space-y-3" onSubmit={(event) => submit(event, async (data) => {
        onChange(await workspaceApi.resize(vm.id, { size, diskGib: Number(data.get('disk')) }))
      }, 'Resizing workspace…')}>
        <label className="workspace-field">CPU and memory<select className={field} disabled={!stopped || !!busy} value={size} onChange={(e) => setSize(e.target.value as VmSizeName)}>
          {Object.entries(VmSizes).map(([name, spec]) => <option key={name} value={name}>{spec.vcpus} vCPU / {spec.memMib / 1024} GB</option>)}
        </select></label>
        <label className="workspace-field">Disk capacity (GiB)<input key={vm.diskGib} className={field} disabled={!stopped || !!busy} name="disk" type="number" min={vm.diskGib} max={1024} step={1} defaultValue={vm.diskGib} required /></label>
        <button className="workspace-button secondary" disabled={!stopped || !!busy}>Save size</button>
      </form>
    </details>

    <details>
      <summary className="cursor-pointer py-2 font-medium">Run checkpoints <span className="text-faint">({points.length})</span></summary>
      <p className="workspace-hint">A disk checkpoint is taken before every agent session. Stop the workspace before restoring one.</p>
      {points.length === 0 ? <p className="workspace-hint">No run checkpoints yet.</p> : <ul className="mt-3 divide-y divide-[var(--line)]">
        {[...points].reverse().map((point) => <li key={point.id} className="flex items-center justify-between gap-3 py-3">
          <div><p>{point.label}</p><p className="text-xs text-faint">{new Date(point.createdAt).toLocaleString()}</p></div>
          <button type="button" className="workspace-button secondary" disabled={!!busy || !stopped} onClick={() => setRestore(point)}>Restore</button>
        </li>)}
      </ul>}
      {restore && <div className="mt-3 space-y-3" role="alert">
        <p>Restore “{restore.label}”? Disk changes and newer checkpoints will be removed.</p>
        <div className="flex gap-2"><button type="button" className="workspace-button" disabled={!!busy} onClick={() => perform('Restoring disk checkpoint…', async () => { onChange(await workspaceApi.rollback(vm.id, restore.id)); setRestore(null) })}>Restore checkpoint</button>
          <button type="button" className="workspace-button secondary" onClick={() => setRestore(null)}>Cancel</button></div>
      </div>}
    </details>

    <details>
      <summary className="cursor-pointer py-2 font-medium">App preview</summary>
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => submit(event, async (data) => setPreview(await workspaceApi.preview(vm.id, Number(data.get('port')))), 'Creating preview link…')}>
        <label className="workspace-field flex-1">App port<input className={field} name="port" type="number" min={1024} max={65535} defaultValue={3000} required /></label>
        <button className="workspace-button secondary" disabled={!!busy}>Create preview link</button>
      </form>
      {preview && <div className="mt-3 space-y-2">
        <a className="inline-block py-2 font-medium underline underline-offset-4" href={preview.url} target="_blank" rel="noreferrer">Open app preview</a>
        <p className="workspace-hint">Run the app on 0.0.0.0 and configure this base path for assets and development WebSockets:</p>
        <code className="mono block break-all border border-[var(--line)] p-3 text-xs">{preview.basePath}</code>
        <p className="workspace-hint">For Vite: <code>npm run dev -- --host 0.0.0.0 --base {preview.basePath}</code></p>
      </div>}
    </details>

    <details>
      <summary className="cursor-pointer py-2 font-medium">SSH and VS Code</summary>
      <p className="workspace-hint">With your key under <a className="underline underline-offset-2" href="#ssh-access">SSH access</a>, connect from your terminal or VS Code Remote-SSH:</p>
      <code className="mt-2 block rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">ssh {vm.name}.substrate</code>
      <p className="workspace-hint">Or, for this workspace only, add a public key here and download a short-lived connection file. Your private key stays on your device.</p>
      <form className="mt-3 space-y-3" onSubmit={(event) => submit(event, async (data) => {
        await workspaceApi.authorizeSsh(vm.id, String(data.get('key') ?? '').trim())
        setSsh(await workspaceApi.sshAccess(vm.id))
      }, 'Preparing SSH access…')}>
        <label className="workspace-field">Public key<textarea className={field + ' min-h-24 font-mono text-xs'} name="key" placeholder="ssh-ed25519 AAAA…" required /></label>
        <button className="workspace-button secondary" disabled={!!busy}>Prepare connection</button>
      </form>
      {ssh && <div className="mt-3 space-y-3">
        <button type="button" className="workspace-button secondary" onClick={downloadSsh}>Download SSH connection</button>
        <p className="workspace-hint">Connection access expires {new Date(ssh.expiresAt).toLocaleTimeString()}. Replace the two local paths below, then use this command or put its ProxyCommand in your VS Code SSH config.</p>
        <code className="mono block overflow-x-auto border border-[var(--line)] p-3 text-xs">{`ssh -o 'ProxyCommand=bun /path/to/substrate/scripts/ssh-proxy.ts /path/to/${vm.id}-ssh.json' dev@${vm.id}`}</code>
      </div>}
    </details>

    <details>
      <summary className="cursor-pointer py-2 font-medium text-[var(--bad)]">Delete workspace</summary>
      {!confirmDelete ? <button type="button" className="workspace-button secondary mt-3" disabled={!!busy} onClick={() => setConfirmDelete(true)}>Delete {vm.name}</button>
        : <div className="mt-3 space-y-3" role="alert"><p>Delete “{vm.name}”? Its disk, sessions, and checkpoints will be permanently removed.</p>
          <div className="flex flex-wrap gap-2"><button type="button" className="workspace-button" disabled={!!busy} onClick={() => perform('Deleting workspace…', async () => { await workspaceApi.remove(vm.id); onDeleted() })}>Delete permanently</button>
            <button type="button" className="workspace-button secondary" onClick={() => setConfirmDelete(false)}>Cancel</button></div></div>}
    </details>
  </section>
}
