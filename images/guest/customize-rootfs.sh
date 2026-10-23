#!/usr/bin/env bash
# Turns a minimal Ubuntu 24.04 tree into a Substrate VM image: Docker, Node,
# Bun, gh, the agent CLIs, a `dev` user, and the guest agent.
# Usage: customize-rootfs.sh <root dir> <substrate-guestd binary>
set -euo pipefail

root=$1
guestd=$2
NODE_VERSION=v24.22.1
BUN_VERSION=1.4.4

log() { echo "[customize-rootfs] $*"; }
in_root() { chroot "$root" /usr/bin/env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive bash -euo pipefail -c "$1"; }
as_dev() { chroot "$root" runuser -l dev -c "set -euo pipefail; $1"; }

# The chroot needs the host's /proc, /sys, /dev and DNS while installing.
mounted=()
for fs in proc sys dev dev/pts; do
  mkdir -p "$root/$fs"
  if ! mountpoint -q "$root/$fs"; then
    case $fs in
      proc) mount -t proc proc "$root/proc" ;;
      sys) mount -t sysfs sys "$root/sys" ;;
      *) mount --bind "/$fs" "$root/$fs" ;;
    esac
    mounted=("$root/$fs" "${mounted[@]}")
  fi
done
cleanup() { for m in "${mounted[@]}"; do umount -l "$m" || true; done; }
trap cleanup EXIT
rm -f "$root/etc/resolv.conf"
cp /etc/resolv.conf "$root/etc/resolv.conf"

log "adding Docker and GitHub CLI repositories"
in_root '
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" >/etc/apt/sources.list.d/docker.list
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" >/etc/apt/sources.list.d/github-cli.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin gh >/dev/null
'

log "installing Node ${NODE_VERSION} and Bun ${BUN_VERSION}"
in_root "
  cd /tmp
  curl -fsSLO https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz
  curl -fsSL https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt | grep ' node-${NODE_VERSION}-linux-x64.tar.xz\$' | sha256sum -c - >/dev/null
  tar -xJf node-${NODE_VERSION}-linux-x64.tar.xz -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
  rm node-${NODE_VERSION}-linux-x64.tar.xz
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s bun-v${BUN_VERSION} >/dev/null
"

log "creating the dev user"
in_root '
  id dev >/dev/null 2>&1 || useradd --create-home --uid 1000 --shell /bin/bash --groups sudo,docker dev
  echo "dev ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/dev
  chmod 0440 /etc/sudoers.d/dev
  echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >/etc/profile.d/substrate.sh
  echo "prefix=/home/dev/.local" >/home/dev/.npmrc
  chown dev:dev /home/dev/.npmrc
'

# Installed as dev, into ~/.local, so the CLIs can update themselves.
log "installing agent CLIs"
as_dev 'npm install --global --no-fund --no-audit @anthropic-ai/claude-code @openai/codex opencode-ai'
as_dev 'curl -fsSL https://antigravity.google/cli/install.sh | bash >/dev/null'
as_dev 'rm -rf ~/.npm ~/.cache'

log "installing the guest agent"
install -m 0755 "$guestd" "$root/usr/local/bin/substrate-guestd"
cat >"$root/etc/systemd/system/substrate-guestd.service" <<'EOF'
[Unit]
Description=Substrate guest agent
After=network.target

[Service]
ExecStart=/usr/local/bin/substrate-guestd
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF

log "configuring the system"
in_root '
  systemctl enable substrate-guestd docker containerd >/dev/null 2>&1
  # Nothing reads a console, and these only slow boot or run maintenance a VM does not need.
  systemctl mask getty@tty1.service serial-getty@ttyS0.service systemd-networkd-wait-online.service \
    apt-daily.timer apt-daily-upgrade.timer motd-news.timer e2scrub_all.timer e2scrub_reap.service \
    fstrim.timer dpkg-db-backup.timer >/dev/null 2>&1
  echo "/dev/vda / ext4 defaults,noatime,errors=remount-ro 0 1" >/etc/fstab
  echo "LANG=C.UTF-8" >/etc/default/locale
  # Each VM gets its hostname from the kernel and a fresh machine ID on first boot.
  rm -f /etc/hostname
  : >/etc/machine-id
  printf "127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n" >/etc/hosts
  passwd --lock root >/dev/null
  apt-get clean
  rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.cache /root/.bun
'
printf "nameserver 1.1.1.1\nnameserver 8.8.8.8\n" >"$root/etc/resolv.conf"

# Record what got installed, for current.json.
as_dev 'cat <<EOF
claude=$(claude --version 2>/dev/null | head -1)
codex=$(codex --version 2>/dev/null | head -1)
opencode=$(opencode --version 2>/dev/null | head -1)
agy=$(agy --version 2>/dev/null | head -1)
node=$(node --version)
bun=$(bun --version)
python=$(python3 --version | cut -d" " -f2)
docker=$(docker --version | cut -d" " -f3 | tr -d ,)
gh=$(gh --version | head -1 | cut -d" " -f3)
git=$(git --version | cut -d" " -f3)
EOF' >"$root/../tools.env"
log "done"
