# Substrate plan

Substrate runs persistent sandboxes for long-running coding agents (Claude Code,
Codex, OpenCode, Antigravity CLI, custom agents). Each Linux workspace is a
Firecracker microVM on AWS. You use them from a laptop, tablet or phone.

| Phase | Who uses it | Goal |
|---|---|---|
| 1. Personal | Only me | Everything I need day to day, on one host, as cheaply as possible |
| 2. Private beta | Me plus a few invited people | Safe to share: real login, isolation between users, billing |
| 3. Public launch | Anyone | Sign-up, many hosts, scaling on demand (draft) |

Finish each phase before starting the next. Phases 2 and 3 are outlines; they get
expanded into milestones when their turn comes.

## Ground rules (all phases)
- Work in `~/substrate` (GitHub `harryfrzz/substrate`, branch `main`).
- Build from scratch. Don't copy or reuse code from the older kestrel attempt, and
  never push from its folder.
- Use TypeScript wherever possible. Only Firecracker itself, the guest kernel config,
  image build scripts and host setup scripts are not TS.
- The repo is public: never commit secrets, tokens, account IDs or IPs.
- You can't run `cdk deploy` (the safety check blocks it). When infra changes, stop
  and ask me to run `! cd ~/substrate/infra && bunx cdk deploy`.
- Check each milestone on real AWS against its "Done when" before starting the
  next. Commit each milestone separately and push once it passes.
- Leave alone any AWS resources the `Substrate` stack didn't create, including the
  shared `CDKToolkit` stack and its bucket.
- Report what you checked and how, with numbers such as boot and resume times.
- When something needs me (deploys, MFA, tokens), stop and give me the exact
  command to run.

---

# Phase 1: Personal

Only I use it. Nothing here is production or multi-user.

## AWS
- Region `ap-south-1`. CDK is already bootstrapped there.
- Use an admin IAM user with MFA for the CLI, not the root account.
- The host costs about $1.15/h. Stop it whenever you aren't testing on it, until
  M5 does this automatically.
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
- Firecracker v1.17.0. Add the jailer in Phase 2.
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
- Firecracker only runs Linux. Windows and macOS workspaces are separate EC2
  instances (M9, M10), shown in the same UI.
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

**M9 Windows workspaces:** a Windows workspace is its own EC2 instance, not a
microVM.
- Windows Server 2025 with the license included, on `m8i.xlarge` (4 vCPU / 16 GB,
  about $0.41/h in ap-south-1). Windows 11 can't be used this way: AWS only allows
  it with your own license on dedicated hardware.
- Created and started on demand from the same UI. It takes a few minutes to boot,
  and the UI shows progress.
- Remote desktop through Amazon DCV (free on EC2) in the browser, so it works on
  phones and tablets. Reached through the control box like everything else, with
  no open ports.
- Comes with Git, Node, Claude Code and Codex. WSL2 can work too, since `m8i`
  supports nested virtualization.
- Disk on EBS. The same idle rules as M4 apply, but the instance is stopped rather
  than paused.
Done when: I can create a Windows workspace from the UI, open its desktop in the
browser on my phone, run Claude Code in PowerShell, and it stops itself when idle.

**M10 macOS workspaces (optional):** a macOS workspace runs on an EC2 Mac
dedicated host.
- AWS bills Mac hosts in 24-hour minimums, so every start costs at least a full
  day. The UI must warn about this before allocating one.
- ap-south-1 only offers `mac1.metal` (Intel Mac mini). The nearest Apple Silicon
  is `mac2.metal` (M1) in ap-southeast-1 (Singapore).
- Apple's license allows at most 2 macOS VMs per Mac. For personal use, use the
  host's own macOS directly.
- Remote desktop through Apple Screen Sharing (VNC), shown in the browser with
  noVNC and tunneled through the control box.
- Release the host when done (after the 24-hour minimum).
Done when: I can allocate a Mac from the UI after a cost warning, open its desktop
in the browser, run an agent, and release it.

---

# Phase 2: Private beta

Before anyone else uses Substrate. Phase 1 must be finished first.

**Access**
- A domain with HTTPS (Caddy on the control box) and GitHub login, replacing the
  tunnel.
- Terminal connections checked with short-lived tickets.

**Data**
- Postgres (Amazon RDS, small instance) for users, VMs, sessions, events and
  billing, replacing SQLite.

**Isolation between users**
- The Firecracker jailer for every VM.
- A separate network namespace per VM.
- An outbound proxy with an allowlist.
- Per-user quotas (VM count, sizes, disk, running hours).

**Secrets**
- All tokens in Parameter Store, rotated on a schedule.
- Users' own agent API keys (Anthropic, OpenAI) encrypted with KMS and sent into
  their VMs only.

**Billing**
- Monthly subscription plans through Stripe.
- Usage measured from active VM time, which M4's events already record.

**Notifications**
- A channel chosen per user: ntfy, Telegram or email (Amazon SES).

Done when: an invited person can sign in with GitHub, create and use their own VMs,
can't see or reach mine, stays inside their quota, and is billed for active VM
time.

---

# Phase 3: Public launch (draft)

Open sign-up and many hosts. This is a draft from early architecture
discussions; it gets reviewed and turned into milestones after Phase 2.

| Need | AWS service / choice |
|---|---|
| Frontend | S3 + CloudFront |
| DNS and TLS | Route 53 + ACM, including a wildcard cert for `*.preview.<domain>` |
| API and gateway | Hono on Node/Bun in ECS Fargate behind an ALB. The terminal/preview gateway is split into its own service when traffic grows |
| Database | Aurora Serverless v2 (Postgres), migrated from RDS |
| Background jobs and schedules | SQS + EventBridge Scheduler |
| Host fleet | EC2 Auto Scaling group of nested-virtualization hosts (`.metal` later for density), with warm pools because hosts boot slowly. A scheduler places VMs across hosts, and hosts connect outbound to the control plane |
| Snapshots | Paused VMs are stored in S3 so they can wake on any host. Keep the fleet on one instance family, because Firecracker snapshots only restore on the same CPU type |
| Secrets | Secrets Manager + KMS |
| Logs and metrics | CloudWatch + the AWS Distro for OpenTelemetry |
| Email | Amazon SES |
| Login | Better Auth with GitHub (Cognito can't use GitHub login without a custom adapter) |
| GitHub access | A GitHub App with short-lived per-repo tokens, replacing personal tokens |
| Billing | Stripe, charged per second of active VM time |

Also planned for this phase:
- Windows and macOS as paid tiers.
- A mobile chat view built on the agents' JSON output
  (`claude -p --output-format stream-json`, `codex exec --json`), in addition to
  the terminal.
- Avoid API Gateway WebSockets for terminals: connections are capped at 2 hours,
  drop after 10 idle minutes, and are billed per message.

Done when: a new user can sign up and get a running VM within seconds, and the
host fleet grows and shrinks on its own.

---

## How to start
Scaffold the monorepo, then start Phase 1 at M0.
