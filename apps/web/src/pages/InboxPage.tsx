import { navigate } from '../app/router.ts'
import { WorkflowPanel } from '../workflows/WorkflowPanel.tsx'

// Agent tasks and fork-and-compare runs, with what needs a review first.
export function InboxPage() {
  return (
    <div className="page-body">
      <WorkflowPanel onOpenWorkspace={(vmId) => navigate('workspaces', vmId)} />
    </div>
  )
}
