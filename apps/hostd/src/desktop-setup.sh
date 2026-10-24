#!/bin/bash
# Gives a workspace a desktop for the web app's Desktop view. hostd runs this
# in the guest, as root, in the background (systemd-run), when the owner asks
# for one. It installs a virtual display (Xvfb), Openbox with a panel and a
# terminal, and x11vnc on port 5900 of the VM's own address. Only the host
# can reach that address; it relays it to the VM's owner. The desktop then
# starts with the VM, as dev.
set -euo pipefail
state=/var/lib/substrate-desktop
mkdir -p "$state"
rm -f "$state/failed"
trap 'touch "$state/failed"' ERR

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends xvfb x11vnc openbox tint2 xterm x11-xserver-utils fonts-dejavu-core >/dev/null

cat >/usr/local/bin/substrate-desktop-session <<'EOF'
#!/bin/bash
# The desktop session: display :1, Openbox and its panel, a terminal, and VNC.
set -u
Xvfb :1 -screen 0 1600x900x24 -nolisten tcp &
for _ in $(seq 1 50); do [ -S /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
export DISPLAY=:1
xsetroot -solid '#1e2025'
openbox &
tint2 &
(cd ~ && exec xterm -geometry 110x32+60+60 -fa 'DejaVu Sans Mono' -fs 11) &
exec x11vnc -display :1 -rfbport 5900 -forever -shared -nopw -quiet -noxdamage -noxrecord
EOF
chmod 755 /usr/local/bin/substrate-desktop-session

cat >/etc/systemd/system/substrate-desktop.service <<'EOF'
[Unit]
Description=Substrate desktop (Xvfb, Openbox, x11vnc on port 5900)
After=network-online.target

[Service]
User=dev
WorkingDirectory=/home/dev
ExecStart=/usr/local/bin/substrate-desktop-session
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now substrate-desktop.service
