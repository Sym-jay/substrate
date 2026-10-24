import { useEffect, useId, useState } from 'react'
import { ChevronDown, ExternalLink, RefreshCw, Send } from 'lucide-react'
import type { NotificationPreferences, NotificationStatus, TelegramConnect } from '@substrate/protocol'
import { Button, since } from '../app/ui.tsx'
import { accountApi } from './api.ts'

const message = (error: unknown) => error instanceof Error ? error.message : 'Couldn’t update Telegram alerts. Try again.'
const preferenceRows = [
  ['successes', 'Task finished', 'A task completed successfully.'],
  ['failures', 'Task failed', 'A task or its verification command failed.'],
  ['attention', 'Needs attention', 'An agent needs input, a task was interrupted, or preparation failed.'],
] as const

// Telegram's mark (Simple Icons, CC0): a white plane on its own blue.
export function TelegramMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="11" fill="#fff" />
      <path fill="#26a5e4" d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  )
}

// "finishes, fails or needs you", from the alerts that are on; null for none.
function alertSummary(preferences: NotificationPreferences) {
  const parts = [preferences.successes && 'finishes', preferences.failures && 'fails', preferences.attention && 'needs you'].filter((part): part is string => !!part)
  if (!preferences.enabled || !parts.length) return null
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}`
}

// Telegram, among the app connectors: task alerts in your own private chat.
// Connecting goes through the bot (press Start, then confirm the chat here);
// once connected, the row opens into which alerts to send.
export function TelegramConnector() {
  const [status, setStatus] = useState<NotificationStatus | null>(null)
  const [link, setLink] = useState<TelegramConnect | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const panelId = useId()
  const waiting = !!status?.pending || status?.lastDelivery?.state === 'pending' || status?.lastDelivery?.state === 'sending'
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try { const next = await accountApi.notifications(controller.signal); if (!controller.signal.aborted) { setStatus(next); setLoadError('') } }
      catch (error) { if (!controller.signal.aborted) setLoadError(message(error)) }
      finally { pending = false }
    }
    void load()
    const timer = waiting ? setInterval(load, 3000) : undefined
    return () => { controller.abort(); clearInterval(timer) }
  }, [refresh, waiting])
  const change = async (action: () => Promise<NotificationStatus>) => {
    setBusy(true); setError('')
    try { setStatus(await action()); setRefresh((value) => value + 1) }
    catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }
  const connect = async () => {
    setError('')
    if (status && !status.available) { setError('Telegram alerts aren’t set up on this server yet.'); return }
    setBusy(true)
    try {
      const next = await accountApi.connectTelegram()
      setLink(next)
      setStatus((current) => current ? { ...current, pending: { expiresAt: next.expiresAt, chatLabel: null } } : current)
      setRefresh((value) => value + 1)
    }
    catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }
  const disconnect = () => change(async () => { const next = await accountApi.disconnectTelegram(); setLink(null); setOpen(false); return next })
  const preference = (key: keyof NotificationPreferences, checked: boolean) => {
    if (status) void change(() => accountApi.notificationPreferences({ ...status.preferences, [key]: checked }))
  }

  const connected = !!status?.connected
  const chat = status?.chatLabel ?? 'your private chat'
  const summary = status ? alertSummary(status.preferences) : null
  const expired = !!link && !!status && !status.pending && !status.connected
  const problem = error || loadError
  const last = status?.lastDelivery
  const deliveredWhen = last ? since(last.at) : ''
  const toggle = () => setOpen((value) => !value)

  return (
    <div className="connector-card">
      <div className={`connector ${connected ? 'is-expandable' : ''}`} onClick={connected ? toggle : undefined}>
        <span className="connector-icon"><TelegramMark /></span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-medium">
            Telegram
            {connected ? <span className="connector-state"><span className="dot is-ok" />Connected</span>
              : status?.pending && <span className="connector-state"><span className="dot is-busy" />Connecting</span>}
          </p>
          <p className="text-faint text-xs leading-relaxed">
            {connected ? (summary ? <>Messages <span className="break-all">{chat}</span> when a task {summary}.</> : <>Connected to <span className="break-all">{chat}</span>. Alerts are off.</>)
              : expired ? 'That link expired. Connect again for a new one.'
              : 'Get a message when a task finishes, fails or needs you. Only its name and a link are sent; prompts and output stay here.'}
          </p>
          {problem && <p role="alert" className="mt-1 text-xs text-[var(--bad)]">{problem}</p>}
        </div>
        <div className="connector-action shrink-0">
          {!status ? (loadError ? <Button size="sm" icon={<RefreshCw />} onClick={() => setRefresh((value) => value + 1)}>Try again</Button> : <span className="text-faint text-xs">Checking…</span>)
            : connected ? <button type="button" className="btn btn-ghost btn-sm" aria-label="Telegram settings" aria-expanded={open} aria-controls={panelId} onClick={(event) => { event.stopPropagation(); toggle() }}>
                Settings<ChevronDown className="connector-chevron" aria-hidden />
              </button>
            : !status.pending && <Button size="sm" icon={<TelegramMark />} aria-label="Connect Telegram" disabled={busy} onClick={() => void connect()}>{busy ? 'Connecting…' : 'Connect'}</Button>}
        </div>
      </div>

      {status?.pending && !connected && <div className="connector-panel" role="status">
        {status.pending.chatLabel ? <>
          <p className="text-sm">Telegram replied as <strong className="break-all">{status.pending.chatLabel}</strong>. If that’s you, confirm to get alerts there.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void change(async () => { const next = await accountApi.confirmTelegram(); setLink(null); setOpen(true); return next })}>Confirm</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void connect()}>Use a new link</Button>
          </div>
        </> : <>
          <ol className="connector-steps text-sm">
            <li>Open Telegram and press <strong>Start</strong> in the bot’s chat.</li>
            <li>Come back here and confirm it’s your chat.</li>
          </ol>
          <p className="text-faint mt-2 text-xs">The link works for 10 minutes. Private chats only; groups can’t be connected.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {link && <a className="btn btn-secondary btn-sm" href={link.url} target="_blank" rel="noopener noreferrer"><TelegramMark />Open Telegram<ExternalLink aria-hidden /></a>}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void connect()}>{link ? 'New link' : 'Get a link'}</Button>
          </div>
        </>}
      </div>}

      {status && connected && open && <div className="connector-panel" id={panelId}>
        {!status.available && <p className="text-muted pt-3 text-sm">Telegram isn’t switched on for this server right now. Task results still land in your inbox.</p>}
        <AlertPreference label="Receive task alerts" hint="Saved to your account, so alerts arrive with this tab closed."
          checked={status.preferences.enabled} disabled={busy || !status.available} onChange={(checked) => preference('enabled', checked)} />
        <fieldset disabled={busy || !status.available || !status.preferences.enabled}>
          <legend className="sr-only">Task alert types</legend>
          {preferenceRows.map(([key, label, hint]) => <AlertPreference key={key} label={label} hint={hint}
            checked={status.preferences[key]} onChange={(checked) => preference(key, checked)} />)}
        </fieldset>
        {last && <p className="text-muted mt-3 text-xs leading-relaxed" role="status">
          {last.state === 'sent' ? `Last alert delivered ${deliveredWhen}${deliveredWhen === 'just now' ? '' : ' ago'}.`
            : last.state === 'pending' || last.state === 'sending' ? last.error ? 'Telegram is temporarily unavailable. Delivery will retry automatically.' : 'Alert queued. Waiting for Telegram…'
            : last.state === 'failed' ? last.error === 'telegram_403' ? 'Telegram refused the message. Unblock the bot in Telegram, then send a test.' : 'The last alert couldn’t be delivered. Check the connection and send a test. The result is still in your inbox.'
            : 'The last queued alert was skipped after your preferences or connection changed.'}
        </p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || !status.available} icon={<Send />} onClick={() => void change(accountApi.testNotification)}>Send test</Button>
          <Button size="sm" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button>
        </div>
        <p className="text-faint mt-3 text-xs leading-relaxed">Cancelled tasks don’t send alerts. Disconnecting cancels queued alerts; one already on its way may still arrive.</p>
      </div>}
    </div>
  )
}

function AlertPreference({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <label className="settings-row">
    <span className="min-w-0"><span className="block font-medium">{label}</span><span className="text-muted block text-xs leading-relaxed">{hint}</span></span>
    <span className="inline-flex min-h-11 min-w-11 items-center"><input type="checkbox" className="size-4 accent-current" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /></span>
  </label>
}
