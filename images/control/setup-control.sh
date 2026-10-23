#!/usr/bin/env bash
# Prepares the control box (Amazon Linux 2023) and installs the latest
# control bundle from S3. Safe to run again. Run it with `bun run deploy:control`.
set -euo pipefail

# shellcheck source=/dev/null
source /etc/substrate/control.env # AWS_REGION, PORT, SUBSTRATE_BUCKET, SUBSTRATE_HOST_INSTANCE_ID

log() { echo "[setup-control] $*"; }

id substrate >/dev/null 2>&1 || useradd --system --home-dir /var/lib/substrate --shell /sbin/nologin substrate
install -d -o substrate -g substrate /var/lib/substrate
install -d /opt/substrate/releases

cat >/etc/systemd/system/substrate-control.service <<'EOF'
[Unit]
Description=Substrate control API and web UI
After=network-online.target
Wants=network-online.target

[Service]
User=substrate
EnvironmentFile=/etc/substrate/control.env
Environment=HOME=/var/lib/substrate
WorkingDirectory=/opt/substrate/control
ExecStart=/opt/substrate/control/substrate-control
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/substrate

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable substrate-control >/dev/null 2>&1

# Unpack each release into its own folder, then switch a symlink to it, so the
# running service never sees a half-written bundle.
if aws s3 cp --quiet "s3://${SUBSTRATE_BUCKET}/control/control.tar.gz" /tmp/control.tar.gz; then
  release="/opt/substrate/releases/$(date +%Y%m%d%H%M%S)"
  mkdir -p "$release"
  tar -xzf /tmp/control.tar.gz -C "$release"
  rm -f /tmp/control.tar.gz
  ln -sfn "$release" /opt/substrate/control
  log "installed $(cat "$release/VERSION")"
  # Keep the three newest releases.
  ls -1dt /opt/substrate/releases/* | tail -n +4 | xargs -r rm -rf
else
  log "no control bundle in s3://${SUBSTRATE_BUCKET}/control/ yet"
  exit 0
fi

systemctl restart substrate-control
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    log "healthy: $(curl -fsS "http://localhost:${PORT}/api/health")"
    exit 0
  fi
  sleep 1
done
log "substrate-control didn't become healthy"
journalctl -u substrate-control -n 30 --no-pager
exit 1
