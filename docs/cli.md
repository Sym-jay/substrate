# Substrate CLI

The CLI uses the public control API with the same workspace ownership and quotas
as the website. Users do not need AWS credentials, SSM, or access to hostd.
The first version manages **Linux workspaces, tasks, and comparisons**. It opens
workspace links in the existing browser UI for terminal access.

This feature is on `feat/cli`, based on the deployed integration branch at
`9c8521d`. It is not deployed or published to a package registry. The existing
`scripts/vm.ts` remains an AWS administrator tool.

## Run and build

From this checkout, with Bun 1.4.4 or newer:

```sh
bun install --frozen-lockfile
bun run cli --help
bun run cli:build
```

The compiled executable is `dist/cli/bun-<platform>-<arch>/substrate` and does not
need Bun installed on its destination machine. Build another target explicitly:

```sh
bun run cli:build bun-linux-x64
```

Supported build targets are `bun-darwin-arm64`, `bun-darwin-x64`,
`bun-linux-arm64`, and `bun-linux-x64`. Builds are local artifacts; no installer,
package-registry publication, automatic update, or global PATH change is made.
Examples below use the compiled executable as `substrate`.

## Sign in

Deploy the CLI-enabled control/web service first, then:

```sh
substrate login --url https://YOUR-SUBSTRATE-HOST
substrate whoami
```

The CLI opens the website. Sign in with the existing Clerk account, compare the
code in the browser with the terminal, and explicitly approve CLI access.
Opening the link or signing in alone grants nothing. `--no-browser` prints the
link for manual use, including from another device. The request expires after
ten minutes; CLI credentials expire after 30 days. The browser never displays the
bearer credential. Device names are supplied by the requesting CLI and are not
proof of who owns that machine.

Settings → CLI access lists active credentials and their expiry/last-use times.
Revoke any credential there, or run `substrate logout` to revoke the saved login
and remove it locally. If Settings was opened before the terminal finished
signing in, use **Refresh sessions** after the CLI finishes.

Credentials permit the same account operations as the web API, including deleting
workspaces and executing commands. They do not grant AWS administration rights.
Revocation is checked on each request. Clerk account existence, enabled state,
and the verified-email allowlist are rechecked with at most a one-minute cache.
A credential is never used as a browser session to approve another login or manage
other credentials.

The default local file is `~/.config/substrate/credentials.json`, respecting
`XDG_CONFIG_HOME`. New config directories use mode 0700 and credential files use
0600 on macOS/Linux. Writes use a private temporary file and atomic rename.
Tokens are bound to a server origin; selecting another server does not reuse one.
Set `SUBSTRATE_CONFIG_DIR` to choose a different dedicated config directory.

For CI, provide an existing CLI credential through secret environment variables:

```sh
export SUBSTRATE_URL=https://YOUR-SUBSTRATE-HOST
# Provide SUBSTRATE_TOKEN through your CI secret manager.
substrate workspace list --json
```

`login --url URL --token-stdin` imports a credential from stdin after validating it.
Raw credentials are not accepted as command-line arguments or printed in login
output. A supplied `SUBSTRATE_TOKEN` overrides the saved credential. `logout`
requires unsetting that environment variable so it cannot silently revoke a
credential supplied by another system.

Remote servers require HTTPS. HTTP is allowed only for loopback development.
The client does not follow redirects with credentials.

## Workspaces

```sh
substrate workspace list
substrate workspace create --name demo --size small --disk 8
substrate workspace create --name project --repo OWNER/REPO
substrate workspace get demo
substrate workspace pause demo
substrate workspace resume demo
substrate workspace settings demo --idle 30 --max-run 12
substrate workspace fork demo --name experiment --wait
substrate workspace resize demo --size medium --disk 32
substrate workspace open demo
substrate workspace preview demo --port 3000
substrate workspace stop demo
substrate workspace start demo
substrate workspace delete demo --yes
```

A workspace reference is its exact ID or unique name. Another owner's workspaces
remain invisible. Delete requires `--yes` and removes that workspace's disk and
sessions. Forking retains the original and observes the existing quota and
active-task restrictions. Creation waits for the VM or background job to finish;
forking returns the job by default, or waits with `--wait`.

For short remote commands, arguments after `--` are preserved literally:

```sh
substrate workspace exec demo -- printf '%s\n' 'literal $HOME'
substrate workspace exec demo -- sh -lc 'git status --short && bun test'
substrate workspace exec demo --command 'printf hello; uname -a'
```

`--root` chooses the existing root execution option. Command stdout/stderr and
exit code are forwarded. `--json` returns the structured execution result instead.
`--timeout` is the guest execution limit in seconds (default 30, maximum 600).
HTTP proxies may impose a shorter connection limit. Use tasks for long work,
disconnection tolerance, persisted output, or verification.

## Tasks

```sh
substrate task run demo --name 'Run tests' --command 'bun test' --wait
substrate task run demo --name 'Investigate checkout' \
  --agent claude --prompt 'Find the checkout failure and explain the fix' \
  --verify 'bun test' --wait
substrate task list --json
substrate task get TASK_ID
substrate task wait TASK_ID
substrate task review TASK_ID
substrate task review TASK_ID --unreviewed
substrate task cancel TASK_ID
```

