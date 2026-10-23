# Substrate plan (Phase 1: personal use)

## Goal
Build Substrate from scratch: persistent Firecracker microVM sandboxes on AWS for
long-running coding agents (Claude Code, Codex, OpenCode, Antigravity CLI, custom
agents). I use them from a laptop, tablet or phone. This is for one person (me).
Nothing here is production or multi-user.

## Ground rules
- Work in `~/substrate` (GitHub `harryfrzz/substrate`, branch `main`).
- Build from scratch. Don't copy or reuse code from the older kestrel attempt, and
  never push from its folder.
- Use TypeScript wherever possible. Only Firecracker itself, the guest kernel config,
  image build scripts and host setup scripts are not TS.
- The repo is public: never commit secrets, tokens, account IDs or IPs.
- You can't run `cdk deploy` (the safety check blocks it). When infra changes, stop
  and ask me to run `! cd ~/substrate/infra && bunx cdk deploy`.
- The host costs about $1.15/h. Stop it whenever you aren't testing on it, until M5
  does this automatically.
- Check each milestone on the real host against its "Done when" before starting
  the next. Commit each milestone separately and push once it passes.
- Leave alone any AWS resources the `Substrate` stack didn't create, including the
  shared `CDKToolkit` stack and its bucket.

## AWS
- Region `ap-south-1`. CDK is already bootstrapped there.
- Use an admin IAM user with MFA for the CLI, not the root account.
- One CDK stack named `Substrate`:
  - VPC with one public subnet and no NAT gateway. No inbound ports from the
    internet; all admin access goes through SSM.
  - Control box: `t4g.small`, Amazon Linux 2023 arm64, always on. Runs the control
    API and the web UI.
  - Sandbox host: `r8i.4xlarge` (memory-optimized, 16 vCPU / 128 GiB), Ubuntu 24.04
    x86_64, with nested virtualization turned on through the launch template
    (`CpuOptions.NestedVirtualization: enabled`). 30 GB gp3 root disk, plus a
    separate 50 GB gp3 data disk (`RemovalPolicy.RETAIN`) that holds a ZFS pool.
  - Security groups: the control box can reach hostd's port on the host. Nothing
    else is open.
  - SSM Parameter Store SecureStrings for the control↔host token, and later the
    GitHub token. Create them with a script so they never land in shell history.
  - S3 bucket for build artifacts (kernel, rootfs, binaries).
  - A monthly AWS Budget with an email alert.

## Stack
| Part | Choice |
|---|---|
| Monorepo | Bun workspaces (Bun 1.4.4), TypeScript strict |
| `apps/web` | Vite 8 + React 19 + Tailwind CSS 4 + `@xterm/xterm` 6. Mobile-first: on-screen key bar (Esc, Ctrl, Tab, arrows), installable as a PWA |
| `apps/control` | Bun + Hono 4 on the control box. Serves the web build and a REST + WebSocket API, relays terminals and preview URLs to hostd, and starts/stops the host (M5). State in SQLite (`bun:sqlite`) |
| `apps/hostd` | Bun + TS on the sandbox host. Talks to Firecracker's HTTP API over its Unix socket using a typed client generated from Firecracker's OpenAPI spec. Handles ZFS, TAP networking, snapshots and capacity checks |
| `apps/guestd` | Bun + TS, built with `bun build --compile` into one binary inside the rootfs and run by systemd. Runs terminals with `Bun.spawn({ terminal })`, keeps sessions and their scrollback, reports agent activity |
| `packages/protocol` | zod schemas and types shared by all of the above |
| `infra` | AWS CDK (`aws-cdk-lib` 2.274) in TS |
| `images` | Host setup script, guest kernel config and build script, rootfs build script |

## VM design
- Firecracker v1.17.0. Add the jailer later.
- Sizes: the default is 6 vCPU / 16 GB, with smaller presets of 4 vCPU / 8 GB and
  2 vCPU / 4 GB. With hyperthreading on, Firecracker only accepts 1 or an even
  number of vCPUs.
- Capacity: CPU can be overcommitted but memory can't. hostd keeps about 4 GB for
  the host and refuses a VM that doesn't fit, which leaves room for about 7 default
  VMs (more once M8 lands).
- Guest: Ubuntu 24.04 rootfs and a custom kernel with everything Docker needs
  (cgroups v2, overlayfs, netfilter/nftables, bridge, veth). Preinstalled: Docker,
  git, gh, Node, Bun, Python, tmux, Claude Code, Codex, OpenCode, Antigravity CLI
  (`agy`).
- Linux only in Phase 1. macOS and Windows can't run on Firecracker, so they're out
  of scope.
