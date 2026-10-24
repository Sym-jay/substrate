# Desktops and SSH for Linux workspaces

Two ways into a microVM besides its browser terminals: its desktop, in the
browser, and SSH with your own keys.

## Desktop

A workspace's **Desktop** tab is on when something answers VNC on port 5900
of the VM, and off (greyed out, saying why) when nothing does. hostd checks by
connecting to the port, every few seconds while the tab's workspace is open.

Workspaces don't come with a desktop. **Set one up** under the tabs installs a
light one in the background:
- a virtual display, Xvfb, at 1600×900;
- Openbox with a tint2 panel, and a terminal;
- x11vnc.

It runs as `dev` and starts with the VM from then on. It takes a minute or
two; the tab says "setting up" meanwhile.
- **How it's installed:** hostd runs `apps/hostd/src/desktop-setup.sh` in the
  guest (through guest exec, as root, under `systemd-run`). That works on
  existing VMs, with no new image.
- **Using your own:** any VNC server you run on port 5900 works the same way
  instead.

The browser reaches it like a terminal: a one-time ticket, then the control
box and hostd relay the WebSocket to the VM's port 5900, and noVNC draws it.
- **No VNC password:** the VM's address is reachable only from the host, which
  relays it only to the VM's owner.
- **Auto-pause:** using the desktop counts as activity, so it holds off.

| | Route |
|---|---|
| State | `GET /api/vms/:id/gui` → `{ state: ready \| off \| setting-up \| failed \| unavailable, available }` |
| Set one up | `POST /api/vms/:id/gui/setup` |
| VNC | `POST /api/vms/:id/gui/ticket`, then WebSocket `/api/vms/:id/gui/vnc?ticket=` |

## SSH with your own keys

**SSH access** (in the web app) has three parts:

1. **Your public keys.**
   - Every workspace of yours trusts them, as `dev`.
   - hostd keeps them in their own block of `~/.ssh/authorized_keys`
     (`# substrate:begin` … `# substrate:end`), so keys added by hand stay.
   - Adding or removing a key updates your running workspaces at once; others
     get it when you next connect.
2. **A token for each computer.**
   - It lets the SSH proxy reach your workspaces through the control box.
   - It's shown once, and only its hash is kept. It's revocable, and shows
     when it was last used.
   - It goes in `~/.substrate/config.json` as `{"url": "…", "token": "sbs_…"}`.
3. **The proxy:** `curl -fsSL <url>/ssh-proxy.mjs -o ~/.substrate/ssh-proxy.mjs`
   (Node 22+ or Bun), and in `~/.ssh/config`:

   ```
   Host *.substrate
     User dev
     ProxyCommand node ~/.substrate/ssh-proxy.mjs %h
     ServerAliveInterval 30
   ```

Then `ssh my-workspace.substrate`, or the same host in VS Code Remote-SSH.

When you connect, the proxy opens a WebSocket to
`/api/ssh/connect/<name or id>` and sends the token as its first message (so
it's never in a URL). The control box then:
1. finds the workspace among yours;
2. has hostd start or resume it;
3. puts your account's keys on it;
4. relays SSH's bytes to the VM's sshd.

SSH itself runs end to end between your client and the VM. Nothing is opened
to the internet.

Close codes the proxy explains:
- **4401:** bad or revoked token.
- **4404:** no such workspace of yours.
- **4409:** no keys on your account.

The older per-workspace connection file (`POST /api/vms/:id/ssh/access`, for
`scripts/ssh-proxy.ts`) still works.
