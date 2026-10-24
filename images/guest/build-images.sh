#!/usr/bin/env bash
# Builds the guest kernel (if it changed) and a new root filesystem, then makes
# them the image new VMs get. Existing VMs keep the image they were made from.
# Full output goes to /var/log/substrate/; this prints progress only.
# Usage: build-images.sh [substrate-guestd binary]
set -euo pipefail
# SSM runs commands without HOME, which bun and its installer need.
export HOME=${HOME:-/root}

# Keep the source symlink stable for the whole build and prevent benchmarks
# from mixing guest image generations. All callers share these locks.
exec 9>/run/lock/substrate-host-deploy.lock
flock -n 9 || { echo '[build-images] host deployment or benchmark is active'; exit 1; }
exec 8>/run/lock/substrate-image-build.lock
flock -n 8 || { echo '[build-images] another image build is active'; exit 1; }

here=$(cd "$(dirname "$0")" && pwd)
guestd=${1:-/opt/substrate/hostd/current/bin/substrate-guestd}
version=$(date -u +%Y%m%d-%H%M%S)
images=/var/lib/substrate/images
logfile="/var/log/substrate/build-images-${version}.log"
mkdir -p /var/log/substrate

step() { echo "[build-images] $*" | tee -a "$logfile"; }
on_error() {
  echo "[build-images] failed. Last lines of ${logfile}:"
  tail -60 "$logfile"
}
trap on_error ERR

if [[ ! -x "$guestd" ]]; then
  echo "[build-images] no guest agent at ${guestd}: run \`bun run deploy:host\` first"
  exit 1
fi

# A failed build leaves its tree behind; nothing else uses these.
rm -rf "${images}/build/rootfs-"*

step "image ${version}"
step "kernel (a few minutes if it changed)"
kernel=$(bash "$here/build-kernel.sh" 2>>"$logfile")
step "kernel: ${kernel}"

step "root filesystem (about 10 minutes)"
rootfs=$(bash "$here/build-rootfs.sh" "$version" "$guestd" 2>>"$logfile")
step "root filesystem: ${rootfs}"

tools="${images}/build/rootfs-${version}/tools.env"
jq -n \
  --arg version "$version" \
  --arg rootfs "$rootfs" \
  --arg kernel "$kernel" \
  --arg builtAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --rawfile tools "$tools" \
  '{version: $version, rootfs: $rootfs, kernel: $kernel, builtAt: $builtAt,
    tools: ($tools | split("\n") | map(select(test("=")) | split("=") | {(.[0]): (.[1:] | join("="))}) | add)}' \
  >"${images}/current.json.tmp"
mv "${images}/current.json.tmp" "${images}/current.json"
rm -rf "${images}/build/rootfs-${version}"

# Old images fill the storage pool VMs share (1.5 GB each). Keep the newest two,
# so the previous one is there to go back to, and any a VM's disk is still a
# clone of: `zfs destroy` refuses those without -R.
for old in $(zfs list -H -o name -s creation -d 1 substrate/images | grep '/rootfs-' | head -n -2); do
  if zfs destroy -r "$old" 2>/dev/null; then
    step "removed old image ${old##*/rootfs-}"
  fi
done

step "done: new VMs get image ${version}"
sed 's/^/  /' <(jq -r '.tools | to_entries[] | "\(.key) \(.value)"' "${images}/current.json")
