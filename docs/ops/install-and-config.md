# Install and configure

Node ≥ 24, on Linux, macOS or Windows. The only platform-specific part is how it
auto-starts.

## Install

Two supported ways in, both equally current — they install the same release from
the same published archives. Nothing to clone, no Node to install, no build step:
the download carries its own runtime.

**Linux and macOS** — one line. The right choice for a Pi or a server, because
it registers a system-wide service that starts at boot rather than at login.

```bash
curl -fsSL https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/main/install.sh | sudo bash
```

**Windows** — in an Administrator PowerShell:

```powershell
irm https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/main/install.ps1 | iex
```

The one-line installers work out which build this machine needs, verify the
download against the published checksums, register an auto-starting service, wait
for the server to answer, and print the address to open. If any of that fails
they stop before writing anything.

| Platform | Architectures | Auto-start | Installs to |
|---|---|---|---|
| Linux (Pi or server) | x64, arm64 | systemd | `/opt/stage-utility` |
| macOS | Apple silicon, Intel | launchd | `/usr/local/stage-utility` |
| Windows | x64 | Scheduled task | `C:\Program Files\Stage Utility` |

A 32-bit Raspberry Pi OS is not published; the arm64 build runs on a 64-bit one.

Options for the one-line installers:

| | |
|---|---|
| `STAGE_TRACK=beta` | install a prerelease instead of stable |
| `STAGE_VERSION=v1.9.2` | pin an exact release |
| `STAGE_PORT=8080` | serve on a different port |
| `STAGE_DATA=/srv/stage` | put config and history somewhere else |
| `STAGE_NO_SERVICE=1` | install the files, register nothing |

**Where they go matters.** In a `curl … | sudo bash` pipeline, a variable placed
at the front is set for `curl`, not for the shell that runs the script — the
installer never sees it and quietly installs the defaults. Put it on the `bash`
side, via `env`:

```bash
curl -fsSL https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/main/install.sh \
  | sudo env STAGE_PORT=8080 bash
```

`sudo env VAR=…` rather than `sudo VAR=…`: sudo may refuse to set a variable it
was not configured to allow (see `setenv` in `sudoers(5)`), and it refuses
silently. `env` applies the assignment itself, so it works on any machine.

On Windows the script runs in the current PowerShell session, so a plain
assignment on the line before is enough:

```powershell
$env:STAGE_PORT = "8080"; irm https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/main/install.ps1 | iex
```

### Installing a beta

Betas are cut from the `beta` branch on every merge and carry the same
verification as a stable release — CI has to pass before the tag exists. They
are the right choice for a spare machine you are testing on, and the wrong one
for the machine running Sunday.

Note the URL: a beta install fetches the installer from the **`beta` branch**,
not `main`. `main` only moves when a stable release is cut, so an installer fix
already shipped to beta would not reach a beta install for days — and the fix it
is missing may be the one that lets it install at all. In-app updates do the
same on your behalf: a beta box runs beta's installer, a stable box runs main's.

**Linux and macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/beta/install.sh \
  | sudo env STAGE_TRACK=beta bash
```

**Windows** — in an Administrator PowerShell:

```powershell
$env:STAGE_TRACK = "beta"; irm https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/beta/install.ps1 | iex
```

To pin one exact version instead of "newest on the track", add
`STAGE_VERSION=v1.10.0-beta.30` the same way. The installer always fetches the
installer script from `main`, whichever track it installs.

**Re-running the installer upgrades in place — do not uninstall first.** It
unpacks the new release beside the current one, flips the `current` pointer,
rewrites the service definition and restarts it, then waits for the server to
answer before reporting success. Your data directory is untouched, and the
previous release stays under `releases/` to go back to:

```
/usr/local/stage-utility/
  releases/1.9.5/
  releases/1.10.0-beta.33/
  current -> releases/1.10.0-beta.33
