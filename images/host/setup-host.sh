#!/usr/bin/env bash
# Prepares the sandbox host (Ubuntu 24.04): KVM, Firecracker, the ZFS pool on
# the data disk, and IP forwarding. Safe to run again: every step checks first.
# Run it with `bun run setup:host`.
set -euo pipefail
# SSM runs commands without HOME, which bun and its installer need.
export HOME=${HOME:-/root}

FIRECRACKER_VERSION=v1.17.0
BUN_VERSION=1.4.4
POOL=substrate

# shellcheck source=/dev/null
source /etc/substrate/host.env # SUBSTRATE_DATA_VOLUME, SUBSTRATE_BUCKET, SUBSTRATE_REGION

log() { echo "[setup-host] $*"; }

export DEBIAN_FRONTEND=noninteractive
# Ubuntu's needrestart otherwise prints a service report after every install.
export NEEDRESTART_SUSPEND=1
log "installing packages"
# Wait for apt's lock instead of failing: Ubuntu's daily updates may hold it.
apt() { apt-get -o DPkg::Lock::Timeout=300 "$@"; }
apt update -qq
apt install -y -qq zfsutils-linux nftables jq curl unzip rsync >/dev/null
# For building guest images: mmdebstrap for the rootfs, a toolchain for the kernel.
apt install -y -qq mmdebstrap e2fsprogs xz-utils build-essential flex bison bc libelf-dev libssl-dev python3 >/dev/null

if [[ "$(bun --version 2>/dev/null)" == "$BUN_VERSION" ]]; then
  log "bun ${BUN_VERSION} already installed"
else
  log "installing bun ${BUN_VERSION}"
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" >/dev/null
fi
mkdir -p /var/log/substrate

log "loading KVM"
modprobe kvm_intel || true
modprobe tun
printf 'kvm_intel\ntun\n' >/etc/modules-load.d/substrate.conf
if [[ ! -e /dev/kvm ]]; then
  log "no /dev/kvm: nested virtualization isn't on for this instance"
  exit 1
fi

if firecracker --version 2>/dev/null | grep -q "Firecracker ${FIRECRACKER_VERSION}\$"; then
  log "firecracker ${FIRECRACKER_VERSION} already installed"
else
  log "installing firecracker ${FIRECRACKER_VERSION}"
  tmp=$(mktemp -d)
  tgz="firecracker-${FIRECRACKER_VERSION}-x86_64.tgz"
  base="https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}"
  curl -fsSL -o "${tmp}/${tgz}" "${base}/${tgz}"
  curl -fsSL -o "${tmp}/${tgz}.sha256.txt" "${base}/${tgz}.sha256.txt"
  (cd "$tmp" && sha256sum -c "${tgz}.sha256.txt")
  tar -xzf "${tmp}/${tgz}" -C "$tmp"
  install -m 0755 "$(find "$tmp" -type f -name "firecracker-${FIRECRACKER_VERSION}-x86_64")" /usr/local/bin/firecracker
  install -m 0755 "$(find "$tmp" -type f -name "jailer-${FIRECRACKER_VERSION}-x86_64")" /usr/local/bin/jailer
  rm -rf "$tmp"
fi

# EBS volumes show up as NVMe devices named after the volume ID, without its dash.
# On first boot the volume may still be attaching, so wait for it.
disk="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${SUBSTRATE_DATA_VOLUME//-/}"
for _ in $(seq 1 60); do
  [[ -e "$disk" ]] && break
  log "waiting for data volume ${SUBSTRATE_DATA_VOLUME}"
  sleep 5
done
if [[ ! -e "$disk" ]]; then
  log "data volume ${SUBSTRATE_DATA_VOLUME} never attached"
  exit 1
fi

if zpool list "$POOL" >/dev/null 2>&1; then
  log "pool ${POOL} already imported"
elif zpool import -d /dev/disk/by-id 2>/dev/null | grep -q "pool: ${POOL}\$"; then
  # A replacement host finding the retained data disk.
  log "importing existing pool ${POOL}"
  zpool import -f -d /dev/disk/by-id "$POOL"
else
  log "creating pool ${POOL} on ${disk}"
  # zstd keeps memory snapshots of mostly empty RAM small.
  zpool create -o ashift=12 \
    -O compression=zstd -O atime=off -O xattr=sa -O acltype=posixacl \
    -O mountpoint=/var/lib/substrate \
    "$POOL" "$disk"
fi
for dataset in images vms; do
  zfs list "${POOL}/${dataset}" >/dev/null 2>&1 || zfs create "${POOL}/${dataset}"
done

log "enabling IP forwarding"
echo 'net.ipv4.ip_forward = 1' >/etc/sysctl.d/90-substrate.conf
sysctl -q --system
systemctl enable --now nftables >/dev/null

log "done: $(firecracker --version | head -1), /dev/kvm present, pool $(zpool list -H -o name,health,size "$POOL" | tr '\t' ' ')"
