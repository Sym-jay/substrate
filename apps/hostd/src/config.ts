// Set by `bun build --define` in images/host/install-hostd.sh.
declare const BUILD_VERSION: string | undefined

const root = process.env.SUBSTRATE_ROOT ?? '/var/lib/substrate'

export const config = {
  port: Number(process.env.PORT ?? 7070),
  version: typeof BUILD_VERSION === 'string' ? BUILD_VERSION : 'dev',
  pool: 'substrate',
  firecracker: '/usr/local/bin/firecracker',
  // ExecStop for VM units; installed by images/host/install-hostd.sh.
  vmStop: '/usr/local/lib/substrate/vm-stop',
  // Kept back from VMs for the host itself, ZFS and Firecracker overhead.
  memReserveMib: 4_096,
  // How long a VM may take from launch to its guest agent answering.
  bootTimeoutMs: 60_000,
  memory: { floorMib: 4096, pollMs: 2000, reclaimAfterMs: 30_000 },
  // Agent alerts and auto-pause notices go to this ntfy topic (`bun run
  // secrets --ntfy`). Without one they're only logged.
  ntfy: process.env.SUBSTRATE_NTFY_TOPIC
    ? { server: process.env.SUBSTRATE_NTFY_SERVER ?? 'https://ntfy.sh', topic: process.env.SUBSTRATE_NTFY_TOPIC }
    : null,
  // The web app, so tapping an alert opens the VM.
  publicUrl: process.env.SUBSTRATE_PUBLIC_URL || null,
  autoPause: {
    // How often hostd asks each running VM's guest agent what it's been doing.
    pollMs: 5_000,
    // No agent alerts while someone typed in the VM this recently: they're watching.
    quietMs: 120_000,
  },
  paths: {
    root,
    token: `${root}/hostd-token`,
    image: `${root}/images/current.json`,
    vms: `${root}/vms`,
    run: '/run/substrate',
  },
}
