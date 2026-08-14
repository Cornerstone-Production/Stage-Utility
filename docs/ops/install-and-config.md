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

Options for the one-line installers, set as environment variables before the
command:

| | |
|---|---|
| `STAGE_TRACK=beta` | follow prereleases instead of stable |
| `STAGE_VERSION=v1.9.2` | pin an exact release |
| `STAGE_PORT=8080` | serve on a different port |
| `STAGE_DATA=/srv/stage` | put config and history somewhere else |
| `STAGE_NO_SERVICE=1` | install the files, register nothing |

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
| a git checkout | fetch, reinstall if the lockfile moved, rebuild if the UI changed, restart |

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

**Views** — the content you build. A view is a slot grid, dashboard, stage screen,
captions, script rundown, SPL rundown, or a custom layout you design on a canvas.
Build once, route to any number of screens.

**Displays** — your physical screens. Each has its own URL and points at one view.

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
