# VM creation and resume performance

Development branch: `feat/vm-performance`, reconciled with main at `f189344`.
Changes retain the jailer, network isolation, snapshot format, durable writes,
guest identity checks, retry/recovery behavior and existing API responses.

## What is measured

- **Create request:** host-local HTTP request until the new blank VM is running
  and guestd answers. Includes dataset creation, disk clone/resize, capacity and
  namespace setup, Firecracker launch and guest readiness. No repository clone
  or agent/model request is included in the benchmark.
- **`bootMs`:** the preexisting field starts after Firecracker launch. It omits
  disk/network preparation, so it is not the full workspace creation latency.
  Its meaning is preserved for compatibility.
- **Resume request:** host-local HTTP request until the saved guest answers.
  Structured stage timings separate ZFS rollback, network setup, VMM launch,
  API readiness, snapshot loading, MMDS replacement, unpause and guest readiness.
- **Cold-host resume:** the same saved guest after a full EC2 stop/start. The
  separately recorded host-cycle time is not included in the VM resume latency.
- **Terminal:** after each create/resume, the benchmark attaches and asks for
  fresh output. On restore, it checks the original PID, memory-only shell
  variable, disk marker and scrollback. This time is reported separately from
  the health-ready request, never assumed to be zero.

Samples use preset small/medium/large sizes (4/8/16 GiB), 8 GiB disks, three
fresh creations per size, five warm resumes per size, and one cold-host resume
per size. These are observed samples, not a production percentile guarantee.

## Instrumentation and benchmark

hostd emits a bounded structured `vm.lifecycle` journal entry per profiled create
or resume. It contains operation, VM ID, outcome, total time and stage durations;
no tokens, commands, prompts, environment variables or memory contents. Concurrent
stage durations overlap: do not sum them to infer total latency.

```sh
bun run benchmark:vms --label baseline
bun run benchmark:vms --label baseline --host-cycle
```

Options: `--repeats 3`, `--warm 5`. AWS environment/profile is the same as deploy
scripts. Measurements run on the host, excluding SSM round trips. Raw results
are saved under ignored `.data/performance-<label>-<run>.json`.

The benchmark changes only its own VMs. It records hashes of preexisting VM
metadata and checks them afterward, cleans up created guests, holds the existing
host deployment lock with a 30-minute expiry, and rejects release changes.
`--host-cycle` refuses other active guests or image builds and returns a host it
stopped to running on failure. It never empties caches globally or deletes
another user's workspaces.

## Optimizations being validated

Disk rollback and network namespace setup are independent preparation steps.
They run concurrently; both must finish successfully before Firecracker starts.
If either fails, the other is joined before cleanup. Tests cover delayed network
setup after a failed rollback and delayed rollback after network setup fails.
The saved checkpoint remains available for retry.

The guest image prepares its library cache and update stamps after package
installation, avoiding redundant first-boot `ldconfig` work. The agent starts
after writable local filesystems and tmpfiles initialization rather than waiting
for the complete `basic.target` boot transaction. Shutdown ordering is explicit.
This uses the kernel-configured static network and retains normal systemd,
Docker, SSH and login shells. Existing VM disks and their boot units are not
rewritten by an image update.

References: [systemd service dependencies](https://freedesktop.org/software/systemd/man/latest/systemd.service.html),
[update stamps](https://www.freedesktop.org/software/systemd/man/devel/systemd-update-done.service.html).

## Results

Results and the final one-second-target assessment will be recorded after the
guarded before/after AWS runs and regression checks finish. The initial attempt
was interrupted by an unrelated host deployment; its partial samples are
diagnostic evidence, not a complete baseline.