- Disks: the base rootfs is a ZFS zvol snapshot, and each VM gets an instant
  copy-on-write clone of it. Turn compression on (lz4 or zstd) so memory snapshots
  of mostly empty RAM stay small.
- Network: one TAP device per VM on its own /30, with NAT out through nftables.
  The guest gets its IP from kernel boot arguments.
- Host ↔ guest: TCP over the VM's private link, because Bun can't open vsock
  sockets. Each VM gets a token through Firecracker's metadata service (MMDS), and
  guestd only listens on the private link.
- hostd is the source of truth for VMs (ZFS user properties plus a small state
  file), so nothing is lost when it restarts.
- Start modes: blank (an agent starts right away in an empty workspace), terminal
  only, and from GitHub (M6).

## Access
- To start: an SSM port-forward from my laptop to the control box. The UI is at
  `http://localhost:8080` and previews at `http://<port>-<vm>.localhost:8080`.
  Add `scripts/tunnel.ts` for this.
- Phone and tablet access is a core goal. Before M6, give me the options
  (e.g. Tailscale on the control box, or a domain with Caddy HTTPS and a login)
  and ask me to choose.

## Milestones
**M0 AWS setup:** the CDK stack, host setup script, ZFS pool and budget.
Done when: `cdk deploy` succeeds, both boxes are reachable over SSM, the host has
`/dev/kvm`, the ZFS pool is on the data disk, and the budget alert exists.

**M1 microVMs:** hostd can create, list and delete VMs; kernel and rootfs builds
work.
Done when: a default VM boots in about 4 s or less, has internet,
`docker run hello-world` works, and every agent CLI prints its version.

**M2 Terminals:** the web UI lists VMs, creates them (size and start mode), and
opens browser terminals.
Done when: after closing the tab and reopening it, including from another device,
the same session is there with its scrollback, and the process kept running.

**M3 Pause/resume:** pause saves the whole VM (memory and disk) to ZFS.
Done when: resume takes 0.5 s or less (target 0.2 s), and a paused VM survives the
host being stopped and started.

**M4 Auto-pause:** guestd notices when an agent stops, using Claude Code
Stop/Notification hooks, Codex `notify`, an OpenCode plugin, and an idle check
(no terminal output and low CPU). After N idle minutes the VM pauses itself and
alerts me through ntfy, and typing into its terminal wakes it.
Done when: an agent finishing a task sends the alert and pauses the VM, and typing
resumes it.

**M5 Host auto-stop:** once every VM has been paused or stopped for about 5
minutes, the control box stops the host. Clicking Resume or opening a paused VM's
terminal starts the host first; that takes about 60 s, and the UI shows "waking
up". A maximum-uptime cost guard (e.g. 12 h) stops the host no matter what.
Done when: with all VMs idle, the host stops within about 5 minutes, and opening a
terminal gets me back in under 90 s.

**M6 Everyday features:**
- Create, delete and resize VMs from the UI, either one per project or one per
  task.
- Fork: copy a VM, including its running state, to try two approaches in
  parallel.
- Preview URLs: open a VM's dev server in the browser. Visiting the link wakes a
  paused VM.
- GitHub: a fine-grained token limited to the repos I pick, set up with `gh` inside
  the VM. Clone repos from the UI, push branches and open PRs. This is also the
  "from GitHub" start mode.
- Agent mode per session, either full-auto or ask-for-permission. Take a ZFS
  checkpoint before each run so I can roll back.
- VS Code Remote / SSH into a VM through the control box, with no open ports.

**M7 Hardening for 24-hour runs:**
- A maximum run time or spending cap per VM, so a stuck agent can't run forever.
- Daily EBS snapshots of the data disk (Data Lifecycle Manager).
- Recovery: if a paused VM can't be restored, boot it fresh and continue with
  `claude --resume`. Bring VMs back automatically after a host crash.
- Diff snapshots, so pausing a VM that has been paused before takes 2–3 s.
- A disk size limit per VM that can be raised on request.
- Logs and health checks.

**M8 Elastic memory:** a balloon device lets VMs start at 4 GB, grow to their limit
(16 GB by default), and hand memory back when idle.
Done when: three idle default VMs together use under about 16 GB of host RAM.

## Out of scope for now (Phase 2)
Postgres, multiple users, GitHub login, billing/Stripe, per-user quotas, an
outbound allowlist proxy, a custom domain (unless I choose it for phone access),
and macOS/Windows.

## How to work
- Scaffold the monorepo, then start M0.
- Do one milestone at a time. Report what you checked and how, with numbers such as
  boot and resume times.
- When something needs me (deploys, MFA, tokens), stop and give me the exact command
  to run.
