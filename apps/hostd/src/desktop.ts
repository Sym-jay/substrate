/// <reference path="./text.d.ts" />
import type { VmGuiState } from '@substrate/protocol'
import { connect } from 'node:net'
import setupScript from './desktop-setup.sh' with { type: 'text' }

// A VM's desktop is whatever answers VNC on this port of its own address:
// the one desktop-setup.sh installs, or one the owner set up themselves.
export const VNC_PORT = 5900

// Whether something accepts connections on host:port, within `timeoutMs`.
export function probe(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (open: boolean) => { socket.destroy(); resolve(open) }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

// Run in the guest as root. Prints off, setting-up or failed.
export const desktopStateCommand = [
  'if systemctl is-active --quiet substrate-desktop-setup.service; then echo setting-up',
  'elif [ -f /var/lib/substrate-desktop/failed ]; then echo failed',
  'else echo off; fi',
].join('; ')

export const parseDesktopState = (stdout: string): VmGuiState => {
  const state = stdout.trim()
  return state === 'setting-up' || state === 'failed' ? state : 'off'
}

// Starts desktop-setup.sh in the background, so it outlives the request.
export function desktopSetupCommand() {
  const encoded = Buffer.from(setupScript).toString('base64')
  return [
    'set -e',
    'mkdir -p /var/lib/substrate-desktop',
    `printf %s '${encoded}' | base64 -d >/var/lib/substrate-desktop/setup.sh`,
    'systemctl reset-failed substrate-desktop-setup.service 2>/dev/null || true',
    'systemd-run --unit=substrate-desktop-setup --collect --quiet bash /var/lib/substrate-desktop/setup.sh',
  ].join('\n')
}

// Makes these the keys in dev's authorized_keys that came from the owner's
// account, between marker lines, leaving any others (added by hand, or one
// workspace's own) as they are.
export function sshSyncCommand(publicKeys: string[]) {
  const block = publicKeys.length ? ['# substrate:begin (keys from your Substrate account)', ...publicKeys, '# substrate:end'].join('\n') + '\n' : ''
  const encoded = Buffer.from(block).toString('base64')
  return [
    'set -e',
    'install -d -m 700 -o dev -g dev /home/dev/.ssh',
    'f=/home/dev/.ssh/authorized_keys',
    'touch "$f"',
    `{ sed '/^# substrate:begin/,/^# substrate:end$/d' "$f"; printf %s '${encoded}' | base64 -d; } >"$f.tmp"`,
    'mv "$f.tmp" "$f"',
    'chown dev:dev "$f"',
    'chmod 600 "$f"',
    'systemctl start ssh',
  ].join('\n')
}
