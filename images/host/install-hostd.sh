#!/usr/bin/env bash
# Installs hostd from the source tarball `bun run deploy:host` uploaded, and
# builds the guest agent that the next image build bakes into VMs.
# Usage: install-hostd.sh <src.tar.gz>
set -euo pipefail
# SSM runs commands without HOME, which bun and its installer need.
export HOME=${HOME:-/root}

src_tarball=$1
log() { echo "[install-hostd] $*"; }

release="/opt/substrate/hostd/releases/$(date +%Y%m%d%H%M%S)"
mkdir -p "$release"
tar -xzf "$src_tarball" -C "$release"
version=$(cat "$release/VERSION")
cd "$release"

log "building ${version}"
bun install --silent
define="BUILD_VERSION=\"${version}\""
bun build --compile --minify --define "$define" apps/hostd/src/index.ts --outfile bin/substrate-hostd >/dev/null
bun build --compile --minify --define "$define" apps/guestd/src/index.ts --outfile bin/substrate-guestd >/dev/null

# hostd's token comes from Parameter Store (`bun run secrets`), so the control
# box can share it. Without one, hostd generates its own and only this host knows it.
# shellcheck source=/dev/null
source /etc/substrate/host.env # SUBSTRATE_REGION
if token=$(aws ssm get-parameter --region "$SUBSTRATE_REGION" --name /substrate/hostd-token --with-decryption --query Parameter.Value --output text 2>/dev/null); then
  mkdir -p /var/lib/substrate
  (umask 077 && printf %s "$token" >/var/lib/substrate/hostd-token)
  log "hostd token from Parameter Store"
else
  log "no /substrate/hostd-token in Parameter Store (run \`bun run secrets\`): the control box can't reach hostd"
fi

# Settings hostd reads at start. SUBSTRATE_PUBLIC_URL comes from deploy-host.ts.
{
  echo "SUBSTRATE_PUBLIC_URL=${SUBSTRATE_PUBLIC_URL:-}"
  if topic=$(aws ssm get-parameter --region "$SUBSTRATE_REGION" --name /substrate/ntfy-topic --with-decryption --query Parameter.Value --output text 2>/dev/null); then
    echo "SUBSTRATE_NTFY_TOPIC=${topic}"
    log "alerts go to the ntfy topic in Parameter Store" >&2
  else
    log "no /substrate/ntfy-topic in Parameter Store (run \`bun run secrets --ntfy\`): alerts only go to hostd's log" >&2
  fi
  # VMs to keep booted ahead of time (apps/hostd/src/warm-pool.ts has the
  # format). Without the parameter, hostd keeps one of the default size.
  if pool=$(aws ssm get-parameter --region "$SUBSTRATE_REGION" --name /substrate/warm-pool --query Parameter.Value --output text 2>/dev/null); then
    echo "SUBSTRATE_WARM_POOL=${pool}"
    log "warm pool from Parameter Store: ${pool}" >&2
  fi
} | (umask 077 && cat >/etc/substrate/hostd.env)

ln -sfn "$release" /opt/substrate/hostd/current
# At a fixed path, because running VM units refer to it.
install -D -m 0755 "$release/images/host/vm-stop.sh" /usr/local/lib/substrate/vm-stop
# hostd's tokens follow Parameter Store, where they're rotated (Phase 2).
install -D -m 0755 "$release/images/host/refresh-token.sh" /usr/local/lib/substrate/refresh-token
cat >/etc/systemd/system/substrate-token-refresh.service <<'EOF'
[Unit]
Description=Substrate: hostd's tokens from Parameter Store

[Service]
Type=oneshot
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
ExecStart=/usr/local/lib/substrate/refresh-token
EOF
cat >/etc/systemd/system/substrate-token-refresh.timer <<'EOF'
[Unit]
Description=Substrate: hostd's tokens from Parameter Store, every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now substrate-token-refresh.timer >/dev/null 2>&1
# Keep the three newest releases.
ls -1dt /opt/substrate/hostd/releases/* | tail -n +4 | xargs -r rm -rf

cat >/etc/systemd/system/substrate-hostd.service <<'EOF'
[Unit]
Description=Substrate host daemon
After=network-online.target zfs.target nftables.service
Wants=network-online.target

[Service]
ExecStart=/opt/substrate/hostd/current/bin/substrate-hostd
EnvironmentFile=-/etc/substrate/hostd.env
Restart=always
RestartSec=2
# VMs live in their own systemd units, so stopping hostd leaves them running.
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable substrate-hostd >/dev/null 2>&1
systemctl restart substrate-hostd

token=$(cat /var/lib/substrate/hostd-token 2>/dev/null || true)
for _ in $(seq 1 30); do
  token=${token:-$(cat /var/lib/substrate/hostd-token 2>/dev/null || true)}
  if [[ -n "$token" ]] && health=$(curl -fsS -H "Authorization: Bearer ${token}" http://127.0.0.1:7070/health 2>/dev/null); then
    log "healthy: ${health}"
    exit 0
  fi
  sleep 1
done
log "substrate-hostd didn't become healthy"
journalctl -u substrate-hostd -n 30 --no-pager
exit 1
