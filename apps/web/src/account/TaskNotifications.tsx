import { useEffect, useState } from 'react'
import { Bell, ExternalLink, RefreshCw, Send } from 'lucide-react'
import type { NotificationPreferences, NotificationStatus, TelegramConnect } from '@substrate/protocol'
import { Button, Card, FieldRow, since } from '../app/ui.tsx'
import { accountApi } from './api.ts'

const message = (error: unknown) => error instanceof Error ? error.message : 'Couldn’t update notifications. Try again.'
const preferenceRows = [
  ['successes', 'Task finished', 'A task completed successfully.'],
  ['failures', 'Task failed', 'A task or its verification command failed.'],
  ['attention', 'Needs attention', 'An agent needs input, a task was interrupted, or preparation failed.'],
] as const

export function TaskNotifications() {
  const [status, setStatus] = useState<NotificationStatus | null>(null)
  const [link, setLink] = useState<TelegramConnect | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [refresh, setRefresh] = useState(0)
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
    setBusy(true); setError('')
    try {
      const next = await accountApi.connectTelegram()
      setLink(next)
      setStatus((current) => current ? { ...current, pending: { expiresAt: next.expiresAt, chatLabel: null } } : current)
      setRefresh((value) => value + 1)
    }
    catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }
  const preference = (key: keyof NotificationPreferences, checked: boolean) => {
    if (status) void change(() => accountApi.notificationPreferences({ ...status.preferences, [key]: checked }))
  }
  const last = status?.lastDelivery
  const problem = error || loadError
  const deliveredWhen = last ? since(last.at) : ''
  return <Card title="Task notifications" action={<Bell className="text-faint size-4" aria-hidden />}>
    <p className="text-muted mb-4 max-w-prose text-sm leading-relaxed">Leave a task running and get its result in Telegram. Alerts contain the task name and a link; prompts and terminal output stay here.</p>
    {problem && <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 text-sm text-[var(--bad)]"><p>{problem}</p><Button size="sm" icon={<RefreshCw />} disabled={busy} onClick={() => { setError(''); setRefresh((value) => value + 1) }}>Try again</Button></div>}
    {!status ? <p className="text-muted text-sm" role="status">{problem ? 'Notification settings are unavailable.' : 'Loading notification settings…'}</p> : <>
      <FieldRow label="Telegram" hint={<span className="text-muted">{status.connected ? `Connected to ${status.chatLabel ?? 'your private chat'}.` : 'Connect your own private chat. Group chats are not supported.'}</span>}>
        <div className="flex flex-wrap gap-2">
          {status.connected ? <>
            <Button size="sm" disabled={busy || !status.available} icon={<Send />} onClick={() => void change(accountApi.testNotification)}>Send test</Button>
            <Button size="sm" disabled={busy} onClick={() => void change(async () => { const next = await accountApi.disconnectTelegram(); setLink(null); return next })}>Disconnect</Button>
          </> : <Button size="sm" disabled={busy || !status.available} onClick={() => void connect()}>{busy ? 'Connecting…' : 'Connect Telegram'}</Button>}
        </div>
      </FieldRow>
      {!status.available && <p className="text-muted mb-4 text-sm">Telegram notifications aren’t enabled on this server yet. Your task results are still saved in the inbox.</p>}
      {status.pending && <div className="my-4 space-y-3" role="status">
        {status.pending.chatLabel ? <>
          <p className="text-sm">Telegram replied as <strong className="break-all">{status.pending.chatLabel}</strong>. Confirm that this is your chat.</p>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void change(async () => { const next = await accountApi.confirmTelegram(); setLink(null); return next })}>Confirm Telegram connection</Button>
        </> : <>
          <p className="text-sm">Open Telegram, press Start, then return here to confirm your chat. The connection link expires in 10 minutes.</p>
          {link && <a className="btn btn-secondary btn-sm" href={link.url} target="_blank" rel="noopener noreferrer">Open Telegram<ExternalLink className="size-3.5" aria-hidden /></a>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void connect()}>Create a new connection link</Button>
        </>}
      </div>}
      {link && !status.pending && !status.connected && <p className="text-muted my-3 text-sm">The connection link expired. Connect Telegram again to get a new one.</p>}
      <AlertPreference label="Receive task alerts" hint="Your preference is saved to your account and works after you close this tab."
        checked={status.preferences.enabled} disabled={busy || !status.connected || !status.available} onChange={(checked) => preference('enabled', checked)} />
      <fieldset disabled={busy || !status.connected || !status.available || !status.preferences.enabled}>
        <legend className="sr-only">Task alert types</legend>
        {preferenceRows.map(([key, label, hint]) => <AlertPreference key={key} label={label} hint={hint}
          checked={status.preferences[key]} onChange={(checked) => preference(key, checked)} />)}
      </fieldset>
      {last && <p className="text-muted mt-4 text-xs leading-relaxed" role="status">
        {last.state === 'sent' ? `Last notification delivered ${deliveredWhen}${deliveredWhen === 'just now' ? '' : ' ago'}.`
          : last.state === 'pending' || last.state === 'sending' ? last.error ? 'Telegram is temporarily unavailable. Delivery will retry automatically.' : 'Notification queued. Waiting for Telegram…'
          : last.state === 'failed' ? last.error === 'telegram_403' ? 'Telegram refused the message. Unblock the bot in Telegram, then send a test.' : 'The last notification could not be delivered. Check your Telegram connection and send a test. Your result is still in the inbox.'
          : 'The last queued notification was skipped after your preferences or connection changed.'}
      </p>}
      <p className="text-muted mt-4 text-xs leading-relaxed">Cancelled tasks don’t send alerts. Disconnecting cancels queued deliveries; a message already being sent may still arrive.</p>
    </>}
  </Card>
}

function AlertPreference({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <label className="settings-row">
    <span className="min-w-0"><span className="block font-medium">{label}</span><span className="text-muted block text-xs leading-relaxed">{hint}</span></span>
    <span className="inline-flex min-h-11 min-w-11 items-center"><input type="checkbox" className="size-4 accent-current" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /></span>
  </label>
}
