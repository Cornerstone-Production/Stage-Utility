# Installing Stage Utility

Stage Utility is a web/server-only app: a small Node backend serves the kiosk
display, the settings UI, and a phone control panel — on port **8788**, and (by
default, where the process is allowed to) **also on port 80** so displays can use
a URL with no port (`http://<server-ip>/`). Port 8788 always stays available.
It runs anywhere Node runs.

> **Port 80 is best-effort.** If the process can't bind it (no privilege, or the
> port is already in use), the app logs a note and keeps serving 8788 — it never
> fails to start. The Linux installer grants the needed privilege automatically
> (see below). Disable the port-80 listener with `STAGE_UTILITY_FRIENDLY_PORT=0`.

## Most people want the one-liner

```bash
curl -fsSL https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/main/install.sh | sudo bash
```

```powershell
irm https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/main/install.ps1 | iex
```

No Node, no git, no build. Options and what it does are in
[install and config](docs/ops/install-and-config.md#install). **The rest of this
file is the manual route** — building from a checkout, which you want if you are
developing, running a modified copy, or on a platform with no published build.

---

**It installs on Linux, macOS, and Windows.** The app itself is identical on each;
only the way you make it **auto-start on boot and restart if it crashes** differs.
Pick your platform and follow it top to bottom:

- [Linux (Raspberry Pi / Ubuntu / Debian)](#linux-raspberry-pi--ubuntu--debian) — one-command installer.
- [macOS](#macos)
- [Windows](#windows)

What you'll do on every platform: **install Node + git → get the code → build →
set it to auto-start → configure in the browser.**

---

## Before you start (all platforms)

- **Node.js ≥ 24** and **git** — the steps below install these per-OS.
- **The repo URL:** `https://github.com/Cornerstone-Production/Stage-Utility.git`.
  It's a public repo, so cloning needs no authentication.
- **Ports 8788 and 80** must be reachable on your LAN (open them in the firewall —
  shown per platform). Override the main port with `STAGE_UTILITY_PORT`; change or
  disable the port-free listener with `STAGE_UTILITY_FRIENDLY_PORT` (`0` = off).
- **Where config lives:** a *data directory* outside the repo (paths noted per
  platform). Updates never touch it. Back it up — see [Backups](#backups).

---

## Linux (Raspberry Pi / Ubuntu / Debian)

The fastest path: a one-command installer handles the build **and** the
auto-start service.

### 1. Install Node ≥ 24 and git

```bash
# Node 24 from NodeSource (Debian/Ubuntu/Raspberry Pi OS):
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git

node -v    # should print v24.x or newer
```

### 2. Get the code

Clone into a stable location (e.g. `/opt`):

```bash
sudo mkdir -p /opt/stage-utility
sudo chown "$USER" /opt/stage-utility
cd /opt/stage-utility
git clone https://github.com/Cornerstone-Production/Stage-Utility.git
cd Stage-Utility
```

### 3. Install + set to auto-start (one command)

```bash
sudo ./scripts/install.sh
```

This verifies Node, installs dependencies (`npm ci`), builds the UI
(`npm run build`), creates the data directory (default `/var/lib/stage-utility`),
and writes + enables a `stage-utility` **systemd** service that **starts on boot
and restarts on crash** (`Restart=on-failure`, `RestartSec=5`). It prints the
access URLs at the end.

Useful options:

```bash
sudo ./scripts/install.sh --data-dir /srv/stage-utility   # custom data dir
sudo ./scripts/install.sh --user stagemon                 # run as a specific user
sudo ./scripts/install.sh --no-service                    # build only, no service
```

### 4. Open the firewall (if enabled)

```bash
sudo ufw allow from 192.168.0.0/16 to any port 8788 proto tcp
sudo ufw allow from 192.168.0.0/16 to any port 80 proto tcp    # port-free URL
```

The installer grants the service the `CAP_NET_BIND_SERVICE` capability so it can
bind port 80 as a non-root user. **Upgrading an existing box?** In-app updates
don't rewrite the systemd unit, so re-run `sudo ./scripts/install.sh` once to pick
up the port-80 capability (subsequent in-app updates keep it).

### 5. Configure

Open `http://<server-ip>/settings` in a browser and follow
[First-time configuration](#first-time-configuration-all-platforms).

### Operating & updating (Linux)

```bash
systemctl status stage-utility        # running?
journalctl -u stage-utility -f        # live logs
sudo systemctl restart stage-utility  # restart

# Update to the latest:
cd /opt/stage-utility/Stage-Utility && git pull && sudo ./scripts/install.sh
```

> To restart even on a *clean* exit (not only crashes), edit
> `/etc/systemd/system/stage-utility.service`, change `Restart=on-failure` to
> `Restart=always`, then `sudo systemctl daemon-reload && sudo systemctl restart stage-utility`.

---

## macOS

No one-command installer here — you build once, then install a `launchd` daemon
for boot + auto-restart.

### 1. Install Node ≥ 24 and git

Install [Homebrew](https://brew.sh) if you don't have it, then:

```bash
brew install node git
node -v    # v24.x or newer
```

*(Alternatively: the Node installer from [nodejs.org](https://nodejs.org), and
`xcode-select --install` for git.)*

### 2. Get the code

```bash
cd ~/Apps            # or wherever you keep apps; create it if needed: mkdir -p ~/Apps
git clone https://github.com/Cornerstone-Production/Stage-Utility.git
cd Stage-Utility
```

### 3. Build and test-run

```bash
npm ci
npm run build
npm start            # → http://localhost:8788/   (Ctrl-C to stop)
```

The first run may prompt to **allow incoming network connections** — allow it.
Confirm `http://localhost:8788/settings` loads, then stop it with Ctrl-C.

### 4. Set it to auto-start (launchd)

Get your absolute Node path and note your repo path / username:

```bash
which node           # e.g. /opt/homebrew/bin/node (Apple Silicon) or /usr/local/bin/node
pwd                  # the Stage-Utility path
whoami               # your username
```

Create `/Library/LaunchDaemons/com.stage-utility.app.plist` (a system
daemon → starts at boot before login). The label `com.stage-utility.app` is just an
identifier — use your own reverse-DNS (e.g. `com.yourorg.stageutility`) if you prefer.
Replace **`/ABS/PATH/TO/node`**, **`/ABS/PATH/TO/Stage-Utility`**, and **`youruser`**:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.stage-utility.app</string>
  <key>UserName</key>         <string>youruser</string>   <!-- omit this line to run as root if you want the port-free URL (:80) on macOS -->
  <key>WorkingDirectory</key> <string>/ABS/PATH/TO/Stage-Utility</string>
  <key>ProgramArguments</key>
  <array>
    <string>/ABS/PATH/TO/node</string>
    <string>--import</string>
    <string>tsx</string>
    <string>/ABS/PATH/TO/Stage-Utility/server.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>            <string>production</string>
    <key>STAGE_UTILITY_DATA</key>  <string>/Users/youruser/.stage-utility</string>
  </dict>
  <key>RunAtLoad</key>  <true/>   <!-- start on boot -->
  <key>KeepAlive</key>  <true/>   <!-- restart if it ever exits (crash or kill) -->
  <key>StandardOutPath</key>   <string>/tmp/stage-utility.log</string>
  <key>StandardErrorPath</key> <string>/tmp/stage-utility.err.log</string>
</dict>
</plist>
```

Load and start it:

```bash
sudo launchctl bootstrap system /Library/LaunchDaemons/com.stage-utility.app.plist
sudo launchctl enable system/com.stage-utility.app
```

`RunAtLoad` starts it on every boot; `KeepAlive` relaunches it within seconds if
it crashes or is killed.

### 5. Configure

Open `http://<this-mac-ip>:8788/settings` and follow
[First-time configuration](#first-time-configuration-all-platforms).

### Operating & updating (macOS)

```bash
sudo launchctl kickstart -k system/com.stage-utility.app   # restart
tail -f /tmp/stage-utility.log                                    # logs
sudo launchctl bootout system/com.stage-utility.app        # stop & unload

# Update:
cd /ABS/PATH/TO/Stage-Utility && git pull && npm ci && npm run build
sudo launchctl kickstart -k system/com.stage-utility.app
```

---

## Windows

Build once, then run it as a service. **NSSM** gives a true Windows service with
boot-start + automatic crash-restart (recommended); Task Scheduler is the
no-extra-software fallback.

### 1. Install Node ≥ 24 and git

Easiest, in an **Administrator PowerShell**:

```powershell
winget install OpenJS.NodeJS
winget install Git.Git
# close & reopen PowerShell so PATH updates, then:
node -v    # v24.x or newer
```

*(Or download the installers from [nodejs.org](https://nodejs.org) and
[git-scm.com](https://git-scm.com).)*

### 2. Get the code

```powershell
mkdir C:\StageUtility; cd C:\StageUtility
git clone https://github.com/Cornerstone-Production/Stage-Utility.git
cd Stage-Utility
```

### 3. Build and test-run

```powershell
npm ci
npm run build
npm start            # → http://localhost:8788/   (Ctrl-C to stop)
```

Allow the app through **Windows Defender Firewall** when prompted (at least for
Private networks). Confirm `http://localhost:8788/settings` loads, then stop it.
Windows has no privileged-port restriction, so the port-free URL (`:80`) works
out of the box as long as nothing else (IIS, `http.sys`) already holds port 80.
Add a firewall rule for it too:

```powershell
netsh advfirewall firewall add rule name="Stage Utility 80" dir=in action=allow protocol=TCP localport=80
netsh advfirewall firewall add rule name="Stage Utility 8788" dir=in action=allow protocol=TCP localport=8788
```

### 4a. Set it to auto-start — NSSM (recommended)

Install [NSSM](https://nssm.cc/) (`choco install nssm`, or download the exe). Find
Node's full path with `where.exe node`. Then, in an **Administrator PowerShell**:

```powershell
nssm install StageUtility "C:\Program Files\nodejs\node.exe" "--import tsx server.ts"
nssm set StageUtility AppDirectory "C:\StageUtility\Stage-Utility"
nssm set StageUtility AppEnvironmentExtra NODE_ENV=production STAGE_UTILITY_DATA=C:\ProgramData\stage-utility
nssm set StageUtility Start SERVICE_AUTO_START          # start on boot
nssm set StageUtility AppExit Default Restart           # restart on crash (NSSM default)
nssm set StageUtility AppStdout C:\ProgramData\stage-utility\out.log
nssm set StageUtility AppStderr C:\ProgramData\stage-utility\err.log
nssm start StageUtility
```

NSSM starts the service on boot and relaunches the process if it exits.

### 4b. Alternative — Task Scheduler (no extra software)

1. **Task Scheduler → Create Task** (not "Basic Task").
2. **General:** "Run whether user is logged on or not" + "Run with highest privileges".
3. **Triggers:** New → *At startup*.
4. **Actions:** New → Start a program:
   - Program/script: `C:\Program Files\nodejs\node.exe`
   - Add arguments: `--import tsx server.ts`
   - Start in: `C:\StageUtility\Stage-Utility`
5. **Settings:** enable "If the task fails, restart every 1 minute" (up to 3 times).

Set the data dir via a **system** environment variable
`STAGE_UTILITY_DATA=C:\ProgramData\stage-utility` (System Properties → Environment
Variables), since scheduled-task actions can't easily set per-task env vars.

### 5. Configure

Open `http://<this-pc-ip>:8788/settings` and follow
[First-time configuration](#first-time-configuration-all-platforms).

### Operating & updating (Windows)

```powershell
nssm restart StageUtility           # restart   (or restart the scheduled task)
nssm stop StageUtility              # stop
nssm remove StageUtility confirm    # uninstall the service

# Update:
cd C:\StageUtility\Stage-Utility; git pull; npm ci; npm run build
nssm restart StageUtility
```

---

## First-time configuration (all platforms)

Open the **Settings** page in a browser:

```
http://<server-ip>:8788/settings
```

Then work through the sidebar:

1. **Integrations → Planning Center** — enter your **App ID** and **Secret**
   (from a PCO Personal Access Token at
   [api.planningcenteronline.com](https://api.planningcenteronline.com) →
   Developers → Personal Access Tokens).
2. **Integrations → Wireless Gear** *(optional)* — pick your model (Shure ULX-D /
   Axient / PSM, or Sennheiser EW-DX / EW-G4 / Spectera) and enter its IP, port
   (Shure TCP usually `2202`), and channel count. Offline/manual devices are OK too.
3. **Integrations → ProPresenter / ProdCom / Smaart / OBS / OSC / SenSource / Ross**
   *(all optional)* — host + port: ProPresenter `1025` (add multiple instances if
   needed), ProdCom `24480`, Smaart `26000` (live SPL), OBS WebSocket `4455` +
   password, SenSource Vea client ID + secret (people counting), Ross MultiViewer
   TSL port (pushes people counts). OSC targets are set per **OSC button** in the
   custom-layout editor.
4. **Plan**, **Screens** — pick a plan (or Auto) and toggle which
   **Active Service Types** auto-selection considers, build views (slots, dashboard,
   stage, captions, script, SPL rundown, or a custom visual layout), and route each
   screen to a view.
5. **ScriptView** *(optional)* — choose which service types appear on the `/scriptview`
   landing page and define global column layouts (Audio/Video/Lighting/…). **History**
   (SPL + attendance + item timing) and **Baptisms** appear once there's data.
6. **Advanced** — set the **Public address (DNS)** if you reach the server via a DNS
   name (used for the connect QR + display links); switch the **update track** (beta /
   main); and **save/download a full config snapshot** to back up or move the setup
   (secrets excluded).

The kiosk display is at `http://<server-ip>/` (or `:8788`). On a phone on the same
network, scan the QR code shown on the display (enable it under **Connect**).

To point a kiosk/Pi browser straight at one screen, use
`http://<server-ip>/display-1` (etc.).

## Updating from within the app

Once installed, you can update without a terminal: open **Settings → Advanced →
Updates**, where you can **Check now**, **Update now**, or enable **Automatic
updates** on a weekly schedule (it skips while a Planning Center service is
live). "Update now" pulls the latest, rebuilds, and restarts the service — the
displays go blank and reload for a few seconds.

This works because the service manager restarts the process when the updater
exits after rebuilding:

- **Linux:** the installer's systemd unit uses `Restart=always`. If you set up an
  older version, re-run `sudo ./scripts/install.sh` once to pick up the new unit.
- **macOS / Windows:** the `launchd` `KeepAlive` and NSSM `AppExit … Restart`
  settings in this guide already restart on exit — no change needed.

In-app updates require a **git checkout** (the normal install). A tarball/non-git
copy shows "update from the command line" instead — use the per-platform Update
steps above.

## Backups

Back up the **data directory** — it holds all configuration, the **encrypted
secrets**, and `encryption.key`:

| Platform | Default data directory |
|----------|------------------------|
| Linux    | `/var/lib/stage-utility` |
| macOS    | `~/.stage-utility` (or whatever `STAGE_UTILITY_DATA` is set to) |
| Windows  | `C:\ProgramData\stage-utility` (per the service config above) |

If you lose `encryption.key`, the encrypted secrets are unrecoverable and you'll
have to re-enter every credential. (Across older releases named `stage-monitor` /
`stage-display`, the server copies the most-recent legacy dir forward on first
start — look for a `recovered config` line in the logs.)

## Uninstall

- **Linux:** `sudo ./scripts/uninstall.sh` (stops + removes the service).
- **macOS:** `sudo launchctl bootout system/com.stage-utility.app`, then delete the plist.
- **Windows:** `nssm remove StageUtility confirm` (or delete the scheduled task).

The data directory is never removed automatically — back it up or delete it deliberately.
