import { LogOut, Settings, SlidersHorizontal, UserRound } from 'lucide-react'
import type { Profile } from '../pages/ProfilePage.tsx'
import { useData } from './data.tsx'
import { DitherFrame } from './DitherFrame.tsx'
import { DitherMeter } from './DitherMeter.tsx'
import { navigate, useRoute } from './router.ts'
import { Menu, MenuItem } from './ui.tsx'

const hours = (n: number) => `${Math.round(n * 10) / 10}`

// Top right on every page: you, framed by this month's credits (the blue dots
// are what's left), and a menu for your account.
export function AccountCorner({ profile }: { profile?: Profile }) {
  const { quota } = useData()
  const { page } = useRoute()
  const total = quota?.limits.maxRunningHours ?? 0
  const left = quota ? Math.max(0, total - quota.used.runningHours) : 0
  // Null when this server has no credits to show.
  const share = quota && total > 0 ? left / total : null
  const credits = share === null ? null : `${hours(left)} of ${hours(total)} hours left this month`

  return (
    <Menu align="end" button={({ open, toggle }) => (
      <button type="button" className="corner-button account-button" aria-haspopup="menu" aria-expanded={open} aria-label={credits ? `Account: ${credits}` : 'Account'} title={credits ?? 'Account'} onClick={toggle}>
        <DitherFrame share={share} />
        {profile?.imageUrl ? <img src={profile.imageUrl} alt="" className="account-avatar" /> : <span className="account-avatar"><UserRound /></span>}
      </button>
    )}>
      {(close) => (
        <>
          <div className="account-menu-head">
            <p className="truncate text-sm text-[var(--ink)]">{profile ? profile.name ?? 'Signed in' : 'Local development'}</p>
            {profile?.email && <p className="text-faint truncate text-xs">{profile.email}</p>}
            {credits && share !== null && (
              <div className="mt-2.5 flex flex-col gap-1.5">
                <DitherMeter share={share} label="Hours left this month" now={left} max={total} />
                <p className="text-muted text-xs">{credits}</p>
              </div>
            )}
          </div>
          <MenuItem icon={<UserRound />} current={page === 'profile'} onClick={() => { close(); navigate('profile') }}>Profile</MenuItem>
          {profile && <MenuItem icon={<SlidersHorizontal />} onClick={() => { close(); profile.manage() }}>Manage account</MenuItem>}
          <MenuItem icon={<Settings />} current={page === 'settings'} onClick={() => { close(); navigate('settings') }}>Settings</MenuItem>
          {profile && <MenuItem icon={<LogOut />} danger onClick={() => { close(); profile.signOut() }}>Sign out</MenuItem>}
        </>
      )}
    </Menu>
  )
}
