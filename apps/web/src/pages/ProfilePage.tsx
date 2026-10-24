import { UserRound } from 'lucide-react'
import type { UsageReport } from '@substrate/protocol'
import { useEffect, useState, type CSSProperties } from 'react'
import { useData } from '../app/data.tsx'
import { gibLabel, windowsSizeOf } from '../app/launch.ts'
import { Button, Card, PageHeader } from '../app/ui.tsx'
import { accountApi } from '../account/api.ts'
import { DitherMeter } from '../app/DitherMeter.tsx'

// Who's signed in, from the sign-in provider (ClerkApp.tsx). Absent when
// sign-in is off.
export type Profile = { name: string | null; email: string | null; imageUrl: string | null; since: Date | null; manage: () => void; signOut: () => void }

const hours = (n: number) => `${Math.round(n * 10) / 10}`
const nextMonth = () => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
}

// The account: who you are, your credits (running hours left this month, out
// of your quota), and what you're using.
export function ProfilePage({ profile }: { profile?: Profile }) {
  const { vms, windows, quota } = useData()
  const [usage, setUsage] = useState<UsageReport | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    accountApi.usage(controller.signal).then(setUsage, () => {})
    return () => controller.abort()
  }, [])

  const linux = vms ?? []
  const win = windows ?? []
  const up = linux.filter((vm) => vm.state === 'running')
  const winUp = win.filter((w) => w.state === 'running')
  const vcpus = up.reduce((n, vm) => n + vm.vcpus, 0) + winUp.reduce((n, w) => n + windowsSizeOf(w).vcpus, 0)
  const memGib = up.reduce((n, vm) => n + vm.memMib, 0) / 1024 + winUp.reduce((n, w) => n + windowsSizeOf(w).memGib, 0)
  const diskGib = linux.reduce((n, vm) => n + vm.diskGib, 0)

  const total = quota?.limits.maxRunningHours ?? 0
  const left = quota ? Math.max(0, total - quota.used.runningHours) : 0

  return (
    <div className="page-body">
      <PageHeader title="Profile" subtitle="Your account, credits and what you’re using" />

      <Card className="rise">
        <div className="profile-head">
          {profile?.imageUrl ? <img src={profile.imageUrl} alt="" className="profile-avatar" /> : <span className="profile-avatar"><UserRound /></span>}
          <div className="min-w-0 flex-1">
            <p className="profile-name truncate">{profile ? profile.name ?? 'Signed in' : 'Local development'}</p>
            <p className="text-muted truncate text-sm">{profile ? profile.email : 'Sign-in is off on this server.'}</p>
            {profile?.since && <p className="text-faint mt-1 text-xs">Member since {profile.since.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</p>}
          </div>
          {profile && <Button onClick={profile.manage}>Manage account</Button>}
        </div>
      </Card>

      <Card title="Credits" className="rise" style={{ '--i': 1 } as CSSProperties}>
        {quota ? (
          <div className="profile-credits">
            <p className="flex flex-wrap items-baseline gap-x-3">
              <span className="profile-big">{hours(left)}</span>
              <span className="text-muted text-sm">of {hours(total)} hours left this month</span>
            </p>
            <DitherMeter share={total ? left / total : 0} label="Hours left this month" now={left} max={total} rows={6} />
            <p className="text-faint text-xs">
              Running time across all your workspaces. Renews {nextMonth().toLocaleDateString(undefined, { day: 'numeric', month: 'long', timeZone: 'UTC' })}.
            </p>
          </div>
        ) : (
          <p className="text-muted text-sm">{quota === undefined ? 'Loading…' : 'Credits aren’t set up on this server yet.'}</p>
        )}
      </Card>

      <Card title="Usage" className="rise" style={{ '--i': 2 } as CSSProperties}>
        <div className="stat-grid">
          <Stat label="Workspaces" value={`${linux.length + win.length}`} of={quota ? `up to ${quota.limits.maxVms} Linux` : undefined} />
          <Stat label="Running now" value={`${up.length + winUp.length}`} />
          <Stat label="In use now" value={`${vcpus} vCPU`} of={gibLabel(memGib)} />
          <Stat label="Disk" value={gibLabel(diskGib)} of={quota ? `of ${gibLabel(quota.limits.maxTotalDiskGib)}` : undefined} />
          {usage && <Stat label="vCPU-hours" value={hours(usage.totals.vcpuHours)} of="this month" />}
          {usage && <Stat label="GB-hours" value={hours(usage.totals.gibHours)} of="this month" />}
        </div>
      </Card>
    </div>
  )
}

function Stat({ label, value, of }: { label: string; value: string; of?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {of && <span className="text-faint text-xs">{of}</span>}
    </div>
  )
}
