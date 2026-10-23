#!/bin/sh
# ExecStop for each VM's systemd unit: ask the guest agent to reboot the
# guest, which shuts it down cleanly and then (with `reboot=k` on the kernel
# command line) ends Firecracker. Wait for that; systemd only kills
# Firecracker if this times out or the guest agent can't be reached.
# (Firecracker's SendCtrlAltDel can't be used: the 6.18 guest kernel doesn't
# detect its emulated i8042.)
# Usage: vm-stop <the VM's metadata.json>
ip=$(jq -r .substrate.guestIp "$1") || exit 0
token=$(jq -r .substrate.token "$1") || exit 0
curl -fs --max-time 3 -H "Authorization: Bearer ${token}" -H 'content-type: application/json' \
  -d '{"command":"systemctl --no-block reboot","user":"root","timeoutMs":5000}' \
  "http://${ip}:7000/exec" >/dev/null || exit 0
# systemd sets MAINPID for ExecStop.
for _ in $(seq 280); do
  kill -0 "$MAINPID" 2>/dev/null || exit 0
  sleep 0.1
done
