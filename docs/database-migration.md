# Shared control database migration

The CLI integration and migration 2 use one `Bun.SQL` connection pool: Postgres
with IAM/TLS on the control box, SQLite for local development. Tasks, comparisons,
Windows workspace records, SSH keys/tokens and CLI devices/credentials now join
the existing users, VM owners, jobs, usage, quotas, events and encrypted secrets.

The new tables have separate names from legacy tables. Tasks use explicit
`created_at`, `active` and `reviewed_at` columns, avoiding SQLite JSON queries in
Postgres and preventing an in-flight task refresh from undoing a review action.
Comparison selection, task output, Windows instance/password fields, SSH hashes,
CLI hashes, expiry and pending browser approvals are retained.

At startup, schema migration 2 runs, then the importer reads a consistent snapshot
of the legacy SQLite file. It copies all supported records in one destination
transaction and commits a `database_imports` marker with the data. A nonempty VM
table does not skip the import: the previous deployment already imported owners
and jobs. Existing destination rows remain authoritative. Failure rolls back the
whole import and its marker, so the next startup can retry after the cause is
fixed. Normal requests are not served until startup completes.

Legacy tables remain intact. If a local SQLite installation already completed
this migration before switching to RDS, only its normalized tables are copied;
stale legacy tables cannot resurrect revoked credentials or deleted records.
On subsequent starts, the destination marker prevents any import replay.

No login approval is needed just to migrate an existing CLI credential. CLI and
SSH tokens remain separate and owner-scoped. CLI approval uses a conditional
update, and redemption locks its device record in a transaction, allowing only
one winner. Store locks serialize bounded credential/key creation on both
adapters.

Before deployment:

```sh
bun run typecheck
bun test
TEST_DATABASE_URL=postgres://localhost/postgres bun test apps/control/src apps/cli/test
bun run check:phase2:data --backup
```

Use a local disposable Postgres database for `TEST_DATABASE_URL`, never production.
Each test gets a separate schema. The backup command uses the control instance
role and writes a 0600 JSON snapshot under `/var/lib/substrate/backups`; it does
not download data or print it. Also back up the legacy SQLite file using SQLite's
backup API, so committed WAL records are included.

After deployment:

```sh
bun run check:phase2:data
bun run check:phase2:host
```

Compare row counts with the baseline, verify a preexisting CLI login, and restart
the control service to check migration idempotency. The data checker uses only a
synthetic acceptance owner, makes no EC2 Windows instances or model API calls,
and removes its records. The host checker makes and deletes its own Linux VMs.

Rolling back the executable does not copy newer Postgres changes back into legacy
SQLite. An old SQLite-backed CLI build would read stale grants, task results and
Windows/SSH records, including previously revoked tokens. Prefer a forward fix
or a release that retains the shared stores. Keep backups for data recovery;
do not clear the import marker to try to roll back.
