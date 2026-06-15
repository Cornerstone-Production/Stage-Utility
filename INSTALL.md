# Installing Stage Utility on a server

Stage Utility runs as a small web/server-only app: a Node backend serves the
kiosk display, the settings UI, and a phone control panel — all on one port
(**8788**). These instructions target **Linux with systemd** (Proxmox VM/LXC,
Ubuntu/Debian, Raspberry Pi, etc.).

## Prerequisites

- **Node.js ≥ 24** (bundles `npm`). Check with `node -v`. Install via
  [nodesource](https://github.com/nodesource/distributions) or `nvm` if needed —
  the installer checks but does **not** install Node for you.
- The repo cloned onto the server, e.g. in `/opt/stage-utility/mic-display`.

## Install

From the repo root:

```bash
sudo ./scripts/install.sh
```

That single command:

1. Verifies Node ≥ 24.
2. Installs dependencies (`npm ci`) and builds the UI (`npm run build`).
3. Creates the data directory (default `/var/lib/stage-utility`) and gives it to
   the service user.
4. Writes and enables a `stage-utility` **systemd** service that starts on boot.
5. Prints the access URLs.

### Options

```bash
sudo ./scripts/install.sh --data-dir /srv/stage-utility   # custom data dir
sudo ./scripts/install.sh --user stagemon                 # run as a specific user
sudo ./scripts/install.sh --no-service                    # build only, no systemd
```

`STAGE_UTILITY_DATA=/path` works as an alternative to `--data-dir`. The service
runs as `$SUDO_USER` by default (the human who ran `sudo`).

## First-time configuration

Open the **Settings** page in a browser:

```
http://<server-ip>:8788/settings-window.html
```

Then:

1. **Integrations → Planning Center** — enter your **App ID** and **Secret**
   (from a PCO Personal Access Token at
   [api.planningcenteronline.com](https://api.planningcenteronline.com) →
   Developers → Personal Access Tokens).
2. **Integrations → Wireless Gear** *(optional)* — pick your Shure model and
   enter its IP, TCP port (usually `2202`), and channel count.
3. **Service Types**, **Plan**, and **Slots** — choose allowed service types,
   pick a plan (or Auto), and set up the slot layout.

The kiosk display is at `http://<server-ip>:8788/`. On a phone connected to the
same network, scan the QR code shown on the display (enable it under **Connect**).

## Operating the service

```bash
systemctl status stage-utility       # is it running?
journalctl -u stage-utility -f       # tail logs
sudo systemctl restart stage-utility # restart
```

Open TCP **8788** to your LAN in the firewall if it isn't already, e.g.:

```bash
sudo ufw allow from 192.168.0.0/16 to any port 8788 proto tcp
```

## Updating

```bash
cd /opt/stage-utility/mic-display
git pull
sudo ./scripts/install.sh    # re-installs deps, rebuilds, restarts
```

## Backups

Back up the **data directory** (`/var/lib/stage-utility` by default). It holds
all configuration, the **encrypted secrets**, and `encryption.key`. If you lose
`encryption.key`, you'll have to re-enter every credential.

## Uninstall

```bash
sudo ./scripts/uninstall.sh
```

This stops and removes the service but **leaves the data directory intact** (its
path is printed) so you can back it up or delete it deliberately.
