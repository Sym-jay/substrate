# Agent workflows

Mode: Operate. This extends Substrate's existing workspace application.

The user requested (1) a task/results inbox and (2) two approaches forked from the same environment with comparable evidence. They confirmed both agent prompts and shell commands, and preservation of the existing interface style.

Preserve the system sans typography, zinc light/dark surfaces, existing workspace buttons/fields, 44 px controls, owner-only access, and terminal/workspace management. Extend the main navigation with Inbox. Use an accessible task list with review/running filters, inline task/comparison forms, a readable result detail, and two evidence columns that stack on mobile. Use actual exit codes, verification output, and owner choice. No fabricated summaries, auto-winner selection, or automatic workspace deletion.

Required states: loading, empty, preparing, running, finished, verification failed, interrupted, permission restricted, reviewed, selected approach, unavailable workspace, and retryable request failure. Browser refresh preserves selection via hash URLs and data through the control/guest services.

Verification sizes: 1440 px desktop and 390 px mobile; honor both existing light and dark themes. The first capture round includes comparison and inbox screens at both widths. App screens are code-first for this session; no standing workflow preference or new visual identity is set.

## Implementation and documentation evidence

This remains an ordinary extension of the incumbent interface. `src/workspaces/workspaces.css`, `src/workspaces/WorkspacePanel.tsx`, and `src/index.css` remain the visual authority. The workflow panel reuses the workspace theme variables, headings, buttons, fields, empty/error treatments, system sans typography, and 44 px controls. New textareas follow the existing field radius, border, surface, ink, and focus treatment; result output uses the existing monospace family. Comparison columns and form fields stack below 640 px. The wider inbox accommodates paired evidence while the workspace view retains its existing width.

The documentation handoff compared `src/workflows/WorkflowPanel.tsx`, `src/workflows/workflows.css`, and `src/App.tsx` against those incumbent sources and `PRODUCT.md`. It opened `.impeccable/review/desktop.png` and `mobile.png` (dark comparison) and `inbox-light.png` (light inbox), confirming the inherited visual vocabulary and mobile stacking. The finish reviewer separately inspected all seven supplied screenshots and returned `ship`, with no material findings and a minor observation about repeated default Approach A/B titles. The implementation handoff reported no mechanical detector findings (`[]`).

No durable visual-system replacement was requested or approved. No `DESIGN.md` or `.impeccable/design.json` is introduced; existing system files are preserved. Documentation requirements are satisfied at ordinary-extension scope.
