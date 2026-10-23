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
  paths: {
    root,
    token: `${root}/hostd-token`,
    image: `${root}/images/current.json`,
    vms: `${root}/vms`,
    run: '/run/substrate',
  },
}
