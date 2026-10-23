# Agent workflows deployment — 24 October 2026

The task inbox and fork-and-compare feature is deployed with the existing dashboard and Windows-workspace support preserved. The shared site was running dashboard commit `c428e4b`, ahead of `main`, so deployment uses `deploy/agent-workflows-dashboard`, combining that exact live revision with PR #15. The PR remains open; no merge to main or CDK deployment was performed.

## Releases

- Control/web: `c7e6c81`.
- Host: `434fc93`.
- Guest task code: `434fc93`, in image 20261023-221757.
- Feature PR: https://github.com/harryfrzz/substrate/pull/15.
- Reproducible deployment source: https://github.com/harryfrzz/substrate/tree/deploy/agent-workflows-dashboard.

Control/web source is unchanged after `c7e6c81`; `434fc93` changes guest execution and acceptance checks. Later commits on the deployment branch update only acceptance scripts and documentation. The control database was backed up before deployment. The first feature-only host update was restored to `24d067d` after detecting the newer live dashboard branch; final deployment incorporates those changes.

## Validation

`bun run check:workflows` passed against real Firecracker/ZFS VMs:

- Source workspace booted in 2,873 ms; task output and verification were retained.
- Two running forks confirmed one checkpoint; both saw the original seed.
- Fork outputs diverged independently and the source disk remained unchanged.
- A live task survived full VM pause/resume (298 ms resume in this run).
- Cancellation returned promptly and background children could not write afterward.
- A guest-agent restart marked unfinished work interrupted without replaying it.

The acceptance script deleted all its VMs. Final inspection found no workflow test
VMs; the pre-existing workspace was still present, stopped, with no new error.
The host storage pool was ONLINE at 9% use. The control service was active with
zero automatic restarts. Public health reported `c7e6c81`; both web assets returned
200. Anonymous requests to Tasks, Comparisons, Windows, and Jobs returned 401,
and the dedicated preview origin returned 404 for the task API.

The first real VM run found that the PAM login wrapper separated task commands from the cancellation process group. The fix uses `setpriv` to switch to the existing `dev` identity and initialize its groups/home without creating a separate session. The feature PR includes the fix and an acceptance check that waits for background children to prove they cannot write after cancellation. An isolated Linux process test passed before rebuilding the guest image.

Local combined-release verification: 145 tests passed with one Linux-only PTY test skipped on macOS; type checking and production web build passed. After the cancellation change, all ten guest task tests and type checking passed again. The web build retains its existing large-bundle warning. Desktop/mobile functional checks covered task submission, reload, review, comparisons, selection, legacy links, and opening a workspace. Independent visual review required a light-theme status contrast correction; the reviewer scored it resolved and returned `ship` at that fix's scope.

## Using the release

Open Inbox in the dashboard. Create a **new Linux workspace** after this deployment to get the fixed task-enabled guest image. Existing workspace disks are not upgraded automatically. A comparison requires two free VM quota places and host capacity, in addition to the source workspace.

Agent prompts use the provider login already configured inside that workspace. No paid model calls, real authenticated agent prompts, or signed-in public-browser flow were run during this deployment. Shell task behavior is covered by the AWS acceptance run; owner isolation is covered by local two-user API integration tests, with anonymous API access checked against the deployed site.
