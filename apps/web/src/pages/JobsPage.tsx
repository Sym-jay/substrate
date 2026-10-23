import { Activity, Bot, GitBranch, Plus } from 'lucide-react'
import { agentCatalog, agentName } from '../app/agents.ts'
import { useData } from '../app/data.tsx'
import { href } from '../app/router.ts'
import { Card, Empty, PageHeader, StateBadge, since } from '../app/ui.tsx'

// What's working: agents running in your workspaces, and background
// operations (creating and forking workspaces).
export function JobsPage() {
  const { vms, sessions, jobs } = useData()
  const byId = new Map((vms ?? []).map((vm) => [vm.id, vm]))
  const agents = (vms ?? []).flatMap((vm) => (sessions[vm.id] ?? []).filter((s) => s.agent).map((session) => ({ vm, session })))
  const working = agents.filter((a) => a.session.state === 'running')
  const ended = agents.filter((a) => a.session.state === 'exited')
  const paused = (vms ?? []).filter((vm) => vm.state === 'paused')

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <PageHeader title="Jobs" subtitle={`${working.length} agent${working.length === 1 ? '' : 's'} working · ${jobs.filter((j) => j.state === 'running').length} background operation${jobs.filter((j) => j.state === 'running').length === 1 ? '' : 's'}`} />

      <Card title="Agents" className="rise">
        {working.length + ended.length === 0 ? <Empty icon={<Bot />} title="No agent sessions">Start one from Home, or with New session in a workspace.</Empty> : (
          <ul>
            {[...working, ...ended].map(({ vm, session }) => (
              <li key={session.id} className="list-row">
                <span className="monogram is-sm">{agentCatalog.find((a) => a.id === session.agent)?.monogram}</span>
                <a href={href('workspaces', vm.id, session.id)} className="min-w-0 flex-1">
                  <p className="truncate font-medium">{agentName(session.agent)} <span className="text-muted font-normal">in {vm.name}</span></p>
                  <p className="text-faint text-xs">{session.mode === 'auto' ? 'Full auto' : 'Asks first'} · started {since(session.createdAt)} ago{session.checkpointId ? ' · checkpoint saved before it started' : ''}</p>
                </a>
                <StateBadge state={session.state === 'running' ? 'running' : 'exited'} label={session.state === 'running' ? 'working' : `ended${session.exitCode !== null ? ` (${session.exitCode})` : ''}`} />
              </li>
            ))}
          </ul>
        )}
        {paused.length > 0 && <p className="text-faint mt-3 text-xs">{paused.length} paused workspace{paused.length === 1 ? '' : 's'} ({paused.map((vm) => vm.name).join(', ')}) may have agents waiting; they carry on when resumed.</p>}
      </Card>

      <Card title="Background operations" className="rise" style={{ '--i': 1 } as React.CSSProperties}>
        {jobs.length === 0 ? <Empty icon={<Activity />} title="None yet">Creating and forking workspaces run here.</Empty> : (
          <ul>
            {jobs.map((job) => {
              const vm = byId.get(job.vmId)
              return (
                <li key={job.id} className="list-row">
                  <span className="text-faint [&>svg]:size-4">{job.kind === 'fork' ? <GitBranch /> : <Plus />}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{job.kind === 'fork' ? 'Fork' : 'Create'} {vm ? <a href={href('workspaces', vm.id)} className="underline-offset-2 hover:underline">{vm.name}</a> : <span className="text-muted">{job.vmId}</span>}</p>
                    <p className="text-faint truncate text-xs">{job.createdAt ? `${since(job.createdAt)} ago` : 'earlier'}{job.error ? ` · ${job.error}` : ''}</p>
                  </div>
                  <StateBadge state={job.state} />
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}
