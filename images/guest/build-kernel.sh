#!/usr/bin/env bash
# Builds the guest kernel (an uncompressed vmlinux, which Firecracker boots
# directly) and prints its path. Skips the build if this exact kernel exists.
set -euo pipefail
# Only the kernel path goes to stdout; everything else is log.
exec 3>&1 1>&2

KERNEL_VERSION=6.18.58
FIRECRACKER_VERSION=v1.17.0

here=$(cd "$(dirname "$0")" && pwd)
out=/var/lib/substrate/images/kernels
build=/var/lib/substrate/images/build/kernel
log() { echo "[build-kernel] $*"; }

# Named after the version and the config, so changing either builds a new kernel.
config_hash=$(cat "$here/kernel.fragment" <(echo "$KERNEL_VERSION $FIRECRACKER_VERSION") | sha256sum | cut -c1-12)
kernel="$out/vmlinux-${KERNEL_VERSION}-${config_hash}"
if [[ -f "$kernel" ]]; then
  log "already built: $kernel"
  echo "$kernel" >&3
  exit 0
fi

mkdir -p "$out" "$build"
cd "$build"
tarball="linux-${KERNEL_VERSION}.tar.xz"
if [[ ! -f "$tarball" ]]; then
  log "downloading linux ${KERNEL_VERSION}"
  curl -fsSL -o "$tarball" "https://cdn.kernel.org/pub/linux/kernel/v6.x/${tarball}"
  curl -fsSL -o sha256sums.asc "https://cdn.kernel.org/pub/linux/kernel/v6.x/sha256sums.asc"
  grep " ${tarball}\$" sha256sums.asc | sha256sum -c -
fi
rm -rf "linux-${KERNEL_VERSION}"
tar -xf "$tarball"
cd "linux-${KERNEL_VERSION}"

log "configuring"
curl -fsSL -o .config \
  "https://raw.githubusercontent.com/firecracker-microvm/firecracker/${FIRECRACKER_VERSION}/resources/guest_configs/microvm-kernel-ci-x86_64-6.18.config"
./scripts/kconfig/merge_config.sh -m .config "$here/kernel.fragment" >/dev/null
make olddefconfig >/dev/null

# Kconfig silently drops options whose dependencies aren't met, so check that
# everything we asked for stuck.
missing=()
while IFS= read -r line; do
  [[ "$line" =~ ^(CONFIG_[A-Z0-9_]+)=y$ ]] || continue
  grep -q "^${BASH_REMATCH[1]}=y\$" .config || missing+=("${BASH_REMATCH[1]}")
done <"$here/kernel.fragment"
if ((${#missing[@]})); then
  log "these options didn't make it into the config: ${missing[*]}"
  exit 1
fi

log "compiling (a few minutes)"
make -j"$(nproc)" vmlinux >"$build/make.log" 2>&1 || {
  tail -40 "$build/make.log"
  exit 1
}
cp vmlinux "$kernel"
cd "$build" && rm -rf "linux-${KERNEL_VERSION}"
log "built $kernel"
echo "$kernel" >&3
