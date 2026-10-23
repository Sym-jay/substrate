#!/usr/bin/env bash
# Builds the VM root filesystem into a new ZFS volume, snapshots it, and
# prints the snapshot name. Each VM's disk is a clone of that snapshot.
# Usage: build-rootfs.sh <version> <substrate-guestd binary>
set -euo pipefail
# Only the snapshot name goes to stdout; everything else is log.
exec 3>&1 1>&2

version=$1
guestd=$2
POOL=substrate
SIZE_GIB=8
MIRROR=http://ap-south-1.ec2.archive.ubuntu.com/ubuntu

here=$(cd "$(dirname "$0")" && pwd)
build="/var/lib/substrate/images/build/rootfs-${version}"
volume="${POOL}/images/rootfs-${version}"
log() { echo "[build-rootfs] $*"; }

log "bootstrapping Ubuntu 24.04"
mkdir -p "$build"
mmdebstrap --mode=root --variant=minbase \
  --include="$(grep -v '^#' "$here/packages.txt" | paste -sd, -)" \
  noble "$build/root" \
  "deb ${MIRROR} noble main universe" \
  "deb ${MIRROR} noble-updates main universe" \
  "deb http://security.ubuntu.com/ubuntu noble-security main universe"

bash "$here/customize-rootfs.sh" "$build/root" "$guestd"

used_gib=$(($(du -sk "$build/root" | cut -f1) / 1024 / 1024))
log "root filesystem is about ${used_gib} GiB"
if ((used_gib > SIZE_GIB - 1)); then
  log "too big for the ${SIZE_GIB} GiB image; raise SIZE_GIB"
  exit 1
fi

log "writing ${volume}"
zfs create -s -V "${SIZE_GIB}G" "$volume"
# Until it's snapshotted, a half-written volume is useless: drop it on failure.
mnt=$(mktemp -d)
trap 'umount "$mnt" 2>/dev/null || true; zfs destroy -r "$volume" 2>/dev/null || true' ERR
device="/dev/zvol/${volume}"
udevadm settle
for _ in $(seq 1 100); do [[ -e "$device" ]] && break; sleep 0.1; done
mkfs.ext4 -q -L substrate-root "$device"
mount "$device" "$mnt"
rsync -aHAX --numeric-ids "$build/root/" "$mnt/"
umount "$mnt"
rmdir "$mnt"
zfs snapshot "${volume}@base"
trap - ERR

echo "${volume}@base" >&3