Runners are `command`, `claude`, `codex`, and `opencode`. Agent prompts use the
provider login already configured inside the workspace. Restricted permissions
are the default; `--auto` explicitly chooses full-auto for an agent task.
`--timeout` sets the task runtime limit (10–86400 seconds, default 3600).

A submission returns its task ID. `--wait` or `task wait` polls the existing ID;
it does not resubmit work. Results survive CLI restarts and remain visible in the
web Inbox. `task get --json` includes the complete retained output; `task list`
returns summaries. A waiting command exits nonzero if the task, verification,
or preparation fails, is cancelled/interrupted, or needs input. Reading a failed
result with `task get` still exits successfully when the read succeeds.

`--wait-timeout SECONDS` bounds waiting (default 3600). A timeout or Ctrl+C ends
only the local wait. The remote operation continues; use its ID to inspect or
explicitly cancel it. Transport failures never trigger automatic mutation retries:
list workspaces/tasks or read the recorded ID before submitting another operation.

## Compare two approaches

```sh
substrate compare run demo --name 'Two build approaches' \
  --a 'bun run build' --b 'npm run build' --verify 'test -d dist' --wait
substrate compare list
substrate compare get COMPARISON_ID --json
substrate compare wait COMPARISON_ID
substrate compare choose COMPARISON_ID --task TASK_ID
```

The host creates both workspaces from one saved generation. A comparison needs
two free quota places and enough host memory, in addition to the source VM.
Both results, verification outcomes, and workspaces are retained. Choosing an
approach records a preference; it never merges changes or deletes a workspace.

For agent prompts or different runner settings, use `--file approaches.json`:

```json
{
  "title": "Two checkout fixes",
  "approaches": [
    { "title": "Minimal change", "runner": "claude", "input": "Fix checkout with the smallest safe change", "verificationCommand": "bun test" },
    { "title": "Refactor validation", "runner": "codex", "input": "Fix checkout by improving validation", "verificationCommand": "bun test" }
  ]
}
```

```sh
substrate compare run demo --file approaches.json --wait --json
```

The file contains exactly two task specifications. Permission mode defaults to
`ask`; choose `"mode": "auto"` explicitly when needed. The starting workspace
always comes from the CLI argument, with normal owner checks.

## Automation and exit codes

`--json` emits one JSON result on stdout. Execution errors go to stderr as JSON;
login instructions also go to stderr. Human listings strip ANSI and control
sequences; direct command execution forwards command output.

| Code | Meaning |
|---|---|
| 0 | Read/submission/operation succeeded; waited tasks and verification succeeded |
| 1 | API/authentication/network error, failed task/verification, or failed comparison |
| 2 | Command/flag usage error |
| 7 (example) | `workspace exec` forwards the command's own exit code |
| 124 | Direct execution timed out |
| 130 | Local CLI interrupted; submitted remote operations continue |

## Deployment and verification

Only control/web deployment is needed for CLI login and revocation. The host and
task-enabled guest image already deployed for agent workflows provide the VM/task
operations. This branch does not change CDK, hostd, or guestd. Existing browser
session authentication and terminal tickets remain in place.

CLI credential/device tables use the current control SQLite database and survive
control restarts. The unmerged Phase 2 PR replaces that data layer with Postgres;
port these two isolated tables through its database adapter when integrating that
branch. This CLI does not merge or deploy Phase 2.

Local verification covers real CLI processes against owner-scoped HTTP APIs,
browser approval and revocation, hashed server persistence, private local config,
literal shell arguments, task verification, comparison selection and isolation,
interrupt/detach behavior, redirects, no mutation replay, expiry, and API isolation.
Host behavior is simulated; shell tasks run in isolated local directories. No AWS
resources are mutated and no paid model calls are made for these tests.

The shared control service does not have these CLI login endpoints yet. Real
Clerk sign-in and authenticated CLI-to-AWS acceptance remain deployment checks.
The standalone binary and exact local test/build results are recorded in the
feature handoff; use the existing agent-workflow AWS acceptance separately if
host/guest code or images change.

### Verified in this change

- Full suite: **156 passed, 1 Linux-only PTY test skipped on macOS**, 789 assertions,
  157 tests across 22 files. Type checking passed for all workspaces and scripts.
- Production web build passed with the existing large-bundle warning.
- The macOS ARM64 standalone binary ran `--version`, `--help`, and an anonymous
  read of the live public status endpoint. Linux x64 cross-compilation produced
  an ELF executable; that binary has not been executed on Linux in this change.
- Browser checks at 1440 px and 390 px covered code approval, CLI completion,
  session refresh/revocation, rejection of the revoked credential, decline,
  unavailable codes, and offline lookup/retry recovery in dark/light themes.
- Independent visual review scored the requested retry fix resolved and returned
  `ship` at that fix's scope. Real Clerk login and authenticated CLI-to-AWS
  acceptance are still pending deployment.

Reproduce local checks with:

```sh
bun run typecheck
bun test
bun run --filter @substrate/web build
bun run cli:build
bun run cli:build bun-linux-x64
```
