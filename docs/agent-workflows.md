# Task inbox and fork-and-compare

Branch: `feat/agent-workflows`, based on `main` at `eb38652`.

## Using it

Open **Inbox** from the main navigation. Workspaces and existing terminal links
remain available.

Choose **New task**, a workspace, a name, and either a shell command or a prompt
for Claude Code, Codex, or OpenCode. Agent tasks use credentials already configured
inside that workspace. They do not obtain credentials from the browser or share
another user's credentials. Antigravity remains available through terminals;
there is no unverified non-interactive adapter for it.

An optional verification command runs after a successful task exit. Its result is
shown separately, so an agent claiming success cannot turn a failed test into a
pass. Restricted agent tasks do not support an interactive permission dialog;
inspect any denied-action result and continue in a terminal, or explicitly start
a task with different permissions. Full auto is an explicit owner choice.

Task results include stdout, progress/error output, process exit status,
verification output, and a Git change summary when the workspace is a repository.
The change summary includes pre-existing changes against HEAD; it is not presented
as an exact task-only patch. “Finished” means the process completed successfully,
not that its output is necessarily correct. Elapsed wall time can include pauses
and is not a billable-time measurement.

Filter by **Needs review** or **In progress**. Mark a finished result reviewed or
unreviewed. The task URL, results, and review state survive browser refresh and
are scoped to the signed-in owner. This first version tracks tasks launched
through the task API; it does not relabel existing interactive terminal sessions
as completed tasks or infer their outcomes from terminal text.

## Comparing approaches

Choose **Compare approaches**, select a prepared running or paused workspace, and
enter two commands/prompts. Each approach may use a different supported agent.
The UI applies one optional verification command to both approaches. Two free
places in the user's VM quota and memory capacity for both new VMs are required.

The host saves the source once, copies both children from that immutable
memory/disk generation, and only then resumes the children. The source is returned
to its prior running/paused state when possible. The response records the common
checkpoint ID. A restore failure can leave the source durably paused for retry.

The branches receive independent disks, network identities, and guest tokens.
Services and files in the original are copied, including configured user tools
and credentials. Use a prepared baseline: finish active agents before comparing.
Managed task runs prevent forking while they are active, including from a save
known to contain a running task. An unknown guest status at pause is treated
conservatively until the source is resumed and checked. Ordinary background
services/interactive sessions are still running-state forks, not clean templates.

Each approach appears in the inbox and comparison view. Compare real output,
exit status, and verification, then choose which approach to continue. Selection
records the owner's preference; it never declares an automatic winner, merges
code, or deletes the other workspace. Open either branch through **Open
workspace** and manage or delete it with the existing workspace tools.

## Execution and recovery

- Control stores task intent, comparisons, cached results, and reviews in SQLite
  alongside existing control state. Owner checks cover every new route.
- guestd owns execution. Tasks run as `dev` in the project directory when it
  exists, otherwise in `/home/dev`. Requests return before completion. There is
  one managed active task per workspace, a per-task time limit, and bounded output.
- Active tasks keep guest activity alive while waiting on models, preventing an
  idle auto-pause from freezing legitimate work. Manual pause still freezes the
  process. The existing maximum-awake guard remains in effect.
- Results persist in `/var/lib/substrate-guestd/tasks`. guestd retains up to 200
  task records; old completed records are pruned as new work is admitted. Control
  retains cached results, with the latest 200 tasks shown in the current inbox.
- stdout, stderr, result text, and verification output are bounded to 131,072
  characters per retained field; Git summaries are bounded to 32,768 characters.
  These are text limits, not byte-accurate artifact storage. The UI marks capped
  output and keeps recent output. There is no claim of arbitrary file uploads or
  permanent artifact hosting.
- Reconnecting reads status by the existing task ID. It never repeats the task.
  An uncertain start remains visible and blocks another task in that workspace
  until confirmed or cancelled. A cancellation can persist a tombstone before a
  delayed start arrives. Cancellation kills the active command's process group.
- A control restart can reconnect to guest-owned work. A guest restart marks
  unfinished disk records interrupted; it does not automatically rerun commands
  with potentially irreversible effects. Full VM resume preserves live task
  processes with the rest of memory.
