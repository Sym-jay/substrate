import { ArrowRight, BookOpen, Check, Copy } from 'lucide-react'
import { useState, type ReactNode } from 'react'
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
        <p className="welcome-desc">Give your agent a computer it’s allowed to wreck.</p>
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
        <CliInstall />
      </div>
      <IsoHost className="welcome-art" />
    </div>
  )
}

// The CLI, by package manager. None of these packages is published yet, so the
// block says so; the second line is a real command once it's installed.
const installs = [
  { id: 'npm', label: 'npm', command: 'npm install -g substrate-cli' },
  { id: 'brew', label: 'Homebrew', command: 'brew install harryfrzz/tap/substrate' },
  { id: 'pip', label: 'pip', command: 'pip install substrate-cli' },
] as const

function CliInstall() {
  const toast = useToast()
  const [chosen, setChosen] = useState<(typeof installs)[number]['id']>('npm')
  const [copied, setCopied] = useState(false)
  const install = installs.find((i) => i.id === chosen)!
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(install.command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { toast('Couldn’t copy. Select the command instead.') }
  }
  return (
    <section className="welcome-cli" aria-labelledby="welcome-cli-title">
      <div className="welcome-cli-head">
        <h2 className="welcome-agents-label" id="welcome-cli-title">Or from your terminal</h2>
        <span className="welcome-cli-soon">Coming soon</span>
      </div>
      <div className="welcome-cli-tabs" role="tablist" aria-label="Install with">
        {installs.map((i) => (
          <button key={i.id} type="button" role="tab" id={`welcome-cli-${i.id}`} aria-selected={i.id === chosen} aria-controls="welcome-cli-panel"
            onClick={() => { setChosen(i.id); setCopied(false) }}>{i.label}</button>
        ))}
      </div>
      <div className="welcome-cli-code" role="tabpanel" id="welcome-cli-panel" aria-labelledby={`welcome-cli-${chosen}`}>
        <pre><code><span className="welcome-cli-prompt">$ </span>{install.command}{'\n'}<span className="welcome-cli-prompt">$ </span>substrate workspace create --name demo</code></pre>
        <button type="button" className="welcome-cli-copy" aria-label={copied ? 'Copied' : `Copy the ${install.label} command`} onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
        </button>
      </div>
    </section>
  )
}
