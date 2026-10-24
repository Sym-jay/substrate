# VM creation and resume performance

Branch: `feat/vm-performance`, reconciled with main at `546c217`.
Measured on 2026-10-24, Linux host `r8i.8xlarge` in `ap-south-1`, Firecracker
1.17.0, a 50 GiB gp3 ZFS data volume and blank 8 GiB guest disks. Presets are
2 vCPU/4 GiB, 4 vCPU/8 GiB and 6 vCPU/16 GiB. No repository cloning, paid model
calls or extra EC2 instances are included.

## Results and target status

Warm resumes improved across all three presets. Fresh creation still takes
seconds: **a new workspace in under one second is not achieved by this change**.
The existing guest kernel alone takes about 0.74–1.00 s to boot, before systemd,
the guest agent and host disk/network preparation. A short Firecracker launch
or snapshot-load API call is not the same as a usable workspace.

Observed host-local HTTP request times, in milliseconds:

| Preset | Baseline warm median (5 samples) | Parallel preparation (5) | Experimental prefetch warm median (5) | Experimental warm range |
| --- | ---: | ---: | ---: | ---: |
| 4 GiB | 381 | 318 | 283 | 282–301 |
| 8 GiB | 350 | 296 | 297 | 287–315 |
| 16 GiB | 351 | 309 | 298 | 291–303 |

The default parallel-preparation medians are approximately 17%, 15% and 12%
below the baseline. Including terminal reattachment and a fresh command response,
the default medians are 460, 433 and 451 ms; the experimental medians are
367, 394 and 418 ms. Prefetch is **off by default**: its additional improvement
was inconsistent across sizes, especially after a host restart. These are small sequential samples, not production p95s or
browser-to-terminal latency guarantees.

Fresh creation, three samples per preset:

| Preset | Baseline median | Optimized image median | Optimized image range |
| --- | ---: | ---: | ---: |
| 4 GiB | 2697 | 2209 | 2124–2497 |
| 8 GiB | 2745 | 2691 | 2596–2749 |
| 16 GiB | 2775 | 2805 | 2626–2914 |

The baseline's first 4 GiB request was 4085 ms, including a 1085 ms dataset-creation
outlier. An image build overlapped the early baseline period, and that run did
not record each VM's image generation. Its critical-chain diagnostics confirm
the older `ldconfig` boot path, but the fresh-creation table is observational,
not a tightly isolated image A/B experiment. Later runs pin both release and
image generation and refuse changes.

Cold-host HTTP request times, one sample per size in each run:

| Preset | Baseline | Default parallel preparation | Experimental prefetch | Experimental request + terminal |
| --- | ---: | ---: | ---: | ---: |
| 4 GiB | 1143 | 1280 | 992 | 1233 |
| 8 GiB | 782 | 655 | 613 | 937 |
| 16 GiB | 615 | 590 | 599 | 911 |

The cold <500 ms resume target remains open. Even the experimental 992 ms first
health-ready result exceeds one second when terminal usability is included.
EC2 stop/start itself took about 52–62 s in the earlier runs and is additional.

Breakdown of the 16 GiB cold sample, in milliseconds:

| Stage | Baseline | Default parallel preparation | Experimental prefetch |
| --- | ---: | ---: | ---: |
| ZFS rollback | 55.20 | 57.65 | 53.05 |
| Network setup | 59.33 | 62.67 | 70.63 |
| Working-set prefetch | — | — | 124.14 |
| Firecracker launch | 22.24 | 25.29 | 31.94 |
| API readiness | 10.98 | 10.61 | 11.03 |
| Snapshot-load API | 11.03 | 11.84 | 8.60 |
| Metadata replacement | 0.59 | 0.47 | 0.84 |
| Unpause | 1.03 | 0.50 | 0.81 |
| Guest readiness | 420.55 | 442.03 | 385.98 |
| Durable record commit | 2.87 | 3.75 | 2.96 |

Preparation columns overlap in the optimized runs. Guest readiness remains the
largest component; snapshot-load API latency is not the main bottleneck.

The earlier cold run reproduced the historical ~604 ms result: the 16 GiB guest
reported `resumeMs: 605` (615 ms HTTP), with 421 ms waiting for guest readiness.
For that same run, the 4/8 GiB guests reported 1116/773 ms. After parallel setup,
16 GiB was 579 ms, so preparation alone did not meet the <500 ms target. All
cold runs restore in small/medium/large order after one EC2 stop/start; the first
restore also warms host paths. Do not infer that larger VMs inherently restore
faster, or treat three sequential restores as three independent cold hosts.

