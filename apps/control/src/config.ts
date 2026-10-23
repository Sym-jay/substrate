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
