import { dirname, join } from 'node:path'

// Set by `bun build --define` in scripts/deploy-control.ts.
declare const BUILD_VERSION: string | undefined

const list = (value: string | undefined) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)

export const config = {
  port: Number(process.env.PORT ?? 8080),
  region: process.env.AWS_REGION ?? 'ap-south-1',
  // Unset in local development, where there is no sandbox host.
  hostInstanceId: process.env.SUBSTRATE_HOST_INSTANCE_ID || null,
  // hostd on the host's private IP, and its token. On the control box,
  // setup-control.sh writes both from Parameter Store; `bun run dev --host`
  // points them at an SSM tunnel.
  hostd:
    process.env.SUBSTRATE_HOSTD_URL && process.env.SUBSTRATE_HOSTD_TOKEN
      ? { url: process.env.SUBSTRATE_HOSTD_URL, token: process.env.SUBSTRATE_HOSTD_TOKEN }
      : null,
  // Clerk sign-in. On the control box, setup-control.sh writes both keys from
  // Parameter Store (`bun run secrets --clerk` puts them there).
  clerk:
    process.env.CLERK_SECRET_KEY && process.env.CLERK_PUBLISHABLE_KEY
      ? { secretKey: process.env.CLERK_SECRET_KEY, publishableKey: process.env.CLERK_PUBLISHABLE_KEY }
      : null,
  // Without Clerk keys, VM routes would hand anyone a shell, so they only work
  // where this says the control API isn't public: `bun run dev --host` sets it
  // when it has no Clerk keys, and the control box never does.
  vmsWithoutLogin: process.env.SUBSTRATE_VMS_WITHOUT_LOGIN === '1',
  // Optional: frontend origins whose session tokens to accept.
  authorizedParties: list(process.env.SUBSTRATE_ORIGINS),
  // Optional: only these verified emails may sign in. Empty lets anyone in.
  allowedEmails: list(process.env.SUBSTRATE_ALLOWED_EMAILS),
  maxVmsPerUser: Number(process.env.SUBSTRATE_MAX_VMS_PER_USER ?? 3),
  // Phase 2. Everyone's limits, unless an admin set their own (PUT
  // /api/admin/quotas/:user). Admins have none unless one is set for them.
  quota: {
    maxVms: Number(process.env.SUBSTRATE_MAX_VMS_PER_USER ?? 3),
    sizes: list(process.env.SUBSTRATE_QUOTA_SIZES ?? 'small,medium,large') as ('small' | 'medium' | 'large')[],
    maxDiskGib: Number(process.env.SUBSTRATE_QUOTA_MAX_DISK_GIB ?? 128),
    maxTotalDiskGib: Number(process.env.SUBSTRATE_QUOTA_MAX_TOTAL_DISK_GIB ?? 256),
    maxRunningHours: Number(process.env.SUBSTRATE_QUOTA_RUNNING_HOURS ?? 200),
    egress: (process.env.SUBSTRATE_QUOTA_EGRESS === 'allowlist' ? 'allowlist' : 'open') as 'open' | 'allowlist',
  },
  admins: list(process.env.SUBSTRATE_ADMINS),
  // Postgres on RDS, once setup-control.sh found it (Parameter Store's
  // /substrate/database). Without it, the SQLite file at `db`.
  database: process.env.SUBSTRATE_DATABASE_HOST
    ? {
        hostname: process.env.SUBSTRATE_DATABASE_HOST,
        port: Number(process.env.SUBSTRATE_DATABASE_PORT ?? 5432),
        database: process.env.SUBSTRATE_DATABASE_NAME ?? 'substrate',
        // Signs in with IAM (a 15-minute token per connection), never a password.
        username: process.env.SUBSTRATE_DATABASE_USER ?? 'substrate_app',
        // RDS's own master credentials (rotated by RDS), only to create that user once.
        masterSecretArn: process.env.SUBSTRATE_DATABASE_MASTER_SECRET || null,
        caFile: process.env.SUBSTRATE_DATABASE_CA || null,
      }
    : null,
  // Encrypts users' agent keys and GitHub tokens. Without it, those are off.
  kmsKeyId: process.env.SUBSTRATE_KMS_KEY || null,
  publicUrl: process.env.SUBSTRATE_PUBLIC_URL || null,
  // A GitHub OAuth app, for "Connect with GitHub" (docs/phase2.md).
  githubOAuth:
    process.env.SUBSTRATE_GITHUB_CLIENT_ID && process.env.SUBSTRATE_GITHUB_CLIENT_SECRET
      ? { clientId: process.env.SUBSTRATE_GITHUB_CLIENT_ID, clientSecret: process.env.SUBSTRATE_GITHUB_CLIENT_SECRET }
      : null,
  // Who owns which VM (SQLite).
  db: process.env.SUBSTRATE_DB ?? '.data/control.db',
  previewOrigin: process.env.SUBSTRATE_PREVIEW_ORIGIN || null,
  // Windows workspaces (M9): on once setup-control.sh has found their subnet
  // (Parameter Store's /substrate/windows-subnet, from the stack).
  windows: process.env.SUBSTRATE_WINDOWS_SUBNET
    ? {
        subnetId: process.env.SUBSTRATE_WINDOWS_SUBNET,
        instanceType: process.env.SUBSTRATE_WINDOWS_INSTANCE_TYPE ?? 'm8i.4xlarge',
        launchTemplate: 'substrate-windows',
        imageParameter: '/substrate/windows-ami',
        // The account's 64 vCPUs also run the host (32) and the control box.
        maxRunning: Number(process.env.SUBSTRATE_MAX_WINDOWS_RUNNING ?? 1),
        maxPerUser: Number(process.env.SUBSTRATE_MAX_WINDOWS_PER_USER ?? 2),
        idleStopMinutes: Number(process.env.SUBSTRATE_WINDOWS_IDLE_STOP_MINUTES ?? 30),
        // The control box's SSH key for them, and their host keys.
        sshDir: join(dirname(process.env.SUBSTRATE_DB ?? '.data/control.db'), 'windows'),
      }
    : null,
  // The built web app, relative to the working directory.
  webDir: process.env.SUBSTRATE_WEB_DIR ?? 'web',
  version: typeof BUILD_VERSION === 'string' ? BUILD_VERSION : 'dev',
}