[Sanitized sample timings and lifecycle stages](benchmarks/vm-performance-2026-10-24.json)
retain the underlying measurements. Private raw output remains under ignored
`.data/performance-<label>-<run>.json`; committed evidence omits VM/session IDs,
credentials and guest journals.

## What is measured

- **Create request:** host-local HTTP request until a blank VM is running and
  guestd answers. Includes dataset creation, disk clone/resize, capacity and
  namespace setup, Firecracker launch and readiness. Repository setup would add
  time in a real creation request.
- **`bootMs`:** the existing field starts after Firecracker launch and omits
  disk/network preparation. Its meaning is preserved for compatibility.
- **Resume request:** host-local HTTP request until the saved guest answers.
  Timings separate ZFS rollback, network setup, prefetch, VMM launch, API
  readiness, snapshot loading, metadata replacement, unpause and guest readiness.
  The File-backed snapshot API maps memory lazily; subsequent page faults can
  dominate guest readiness even when snapshot loading itself takes ~7–13 ms.
- **Cold-host resume:** the same saved guest after a full EC2 stop/start. The
  EC2 wake time is recorded separately and excluded from VM resume latency.
- **Terminal:** after each create/resume, attach and request fresh output.
  Restores verify the original PID, a memory-only shell variable, a disk marker
  and scrollback. This latency is additional to health readiness.

## Changes

Disk rollback and network namespace setup are independent preparation steps.
They now overlap; both must finish successfully before Firecracker starts.
On failure both are joined before cleanup. Tests cover delayed network setup
after failed rollback and delayed rollback after failed network setup. The
checkpoint remains available for retry.

The new guest image prepares its library cache and systemd update stamps after
package installation, removing redundant first-boot `ldconfig` work. The guest
agent starts after writable local filesystems and tmpfiles initialization;
shutdown ordering remains explicit. Kernel-configured static networking is
already available. Existing VM disks and their boot units are not rewritten.
The deployed candidate image was cloned from a virgin base image and patched
with this same unit/cache preparation; the committed full image builder now
applies it to future builds too.

Experimental prefetch requires `SUBSTRATE_RESUME_PREFETCH=1` in the hostd
service environment and a hostd restart. It is off by default; disabled restores
do not capture or read hints. During the experiment it was enabled in the
benchmark release; the final deployed release restores the default to off.

A small optional hint learns resident guest pages from the previous immutable
snapshot mapping, after vCPUs are paused and before the next full snapshot is
written. File identity is matched by device/inode across the jail. Only page
presence metadata is inspected; guest memory contents and page-frame numbers
are not logged. Hints identify file offsets in the new full checkpoint.

Resume can read these offsets into the host cache alongside rollback/network
setup. Limits are 64 MiB, 4096 ranges, four 1 MiB buffers and a 120 ms scheduling
budget. In-flight reads are joined, so 120 ms is not an I/O wall-time guarantee.
Malformed, absent, oversized or incompatible hints fall back to ordinary
restore. The first pause after fresh boot has no hint; workloads over the
working-set/range limits also skip it. Hints do not change the snapshot format,
and older host releases ignore the sidecar. A 4 GiB diagnostic captured about
35 MiB in 33 ms; this is additional pause work, not free work.

Resume health probes allow up to one second for a cold request while respecting
the overall boot deadline. Liveness is checked by elapsed time, so slower
probes still detect an exited VMM promptly. This change avoids artificial abort
cycles; it is not credited with an independently demonstrated speedup.

The jailer, network isolation, identity verification, MMDS-before-unpause order,
full snapshot writes, fsync/ZFS durability, retry/recovery behavior and existing
API responses are retained.

## Instrumentation and reproduction

hostd emits one structured `vm.lifecycle` journal entry per profiled create or
resume: operation, VM ID, outcome, total time, stage durations and byte counters.
It contains no tokens, commands, prompts, environment variables or memory
contents. Concurrent stage durations overlap; do not sum them to infer total.
New guest images write best-effort startup stage timings to root-only volatile
`/run/substrate-boot-profile.json`.

```sh
bun run benchmark:vms --label sample
bun run benchmark:vms --label cold --repeats 1 --warm 1 --host-cycle
```

Defaults: `--repeats 3`, `--warm 5`, `--lease-minutes 90`. Use the normal deploy
AWS profile/environment. Measurements execute on the host and exclude SSM
round trips. An earlier 30-minute lease expired before a cold run; its warm
samples passed, the restart was refused and all temporary VMs were removed.