```

The one thing it does not remember is your **options**. They are read from the
command, not from the existing install, so re-pass any `STAGE_PORT`,
`STAGE_DATA` or `STAGE_PREFIX` you used originally — otherwise the new service
is registered with the defaults and will not find data written somewhere else.

An install already running does **not** need reinstalling to change track:
**Settings → Advanced → Update track** switches between main and beta in place,
in either direction, and keeps your configuration. Use that unless the box is
too old to update itself.

A beta box follows prereleases *and* stable releases, so it is never held back
from the release its own prereleases produced. See
[Releases and distribution](distribution.md#tracks).

After that, update from **Settings → Advanced → Updates** — see
[Releases and distribution](distribution.md).

### From a checkout instead

For development, or to run a modified copy:

```bash
npm ci
npm run build
npm start          # → http://localhost:8788/
```

`sudo ./scripts/install.sh` registers a systemd service from a checkout, building
from source and requiring Node ≥ 24 on the machine. `sudo ./scripts/uninstall.sh`
removes it. Step-by-step per platform is in [INSTALL.md](../../INSTALL.md).

### Homebrew

On macOS or a Linux workstation, [Homebrew](homebrew.md) is a supported
alternative: it runs the app as a user agent that starts at login (port 8788),
rather than a system service that starts at boot. Updates work from
**Settings → Advanced** the same way.

## Uninstalling

Every method leaves two things behind: the **service registration** that starts
it at boot, and the **data directory** holding your configuration, history and
encryption key. Removing the service is safe and reversible; the data directory
is deliberately never removed for you.

Remove the service first. A registration left behind keeps starting a server
that fights the new one for port 8788 — including after you have switched to a
different install method, where it looks like the new method is broken.

**From a checkout, the script does all of this for you:**

```bash
sudo ./scripts/uninstall.sh --dry-run   # say what it would do, change nothing
sudo ./scripts/uninstall.sh             # systemd + launchd + the install tree
./scripts/uninstall.sh --brew           # Homebrew — WITHOUT sudo
```

It removes only what is actually present, never touches the data directory, and
prints where that directory is. Homebrew is separate and unsudoed on purpose:
brew refuses to run as root, and its agent lives in your own `gui/<uid>` domain,
which root cannot reach.

Without a checkout, the per-method commands below are the same thing by hand.

**Linux** (one-line installer or a checkout)

```bash
sudo systemctl disable --now stage-utility
sudo rm /etc/systemd/system/stage-utility.service
sudo systemctl daemon-reload
sudo rm -rf /opt/stage-utility            # the install; data lives elsewhere
sudo userdel stage-utility                # the service account, if unused
```

**macOS** (one-line installer)

```bash
sudo launchctl bootout system/com.cornerstone.stage-utility   # stop it now
sudo rm /Library/LaunchDaemons/com.cornerstone.stage-utility.plist
sudo rm -rf /usr/local/stage-utility
```

The `bootout` matters on its own: deleting the plist stops it coming back at
boot, but leaves the running process serving until the machine restarts.

**Windows** — Administrator PowerShell

```powershell
Stop-ScheduledTask -TaskName StageUtility -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName StageUtility -Confirm:$false
Remove-Item "$env:ProgramFiles\Stage Utility" -Recurse -Force
```

**Homebrew** (no `sudo` — brew refuses to run as root)

```bash
brew services stop stage-utility          # or stage-utility-beta
brew uninstall stage-utility
launchctl bootout "gui/$(id -u)/homebrew.mxcl.stage-utility" 2>/dev/null || true
rm -f ~/Library/LaunchAgents/homebrew.mxcl.stage-utility.plist
brew untap Cornerstone-Production/stage-utility   # optional
```

**The last two lines are the ones people skip, and they are the ones that
matter.** `brew uninstall` does not stop or unregister the service, so the keg
can be deleted while its agent keeps running — the process then serves from
files that no longer exist (version `0.0.0`, no settings page) and holds port
8788 against whatever you install next. Uninstalling Homebrew to try the
one-line installer, and finding the new install "broken", is this and nothing
else. The stale label is also what makes every future `brew services start`
fail with `Bootstrap failed: 5: Input/output error`, permanently, across
reinstalls, until something boots it out.

### The data directory

Left intact by every command above, because it holds config, history, and the
encryption key that makes stored secrets readable. Remove it only when you mean
to, and take a backup first if the machine may be rebuilt
(**Settings → Advanced → Backup & restore**, or copy the directory).

| Install | Data directory |
|---|---|
| Linux (one-line) | `/var/lib/stage-utility` |
| macOS (one-line) | `/usr/local/var/stage-utility` |
| Windows | `%ProgramData%\stage-utility` |
| Homebrew | `$(brew --prefix)/var/stage-utility` |
| Checkout / dev | `~/.stage-utility` |

A custom `STAGE_DATA` at install time overrides these; the running server prints
its own path in **Settings → Advanced**.

## Updates

**Advanced → Updates** works however the server was installed, and so does
switching between the stable and beta tracks. A live service or an active
recording blocks an update until you override.

**It keeps serving while it updates.** The new version is downloaded, verified
and swapped into place while the current one is still running, and only then is
the server asked to exit so its service manager relaunches it. The interruption
is a single restart, not the length of the download.

What actually happens depends on the install:

| Installed by | How it updates |
|---|---|
| the one-line installer | re-runs the current installer, which downloads, verifies the checksum, swaps, and restarts |
| Homebrew | `brew update` and `brew upgrade` on its own formula, then restarts the service. See [Homebrew](homebrew.md) |
| a git checkout | fetch, reinstall if the lockfile moved, rebuild if the UI changed, restart |

On Linux the update runs as the service account rather than root — it only has
to write the install directory, which that account owns. One consequence for a
box installed before 1.10.0: port 80 used to be granted to a specific release's
runtime, so the first in-app update moves off it and `:80` stops answering.
`8788` is unaffected, and re-running the installer once with `sudo` restores it
permanently. The update log says so when it happens.

There is no extra tooling requirement on any platform. If the app cannot work out
how it was installed, it refuses and says so rather than starting something it
cannot finish.

A server follows **release tags, not the tip of its branch**. Tags are cut only
after lint, type-check, tests and the build all pass, so a failed build cannot
reach a display; work that has merged but not yet released is reported as such
rather than counted as an available update. A branch with no tags falls back to
following its tip.

Two tracks: **main** takes stable releases only, **beta** takes prereleases too.
Switching tracks reinstalls and rebuilds.

## Development

Two terminals, from the repo root:

```bash
npm install
npm run server     # backend on :8788
npm run dev        # Vite with hot reload on :3000
```

Then open `http://localhost:3000/` for the display picker, or
`http://localhost:3000/settings`. Vite proxies the API and image paths to the
backend.

