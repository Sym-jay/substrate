import { ArrowRight, Bot, BrainCircuit, Cpu, Feather, Globe, LayoutTemplate, NotebookPen, SquareTerminal } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { useData } from '../app/data.tsx'
import { gibLabel } from '../app/launch.ts'
import { StreakArt } from '../app/StreakArt.tsx'
import { Card, Empty, PageHeader, since, useToast } from '../app/ui.tsx'

// A placeholder for now: what templates will be, and the ones that come ready.
// Starting from one, and saving a workspace as one, are on the way.
type Template = { id: string; name: string; description: string; icon: ReactNode; size: { vcpus: number; memGib: number; diskGib: number } }

const ready: Template[] = [
  { id: 'rl', name: 'RL environment', icon: <BrainCircuit />, size: { vcpus: 8, memGib: 16, diskGib: 64 }, description: 'Python with Gymnasium, PyTorch and Stable-Baselines3, for training and evaluating agents.' },
  { id: 'hermes', name: 'Hermes Agent', icon: <Feather />, size: { vcpus: 4, memGib: 8, diskGib: 32 }, description: 'Nous Research’s open-source agent, installed and waiting for your model key.' },
  { id: 'openclaw', name: 'OpenClaw', icon: <Bot />, size: { vcpus: 2, memGib: 4, diskGib: 32 }, description: 'The open-source personal AI assistant, with its gateway set up.' },
  { id: 'jupyter', name: 'Jupyter', icon: <NotebookPen />, size: { vcpus: 4, memGib: 8, diskGib: 32 }, description: 'JupyterLab with pandas, NumPy and matplotlib, opened as an app preview.' },
  { id: 'next', name: 'Next.js app', icon: <Globe />, size: { vcpus: 4, memGib: 8, diskGib: 32 }, description: 'A fresh Next.js app with its dev server running, ready to preview.' },
  { id: 'ollama', name: 'Ollama', icon: <Cpu />, size: { vcpus: 8, memGib: 16, diskGib: 64 }, description: 'Ollama with a small local model, for work that stays off hosted APIs.' },
]

export function TemplatesPage() {
  const toast = useToast()
  const { vms } = useData()
  const soon = () => toast('Templates are on the way.')
  const mine = (vms ?? []).filter((vm) => vm.state !== 'failed')
  return (
    <div className="page-body">
      <PageHeader title="Templates" subtitle="Start a workspace already set up for the job" />

      <section className="rise" aria-labelledby="ready-made">
        <h2 id="ready-made" className="card-title mb-4">Ready-made</h2>
        <ul className="template-grid">
          {ready.map((t, i) => (
            <li key={t.id}>
              {/* Blue and black, in turn. */}
              <TemplateCard tone={i % 2 ? 'black' : 'blue'} icon={t.icon} name={t.name} description={t.description} size={t.size} action="Use template" onAction={soon} />
            </li>
          ))}
        </ul>
      </section>

      {/* Your workspaces, as they'd be as templates: saving one is on the way. */}
      {mine.length ? (
        <section className="rise" style={{ '--i': 1 } as CSSProperties} aria-labelledby="yours">
          <h2 id="yours" className="card-title mb-1">Yours</h2>
          <p className="text-faint mb-4 text-xs">Your workspaces, as templates. Set one up the way you like it, then save it to start new ones from.</p>
          <ul className="template-grid">
            {mine.map((vm, i) => (
              <li key={vm.id}>
                <TemplateCard
                  tone={i % 2 ? 'blue' : 'black'} icon={<SquareTerminal />} name={vm.name}
                  description={`${vm.repository ? `From ${vm.repository}` : 'A blank workspace'}, set up ${since(vm.createdAt)} ago.`}
                  size={{ vcpus: vm.vcpus, memGib: vm.memMib / 1024, diskGib: vm.diskGib }}
                  action="Save as template" onAction={() => toast('Saving a workspace as a template is on the way.')}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <Card title="Yours" className="rise" style={{ '--i': 1 } as CSSProperties}>
          <Empty icon={<LayoutTemplate />} title="Save a workspace as a template">
            Set one up the way you like it, then save it here, and start new ones from it. Coming soon.
          </Empty>
        </Card>
      )}
    </div>
  )
}

// One card: blue or black, the icon drawn large in streaks behind the words.
function TemplateCard({ tone, icon, name, description, size, action, onAction }: {
  tone: 'blue' | 'black'
  icon: ReactNode
  name: string
  description: string
  size: { vcpus: number; memGib: number; diskGib: number }
  action: string
  onAction: () => void
}) {
  return (
    <StreakArt icon={icon} className={`template-card is-${tone}`}>
      <div className="template-top">
        <span className="template-mark">{icon}</span>
        <span className="template-name">{name}</span>
        <span className="template-soon">Soon</span>
      </div>
      <div className="template-bottom">
        <p className="template-desc">{description}</p>
        <p className="template-size">{size.vcpus} vCPU · {gibLabel(size.memGib)} · {gibLabel(size.diskGib)} disk</p>
        <button type="button" className="template-use" onClick={onAction}>{action}<ArrowRight /></button>
      </div>
    </StreakArt>
  )
}