- Reading the inbox never wakes a paused VM. Cancelling a task in a paused VM
  resumes it so its process can actually be terminated.
- Preparation failures remain visible. Control interruption while preparing a
  comparison does not automatically replay forks or approach prompts. Existing
  branches remain owner-visible for inspection/cleanup.

This is not an agent approval inbox, model-memory merger, scheduler, autonomous
judge, or a hosted-model subscription. Model calls use the owner's agent setup.

## API

All public endpoints require the same identity as VM management. Results from
another owner return 404. The preview distribution cannot serve these APIs.

| Method | Route | Purpose |
|---|---|---|
| GET / POST | `/api/tasks` | List task summaries / submit a task; creation returns 202 |
| GET | `/api/tasks/:id` | Read full retained result |
| PATCH | `/api/tasks/:id` | Set `{ "reviewed": true/false }` after completion |
| POST | `/api/tasks/:id/cancel` | Cancel an owner task |
| GET / POST | `/api/comparisons` | List / prepare a comparison; creation returns 202 |
| GET | `/api/comparisons/:id` | Read branch IDs, common generation, and selection |
| POST | `/api/comparisons/:id/select` | Choose `{ "taskId": "..." }` from this comparison |

The host-only `/vms/:id/forks` performs the atomic two-child fork. Guest task
routes are protected by the existing guest token and are not exposed publicly.

## Deployment and acceptance

These changes require new control and host code **and a task-enabled guest
image**. They do not change CloudFormation or require a CDK deployment. Updating
hostd does not replace guestd in existing disks. Create a new workspace from the
new image for task execution and comparisons; old workspaces retain their existing
terminal capabilities and receive an actionable error for unsupported tasks.

After coordinating any shared deployment with the other developer:

```sh
bun run typecheck
bun test
bun run --filter @substrate/web build
bun run deploy:host
bun run images:build
bun run deploy:control
bun run check:workflows
```

The AWS acceptance script creates only its own small VMs, checks common-generation
forks and independent outputs, verification, pause/resume, cancellation, and
interrupted-task recovery, then cleans up its own VMs. It uses no paid model calls
and does not stop/restart the shared EC2 host. Browser authentication/ownership
and request-failure handling are exercised by local integration tests.

Local verification passes: 130 tests with one Linux-specific PTY test skipped on
macOS, type checking, production web build, task process and
recovery tests, two-owner API and quota-race integration tests, and atomic fork
failure tests. The production web build retains the existing large-bundle warning.
Desktop/mobile browser checks exercised task submission, reload during execution,
verification output, review/filtering, comparison creation/selection, both color
themes, and layout overflow using isolated local commands and a simulated host.
The independent visual review returned `ship` with no material findings.

AWS acceptance and real authenticated agent tasks have **not** been run for this
branch. Local host simulation is not a Firecracker/ZFS acceptance result. After
deployment, also run one authenticated prompt for each agent you intend to use
and verify a restricted action, full-auto task, and a missing-login failure.

Adapter references checked during implementation:
[Claude programmatic execution](https://code.claude.com/docs/en/headless),
[Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode),
[OpenCode CLI](https://opencode.ai/docs/cli/) and
[permission configuration](https://opencode.ai/docs/permissions/).

## Integration with the deployed dashboard

The shared deployment already had dashboard/Windows changes from `c428e4b` that
were not on `main`. The deployment branch `deploy/agent-workflows-dashboard`
combines that exact deployed revision with `feat/agent-workflows`; it does not
replace the dashboard with the earlier main UI. Inbox joins the existing sidebar
and mobile tab bar. Task and comparison links use `#/inbox/task/:id` and
`#/inbox/comparison/:id`; earlier query-style links remain readable. The existing
Home, Workspaces, Windows, Jobs, Compute, Logs, and Settings pages remain.

Combined-release local checks: 145 tests passed, one Linux-only PTY test skipped
on macOS, type checking passed, and the production web build passed with its
existing large-bundle warning. AWS deployment and acceptance results are recorded
separately after they run.
