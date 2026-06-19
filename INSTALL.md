# Installing Stage Utility

Stage Utility is a web/server-only app: a small Node backend serves the kiosk
display, the settings UI, and a phone control panel — all on one port (**8788**).
There is no desktop/Electron runtime, so it runs anywhere Node runs.

**It installs on Linux, macOS, and Windows.** The only platform-specific part is
how you make it **auto-start on boot and restart if it crashes** — this guide
covers all three:

- [Linux (systemd)](#linux-systemd) — one-command installer; recommended for Raspberry Pi / servers.
- [macOS (launchd)](#macos-launchd)
- [Windows (NSSM service or Task Scheduler)](#windows)

On every platform the app itself is identical; only the auto-start wrapper differs.

## Prerequisites (all platforms)

- **Node.js ≥ 24** (bundles `npm`). Check with `node -v`. None of the install
  steps install Node for you.
  - Linux: [nodesource](https://github.com/nodesource/distributions) or `nvm`.
  - macOS: [nodejs.org](https://nodejs.org) installer or `brew install node`.
  - Windows: [nodejs.org](https://nodejs.org) installer (includes npm).
- **git**, and the repo cloned onto the machine.

The server stores all config in a **data directory** outside the repo
(`$STAGE_UTILITY_DATA` if set, otherwise `~/.stage-utility` —
`C:\Users\<you>\.stage-utility` on Windows), so updates never touch your config.

> **Port:** the server listens on `8788` by default. Override with the
> `STAGE_UTILITY_PORT` environment variable if needed (e.g. behind a reverse
> proxy). Make sure your firewall allows inbound TCP on that port from the LAN.

---

## Linux (systemd)

The one-command installer targets Linux with systemd (Proxmox VM/LXC,
Ubuntu/Debian, Raspberry Pi, …). From the repo root:

```bash
sudo ./scripts/install.sh
```

That single command:

1. Verifies Node ≥ 24.
2. Installs dependencies (`npm ci`) and builds the UI (`npm run build`).
3. Creates the data directory (default `/var/lib/stage-utility`) owned by the service user.
4. Writes and enables a `stage-utility` **systemd** service that **starts on boot
   and restarts on crash** (`Restart=on-failure`, `RestartSec=5`).
5. Prints the access URLs.

### Options

```bash
sudo ./scripts/install.sh --data-dir /srv/stage-utility   # custom data dir
sudo ./scripts/install.sh --user stagemon                 # run as a specific user
sudo ./scripts/install.sh --no-service                    # build only, no systemd
```

`STAGE_UTILITY_DATA=/path` works as an alternative to `--data-dir`. The service
runs as `$SUDO_USER` by default (the human who ran `sudo`).

### Operating

```bash
systemctl status stage-utility        # is it running?
journalctl -u stage-utility -f        # tail logs
sudo systemctl restart stage-utility  # restart
```

Open the port to your LAN if needed:

```bash
sudo ufw allow from 192.168.0.0/16 to any port 8788 proto tcp
```

> To restart even on a *clean* exit (not just crashes), edit the unit at
> `/etc/systemd/system/stage-utility.service`, change `Restart=on-failure` to
> `Restart=always`, then `sudo systemctl daemon-reload && sudo systemctl restart stage-utility`.

### Updating

```bash
cd /opt/stage-utility/mic-display
git pull
sudo ./scripts/install.sh   # re-installs deps, rebuilds, restarts; data dir untouched
```

---

## macOS (launchd)

There's no one-command installer for macOS; build once, then install a `launchd`
daemon for boot + auto-restart.

### 1. Build

```bash
cd /path/to/mic-display
npm ci
npm run build
```

Confirm it runs (Ctrl-C to stop):

```bash
npm start          # node --import tsx server.ts → http://localhost:8788/
```

The first time, macOS may prompt to **allow incoming network connections** — allow it.

### 2. Install a LaunchDaemon (starts on boot, restarts on crash)

Find your absolute Node path — launchd needs it:

```bash
which node          # e.g. /opt/homebrew/bin/node  (Apple Silicon)  or  /usr/local/bin/node
```

Create `/Library/LaunchDaemons/com.cornerstone.stageutility.plist` (a system
daemon → runs at boot before login). Replace **`/ABS/PATH/TO/node`**,
**`/ABS/PATH/TO/mic-display`**, and **`youruser`**:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.cornerstone.stageutility</string>
  <key>UserName</key>         <string>youruser</string>
  <key>WorkingDirectory</key> <string>/ABS/PATH/TO/mic-display</string>
  <key>ProgramArguments</key>
  <array>
    <string>/ABS/PATH/TO/node</string>
    <string>--import</string>
    <string>tsx</string>
    <string>/ABS/PATH/TO/mic-display/server.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>            <string>production</string>
    <key>STAGE_UTILITY_DATA</key>  <string>/Users/youruser/.stage-utility</string>
  </dict>
  <key>RunAtLoad</key>  <true/>   <!-- start on boot -->
  <key>KeepAlive</key>  <true/>   <!-- restart if it ever exits (crash or kill) -->
  <key>StandardOutPath</key> <string>/tmp/stage-utility.log</string>
  <key>StandardErrorPath</key> <string>/tmp/stage-utility.err.log</string>
</dict>
</plist>
```

Load and start it:

```bash
sudo launchctl bootstrap system /Library/LaunchDaemons/com.cornerstone.stageutility.plist
sudo launchctl enable system/com.cornerstone.stageutility
```

`RunAtLoad` starts it on every boot; `KeepAlive` relaunches it within seconds if
it crashes or is killed.

### Operating

```bash
sudo launchctl kickstart -k system/com.cornerstone.stageutility   # restart
tail -f /tmp/stage-utility.log                                    # logs
sudo launchctl bootout system/com.cornerstone.stageutility        # stop & unload
```

### Updating

```bash
cd /path/to/mic-display && git pull && npm ci && npm run build
sudo launchctl kickstart -k system/com.cornerstone.stageutility
```

---

## Windows

Build once, then run it as a service. **NSSM** is the simplest way to get a true
Windows service with boot-start + automatic crash-restart; Task Scheduler is the
no-extra-software fallback.

### 1. Build

In PowerShell, from the repo:

```powershell
cd C:\path\to\mic-display
npm ci
npm run build
npm start          # verify: http://localhost:8788/  (Ctrl-C to stop)
```

Allow the app through **Windows Defender Firewall** when prompted (Private networks).

### 2a. Recommended — NSSM service (boot-start + auto-restart)

Install [NSSM](https://nssm.cc/) (`choco install nssm`, or download the exe), then
in an **Administrator** PowerShell. Use `where.exe node` to get Node's full path:

```powershell
nssm install StageUtility "C:\Program Files\nodejs\node.exe" "--import tsx server.ts"
nssm set StageUtility AppDirectory "C:\path\to\mic-display"
nssm set StageUtility AppEnvironmentExtra NODE_ENV=production STAGE_UTILITY_DATA=C:\ProgramData\stage-utility
nssm set StageUtility Start SERVICE_AUTO_START          # start on boot
nssm set StageUtility AppExit Default Restart           # restart on crash (NSSM's default)
nssm start StageUtility
```

NSSM auto-restarts the process if it exits and starts the service on boot.

Operating: `nssm restart StageUtility`, `nssm stop StageUtility`,
`nssm remove StageUtility confirm` (uninstall). Logs: add
`nssm set StageUtility AppStdout C:\ProgramData\stage-utility\out.log` and
`AppStderr …\err.log`.

### 2b. Alternative — Task Scheduler (no extra software)

1. Open **Task Scheduler → Create Task** (not "Basic").
2. **General:** "Run whether user is logged on or not", "Run with highest privileges".
3. **Triggers:** New → *At startup*.
4. **Actions:** New → Start a program:
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `--import tsx server.ts`
   - Start in: `C:\path\to\mic-display`
5. **Settings:** enable "If the task fails, restart every: 1 minute" (up to 3×) so
   it recovers from a crash.

Set the data dir by adding a system environment variable
`STAGE_UTILITY_DATA=C:\ProgramData\stage-utility` (System Properties → Environment
Variables), since Task Scheduler actions can't set per-task env vars easily.

### Updating

```powershell
cd C:\path\to\mic-display; git pull; npm ci; npm run build
nssm restart StageUtility      # or: restart the scheduled task
```

---

## First-time configuration (all platforms)

Open the **Settings** page in a browser:

```
http://<server-ip>:8788/settings
```

Then:

1. **Integrations → Planning Center** — enter your **App ID** and **Secret**
   (from a PCO Personal Access Token at
   [api.planningcenteronline.com](https://api.planningcenteronline.com) →
   Developers → Personal Access Tokens).
2. **Integrations → Wireless Gear** *(optional)* — pick your Shure model and
   enter its IP, TCP port (usually `2202`), and channel count.
3. **Integrations → ProPresenter / ProdCom** *(optional)* — host + API port.
4. **Service Types**, **Plan**, **Views**, **Displays** — choose allowed service
   types, pick a plan (or Auto), build views, and route each display to a view.
5. **Advanced → Public address (DNS)** *(optional)* — if you reach the server via
   a DNS name (e.g. behind a reverse proxy), set it here so the connect QR code
   and display links use it instead of the LAN IP.

The kiosk display is at `http://<server-ip>:8788/`. On a phone on the same
network, scan the QR code shown on the display (enable it under **Connect**).

## Backups

Back up the **data directory** (`/var/lib/stage-utility` on Linux,
`~/.stage-utility` on macOS, `C:\ProgramData\stage-utility` or
`%USERPROFILE%\.stage-utility` on Windows). It holds all configuration, the
**encrypted secrets**, and `encryption.key`. If you lose `encryption.key`, you'll
have to re-enter every credential.

If the data dir was renamed across releases (older `stage-monitor` /
`stage-display` installs), the server copies the most-recent legacy dir's
contents forward on first start — including `encryption.key`. Check the startup
log for a `recovered config` line.

## Uninstall

- **Linux:** `sudo ./scripts/uninstall.sh` (stops + removes the service; leaves the data dir intact).
- **macOS:** `sudo launchctl bootout system/com.cornerstone.stageutility` then delete the plist.
- **Windows:** `nssm remove StageUtility confirm` (or delete the scheduled task).

The data directory is never removed automatically — back it up or delete it deliberately.