The benchmark holds both host-deployment and image-build locks with a bounded
expiry and rejects release/image changes. It hashes preexisting VM metadata,
checks it afterward and removes its own guests. `--host-cycle` refuses other
active guests or image builds, rechecks immediately before stopping the host,
and returns a host it stopped to running on failure. It never clears host
caches globally or deletes another user's workspaces. Stop/start tests cause
public host unavailability while EC2 wakes and should run in a coordinated
window.

## Validation and next step

- Full workspace typecheck passed; 219 tests passed, one Linux-only PTY test
  skipped on the macOS runner. Real AWS terminal checks covered persistent PTYs.
- `check:phase2:host` passed on the final default-off release: distinct jail UIDs,
  namespaces, chroot boundaries, public/allowlisted egress, metadata/host/peer
  blocking, durable pause/resume, retained process/memory/disk/scrollback, running
  forks and independent fork disks.
- `check:workflows` passed: persisted task output/verification, two comparison
  forks with shared ancestry and independent results, live task pause/resume
  (321 ms resume), cancellation including background children, and interruption
  reporting after guest-agent restart without replaying a task.
- All temporary VM records were removed. Original VM metadata hashes were
  identical before and after benchmarks and acceptance; the host returned to
  running. The original two workspaces remain stopped.
- Guest unit validation and both changed shell scripts' syntax checks passed.
  Public control health remained healthy at main `546c217`; no control/web or
  infrastructure deployment was needed.

Final host runtime source is `32f33cd`, with prefetch off, based on main
`546c217`. Guest image `20261024-020337-perf` contains guestd `2f22bb9` and the
new unit/cache preparation. Subsequent report commits do not change runtime
source. Reverting the host release does not invalidate snapshots; reverting
`current.json` selects the previous virgin image for future VMs without
rewriting existing guest disks.

For a reliable subsecond **new** workspace, the next bounded experiment should
be a pool of never-used, prebooted workspaces per supported size. Creation would
claim one atomically, set its owner/token/metadata and wait for the correct
identity; the pool would refill in the background, with ordinary boot as the
fallback. Pool quota reservation, concurrent claims, cleanup, custom sizes and
secret isolation need their own acceptance checks. A previously used workspace
must never be reassigned from that pool. That follow-up is the warm pool below.

## Warm pool: new workspaces in under a second

A boot can't get under a second (the kernel alone takes 0.74–1.00 s), so a new
workspace skips it: hostd keeps VMs booted ahead of time, and a create that fits
one claims it.

- **What's kept.** `SUBSTRATE_WARM_POOL` (from `/substrate/warm-pool` in Parameter
  Store at install): comma-separated `<size>[@<diskGib>]:<count>`, a size being a
  preset or `<vcpus>x<memGib>`, e.g. `large:1,2x2:8`. Unset, one `large` with a
  32 GiB disk, which is what the launcher asks for by default. `off` keeps none.
- **Claiming.** `POST /vms/claim` hands over a ready, never-used VM of the same
  vCPUs and memory, a disk no bigger than asked for (grown live if smaller) and
  open egress. It's renamed (metadata and hostname), recorded as the caller's
  (`claimedBy`) and leaves the pool for good. Claims take their own lock, never
  the lifecycle lock, so a boot in progress doesn't hold them up. Anything that
  doesn't fit (another size, an allowlist) answers 404 and is created as before.
- **Control.** Creating tries a claim first and answers 201 with the VM, so there
  is no job for the browser to poll. If control restarts between the claim and
  recording the owner, the VM's `claimedBy` lets the user's next listing record
  it. The quota is checked before either path.
- **Refilling.** Every 5 s, and after each claim, each size is topped up; boots
  run side by side, never into the last of the host's memory a create of that
  size would need. Pool VMs from an older image, of a size no longer wanted, or
  that went down are replaced. A cold create that needs the memory takes pool
  VMs down first. Pool VMs are hidden from the API, aren't auto-paused, and are
  balloon-managed like any other VM.
- **Boots in parallel.** Only the checks and the reservation (name, capacity,
  slot, dataset) now take the lifecycle lock; the clone, launch and boot run
  alongside other boots. Pausing, stopping or changing a VM that's still
  starting answers 409. This speeds up refilling and cold creates in bursts.

**Limits.** A claim is subsecond only while a VM of that size is ready: a burst
larger than the pool gets the pool's VMs at once and cold boots (2–3 s, now in
parallel) for the rest. Each pooled VM reserves its full memory against the
host's capacity, though the balloon keeps an idle one's real use near its floor.
`bun run benchmark:warm-pool` times claims, one at a time or as a burst
(`--parallel`), with a first terminal command in each.
