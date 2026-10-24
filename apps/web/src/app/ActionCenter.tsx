import { taskIsPending, type Task } from '@substrate/protocol'
import { ArrowRight, Inbox } from 'lucide-react'
import { useEffect, useState } from 'react'
import { WorkspaceApiError } from '../workspaces/api.ts'
import { workflowApi } from '../workflows/api.ts'
import { useData } from './data.tsx'
import { DitherFrame } from './DitherFrame.tsx'
import { navigate } from './router.ts'
import { Menu, since } from './ui.tsx'

const needsReview = (task: Task) => !taskIsPending(task) && !task.reviewedAt
const newest = (a: Task, b: Task) => b.createdAt.localeCompare(a.createdAt)

// The inbox, beside the account: tasks that finished and want a look, then
// the ones still running. The full inbox (#/inbox) has the rest, and each
// task's detail.
export function ActionCenter() {
  const { vms } = useData()
  // undefined until the first load; null when this server has no tasks.
  const [tasks, setTasks] = useState<Task[] | null | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      if (document.hidden) return
      try { setTasks(await workflowApi.tasks(controller.signal)) }
      catch (error) { if (!controller.signal.aborted && error instanceof WorkspaceApiError && [401, 404, 503].includes(error.status)) setTasks(null) }
    }
    void load()
    const timer = setInterval(load, 15_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [])

  if (tasks === null) return null
  const review = (tasks ?? []).filter(needsReview).sort(newest)
  const running = (tasks ?? []).filter(taskIsPending).sort(newest)
  const shown = [...review, ...running].slice(0, 6)
  const vmName = (id: string) => vms?.find((vm) => vm.id === id)?.name ?? 'a workspace'
  const label = review.length ? `Inbox: ${review.length} to review` : 'Inbox'

  return (
    <Menu align="end" button={({ open, toggle }) => (
      <button type="button" className="corner-button" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={toggle}>
        <DitherFrame />
        <Inbox />
        {review.length > 0 && <span className="corner-badge">{review.length > 9 ? '9+' : review.length}</span>}
      </button>
    )}>
      {(close) => (
        <div className="action-center">
          <div className="account-menu-head">
            <p className="text-sm text-[var(--ink)]">Inbox</p>
            <p className="text-faint text-xs">{review.length} to review · {running.length} running</p>
          </div>
          {shown.length === 0 ? (
            <p className="text-muted px-2.5 py-4 text-sm">{tasks === undefined ? 'Loading…' : 'Nothing to review. Give a workspace a task from the inbox.'}</p>
          ) : shown.map((task) => (
            <button key={task.id} type="button" role="menuitem" className="menu-item action-row" onClick={() => { close(); navigate('inbox', 'task', task.id) }}>
              <span className={`dot ${needsReview(task) ? 'is-ok' : 'is-busy'}`} />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate">{task.spec.title}</span>
                <span className="text-faint block truncate text-xs">{needsReview(task) ? 'To review' : 'Running'} · {vmName(task.vmId)} · {since(task.createdAt)} ago</span>
              </span>
            </button>
          ))}
          <button type="button" role="menuitem" className="menu-item action-open" onClick={() => { close(); navigate('inbox') }}>
            <span className="flex-1 text-left">Open inbox</span><ArrowRight className="size-4" />
          </button>
        </div>
      )}
    </Menu>
  )
}
