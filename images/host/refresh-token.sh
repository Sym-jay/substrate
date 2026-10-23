#!/bin/bash
# Keeps hostd's tokens in step with Parameter Store, where a scheduled job
# rotates /substrate/hostd-token and keeps the one before it in
# /substrate/hostd-token-previous. hostd accepts both (apps/hostd/src/tokens.ts).
# Run every minute by substrate-token-refresh.timer (install-hostd.sh).
set -euo pipefail
# shellcheck source=/dev/null
source /etc/substrate/host.env # SUBSTRATE_REGION
get() { aws ssm get-parameter --region "$SUBSTRATE_REGION" --name "$1" --with-decryption --query Parameter.Value --output text 2>/dev/null; }
put() {
  [ "$(cat "$1" 2>/dev/null)" = "$2" ] && return 0
  (umask 077 && printf %s "$2" >"$1.tmp") && mv "$1.tmp" "$1"
}
if current=$(get /substrate/hostd-token); then put /var/lib/substrate/hostd-token "$current"; fi
if previous=$(get /substrate/hostd-token-previous); then put /var/lib/substrate/hostd-token.previous "$previous"; fi
