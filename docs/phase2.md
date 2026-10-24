# Phase 2: data, isolation between users, secrets, GitHub

This branch builds the Data, Isolation and Secrets parts of Phase 2 in
[plan.md](plan.md), plus connecting GitHub so a new workspace can start from
one of the user's own repositories. Billing (Stripe), notifications and the
custom domain are still to do.

## What's in it

### Data: Postgres on RDS

- The control box keeps users, VMs, sessions, events, usage, quotas and users'
  secrets in Postgres (RDS, `db.t4g.micro`, Postgres 17, 20 GiB gp3,
  encrypted, 7 days of backups, deletion protection). Code:
  `apps/control/src/db.ts`, with one schema for Postgres and SQLite through
  `Bun.SQL`; local development and tests still use SQLite.
- The database sits in two subnets of its own that route nowhere, and its
  security group only lets the control box in.
- The control box signs in with IAM (a 15-minute token per connection), never a
  password. RDS keeps the master password in Secrets Manager and rotates it; the
  control box uses it once, to create its own `substrate_app` role
  (`apps/control/src/database.ts`).
- On its first start with migration 2, the control box atomically imports all
  legacy stores (owners, jobs, tasks/comparisons, Windows records, SSH access,
  and CLI grants/credentials) from the old SQLite file (`/var/lib/substrate/control.db`, left in place).

### Isolation between users (hostd)

- **Jailer.** Every VM boots under Firecracker's jailer: its own uid
  (`900000 + slot`), chrooted into `<VM dataset>/jail` with only its kernel,
  disk (a device node), config and API socket. Snapshots and forks work from
  inside the jail. Code: `apps/hostd/src/firecracker.ts`, `vmm.ts`.
- **Network namespace per VM.** The VM's TAP lives in its own namespace
  (`sbxns<slot>`), joined to the host by a veth pair. VMs can't reach each
  other, the host (except the proxy) or the metadata service. Code:
  `apps/hostd/src/network.ts`.
- **Outbound proxy with an allowlist.** A VM is either open (as before) or
  allowlisted. An allowlisted VM can't connect anywhere directly; HTTP(S) goes
  through hostd's proxy on port 3128, which knows the VM by its address, allows
  only its list (package registries, GitHub, the model APIs and anything added
  per VM: `*.example.com`, `host:port`), and only ever connects to public
  addresses. Guests pick the proxy up from the metadata service
  (`/etc/profile.d/substrate-proxy.sh`, apt). Code: `apps/hostd/src/egress.ts`,
  `packages/protocol/src/egress.ts`. Set per VM with `egress` on create or
  PATCH; the web UI doesn't offer it yet.
- **Per-user quotas.** VM count, sizes, disk per VM and in total, running hours
  per month, and whether egress is forced to the allowlist. Checked on create,
  fork, start, resume, resize and disk growth. Metering counts running time
  every minute and pauses a user's VMs once they're over their hours. Defaults
  come from `SUBSTRATE_QUOTA_*` (`apps/control/src/config.ts`); admins
  (`/substrate/admins`, Clerk user IDs) have no limits and can set anyone's with
  `PUT /api/admin/quotas/:user`.

Existing VMs change at their next cold boot: until a VM is stopped and started,
it keeps running (and resuming) as before. `SUBSTRATE_ISOLATION=none` in
hostd's environment turns jailing off for new boots.

### Secrets

- **Token rotation.** A Lambda (`substrate-rotate-tokens`) replaces
  `/substrate/hostd-token` every 30 days and keeps the old one in
  `/substrate/hostd-token-previous`. The host refreshes both every minute
  (`images/host/refresh-token.sh`) and accepts either; the control box switches
  to a new token 3 minutes after it first sees it. Nothing is refused while the
  boxes catch up.
- **Users' agent keys.** Each user can store an Anthropic and an OpenAI key.
  They're encrypted with a KMS key (`alias/substrate-user-secrets`), bound to
  that user and key name, and only ever sent into that user's VMs: the control
  box pushes them to guestd, which writes `~/.config/substrate/agent-env`
  (0600) for new sessions. The browser sees the last four characters, never the
  key. Code: `apps/control/src/secrets.ts`, `apps/guestd/src/environment.ts`.