## Configure

Everything is configured in the Settings UI at `/settings` — nothing lives in the
repo. Work down the sidebar:

**Integrations** — connect Planning Center first, since the plan drives everything
else. Enter an App ID and Secret from a
[PCO Personal Access Token](https://api.planningcenteronline.com). Add whatever
other gear you run; each integration is independent and shows its own connection
state. See [integrations](../integrations/README.md).

**Plan** — Auto follows the next upcoming service and rolls forward after it ends;
Manual pins one, and its picker also lists the last 30 days so you can point the
screens at a service that has already happened. Active Service Types limits which
types Auto considers.

**Screens** — build the content and route it to your physical screens. A view is a
slot grid, dashboard, stage screen, captions, script rundown, SPL rundown, or a
custom layout you design on a canvas; build once and route it to any number of
screens, each with its own URL.

**Branding, Automation, History, Baptisms, Patch** — appearance, event-driven
rules, recorded services, the baptism timer and the stage patch sheet.

**Advanced** — time zone, network address, update track, backups and the data
archive.

### Time zone

Set this if the server's own clock is not your local zone. Servers and containers
commonly run UTC, and a UTC clock rolls its date mid-evening everywhere west of
Greenwich — 19:00 in Chicago, 16:00 in Los Angeles.

The setting shows what the host clock reads plus a live clock in the zone you
pick, so a wrong one is obvious immediately. It governs which day a service is
filed under, the scheduled update window, and the day-of-week and time-of-day
automation conditions. It does not govern whether a live service is recorded —
that is deliberately independent of the clock.

Setting the host's own zone (`timedatectl set-timezone America/Chicago`) also
works and is worth doing for sane log timestamps, but the app no longer depends on
it.

## URLs and ports

| Surface | Development | Production |
|---|---|---|
| Display picker | `localhost:3000/` | `http://<host>/` |
| A display | `localhost:3000/display-1` | `http://<host>/display-1` |
| Settings | `localhost:3000/settings` | `http://<host>/settings` |
| ScriptView | — | `http://<host>/scriptview` |
| API and SSE | proxied to `:8788` | `http://<host>/api/*` |

The server binds `0.0.0.0:8788`, and also `:80` where the process is permitted, so
URLs need no port — `8788` always stays up either way.

Override with `STAGE_UTILITY_PORT`, or `STAGE_UTILITY_FRIENDLY_PORT=0` to disable
the port-free listener. `STAGE_UTILITY_DATA` sets the data directory.
