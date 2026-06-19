# Installing Stage Utility

Stage Utility is a web/server-only app: a small Node backend serves the kiosk
display, the settings UI, and a phone control panel — all on one port (**8788**).
There is no desktop/Electron runtime, so it runs anywhere Node runs.

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
- **Access to the repo.** It's a private repository
  (`github.com/Cornerstone-Production/mic-display`), so cloning will ask you to
  authenticate. Use either:
  - **HTTPS + token:** when git prompts for a password, paste a GitHub
    [Personal Access Token](https://github.com/settings/tokens) (your account
    password won't work), **or**
  - **SSH:** if you've added an SSH key to your GitHub account, clone with
    `git@github.com:Cornerstone-Production/mic-display.git` instead of the HTTPS URL.
- **Port 8788** must be reachable on your LAN (open it in the firewall — shown per
  platform). Override the port with the `STAGE_UTILITY_PORT` environment variable
  if needed.
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
git clone https://github.com/Cornerstone-Production/mic-display.git
cd mic-display
```

*(Authenticate with a GitHub token when prompted — see [Before you start](#before-you-start-all-platforms).)*

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
```

### 5. Configure

Open `http://<server-ip>:8788/settings` in a browser and follow
[First-time configuration](#first-time-configuration-all-platforms).

### Operating & updating (Linux)

```bash
systemctl status stage-utility        # running?
journalctl -u stage-utility -f        # live logs
sudo systemctl restart stage-utility  # restart

# Update to the latest:
cd /opt/stage-utility/mic-display && git pull && sudo ./scripts/install.sh
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
git clone https://github.com/Cornerstone-Production/mic-display.git
cd mic-display
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
pwd                  # the mic-display path
whoami               # your username
```

Create `/Library/LaunchDaemons/com.cornerstone.stageutility.plist` (a system
daemon → starts at boot before login). Replace **`/ABS/PATH/TO/node`**,
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
  <key>StandardOutPath</key>   <string>/tmp/stage-utility.log</string>
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

### 5. Configure

Open `http://<this-mac-ip>:8788/settings` and follow
[First-time configuration](#first-time-configuration-all-platforms).

### Operating & updating (macOS)

```bash
sudo launchctl kickstart -k system/com.cornerstone.stageutility   # restart
tail -f /tmp/stage-utility.log                                    # logs
sudo launchctl bootout system/com.cornerstone.stageutility        # stop & unload

# Update:
cd /ABS/PATH/TO/mic-display && git pull && npm ci && npm run build
sudo launchctl kickstart -k system/com.cornerstone.stageutility
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
git clone https://github.com/Cornerstone-Production/mic-display.git
cd mic-display
```

### 3. Build and test-run

```powershell
npm ci
npm run build
npm start            # → http://localhost:8788/   (Ctrl-C to stop)
```

Allow the app through **Windows Defender Firewall** when prompted (at least for
Private networks). Confirm `http://localhost:8788/settings` loads, then stop it.

### 4a. Set it to auto-start — NSSM (recommended)

Install [NSSM](https://nssm.cc/) (`choco install nssm`, or download the exe). Find
Node's full path with `where.exe node`. Then, in an **Administrator PowerShell**:

```powershell
nssm install StageUtility "C:\Program Files\nodejs\node.exe" "--import tsx server.ts"
nssm set StageUtility AppDirectory "C:\StageUtility\mic-display"
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
   - Start in: `C:\StageUtility\mic-display`
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
cd C:\StageUtility\mic-display; git pull; npm ci; npm run build
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

To point a kiosk/Pi browser straight at one screen, use
`http://<server-ip>:8788/display-1` (etc.).

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
- **macOS:** `sudo launchctl bootout system/com.cornerstone.stageutility`, then delete the plist.
- **Windows:** `nssm remove StageUtility confirm` (or delete the scheduled task).

The data directory is never removed automatically — back it up or delete it deliberately.
