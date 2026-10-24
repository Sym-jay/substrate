import { ArrowRight, BookOpen } from 'lucide-react'
import type { ReactNode } from 'react'
import { AgentLogo } from '../app/AgentIcon.tsx'
import { agentCatalog } from '../app/agents.ts'
import { IsoHost } from '../app/IsoHost.tsx'
import { useData } from '../app/data.tsx'
import { useLauncher } from '../app/launcher.tsx'
import { Wordmark } from '../app/Logo.tsx'
import { href } from '../app/router.ts'
import { Button, useToast } from '../app/ui.tsx'

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
        <h1 className="welcome-title"><Wordmark className="welcome-wordmark" /></h1>
        <p className="welcome-desc">Persistent sandboxes for coding agents.</p>
        {/* The agents every workspace comes with: their logos in colour, named on hover. */}
        <div className="welcome-agents">
          <span className="welcome-agents-label" id="supported-agents">Supported agents</span>
          <ul aria-labelledby="supported-agents">
            {agentCatalog.map((a) => <li key={a.id} title={a.name}><AgentLogo agent={a.id} /><span className="sr-only">{a.name}</span></li>)}
          </ul>
        </div>
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
