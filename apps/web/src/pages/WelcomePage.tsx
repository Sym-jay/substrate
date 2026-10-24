import { ArrowRight, BookOpen } from 'lucide-react'
import type { ReactNode } from 'react'
import { IsoHost } from '../app/IsoHost.tsx'
import { useData } from '../app/data.tsx'
import { useLauncher } from '../app/launcher.tsx'
import { href } from '../app/router.ts'
import { Button, Reveal, useToast } from '../app/ui.tsx'

// Where you land: what Substrate is, the two ways in, and a host with its
// microVMs beside them.
export function WelcomePage() {
  const { vms, windows, vmsUnavailable } = useData()
  const { launching, configure } = useLauncher()
  const total = (vms?.length ?? 0) + (windows?.length ?? 0)
  const running = (vms ?? []).filter((vm) => vm.state === 'running').length + (windows ?? []).filter((w) => w.state === 'running').length

  return (
    <WelcomeHero
      launch={
        <Button variant="primary" size="lg" live disabled={launching || !!vmsUnavailable} onClick={() => configure()}>
          {launching ? 'Launching…' : 'Launch instance'}
        </Button>
      }
      more={total > 0 && (
        <a href={href('workspaces')} className="welcome-more">
          {total} workspace{total === 1 ? '' : 's'}{running ? ` · ${running} running` : ''}<ArrowRight />
        </a>
      )}
    />
  )
}

// The welcome layout. Signed-out visitors see it too (ClerkApp.tsx), where
// launching starts with signing in.
export function WelcomeHero({ launch, more }: { launch: ReactNode; more?: ReactNode }) {
  const toast = useToast()
  return (
    <div className="welcome">
      <div className="welcome-text">
        <h1 className="welcome-title"><Reveal text="Substrate" /></h1>
        <p className="welcome-desc">Persistent sandboxes for coding agents.</p>
        <div className="welcome-actions">
          {launch}
          {/* No docs yet: the button stays, and says so. */}
          <Button size="lg" icon={<BookOpen />} onClick={() => toast('Docs are on the way.')}>Docs</Button>
        </div>
        {more}
      </div>
      <IsoHost className="welcome-art" />
    </div>
  )
}