- GitHub tokens are stored the same way.

### GitHub

- **Connect GitHub** under Account, with GitHub's OAuth (once an OAuth app is
  set up) or by pasting a fine-grained token. Code:
  `apps/control/src/github.ts`.
- **From GitHub** in Create workspace suggests the user's own repositories, and
  the clone uses their connection, so private repositories work. A token stored
  the old way (`bun run github:token`) still works until the user connects.

## Deploying

**Use the integrated code based on current `main`.** Windows, the dashboard,
workflows and CLI are reconciled there. Never deploy the original Phase 2 branch
over the integrated application. See [database-migration.md](database-migration.md)
for migration behavior and rollback limits. Then:

1. `cd infra && bunx cdk diff Substrate`. Expect only additions (database,
   subnets, KMS key, Lambda, parameters) and a changed control role policy.
   Nothing should say "may be replaced".
2. `bun run deploy:infra`. The database takes about 10 minutes.
3. Optional, for "Connect with GitHub": create a GitHub OAuth app with the
   callback URL `<dashboard URL>/api/github/callback`, then
   `bun run secrets --github-oauth` (it prints the URL and asks for the client
   ID and secret). Without it, users paste a token.
4. Optional: admins, as Clerk user IDs:
   `aws ssm put-parameter --name /substrate/admins --type String --value <ids>`.
5. `bun run deploy:host`. Installs the new hostd and the token refresh timer.
6. `bun run deploy:control`. The control box creates its database user, sets up
   the schema and copies the SQLite data over on its first start.
7. Stop and start each VM to move it into a jail.
8. To check rotation without waiting a month:
   `aws lambda invoke --function-name substrate-rotate-tokens /dev/null`, then
   confirm the dashboard still lists VMs over the next 5 minutes.

### Cost

About $20 a month on top of today, in ap-south-1: the `db.t4g.micro`
instance (about $16), 20 GiB of storage (about $3), the KMS key ($1) and the
master secret ($0.40). The Lambda and its schedule are within the free tier.

## Verified, and not yet

Verified:
- Unit tests (`bun test`): 139 pass. The control tests also pass against a real
  Postgres 17 (`TEST_DATABASE_URL`, see [development.md](development.md)).
- `scripts/check-isolation.ts` on real Firecracker 1.17 with the jailer
  (aarch64, nested KVM in a Colima VM), all 16 checks: each VM runs as its own
  uid, sees only its jail and is in its own namespace; the allowlisted VM can't
  get out directly but reaches its allowlist through the proxy; the proxy
  refuses other hosts and the metadata service; the open VM gets out directly;
  no VM reaches another or the host.
- Pausing and restoring a jailed VM from a snapshot, by hand, in the same VM.
- The Account panel and repository suggestions in a browser, against the real
  routes (fake KMS and GitHub).
- `cdk diff` against the live stack: no replacements.

Current live results are in [the integration deployment record](deployments/2026-10-24-phase2.md):
RDS IAM/TLS and bootstrap evidence, KMS, x86 jailed boots, ZFS snapshots,
pause/resume and running-state forks passed. Real Lambda invocation/token
handoff and GitHub OAuth consent still require external access/configuration.

## Integrated data stores

Tasks/comparisons, Windows records, SSH keys/tokens and CLI approvals/credentials
now use the same asynchronous `Bun.SQL` adapter as owners and jobs. No live store
opens its own SQLite connection. `bun:sqlite` is used only by the read-only legacy
importer. Local development also runs that import, preserving existing local data.

Run `bun run check:phase2:data` for live RDS IAM/TLS, migrated-store and KMS checks,
and `bun run check:phase2:host` for jailed boots, namespace/egress isolation,
ZFS snapshots, terminal restoration and forks. Both clean up their own records.
The host checker never restarts the host or hostd and never changes existing VMs.
`bun run check:phase2:data --backup` saves a protected pre-deployment RDS data
snapshot on the control box without applying migrations.

Historical verification above predates the integration. Current deployment results
are recorded in [deployments/2026-10-24-phase2.md](deployments/2026-10-24-phase2.md).
