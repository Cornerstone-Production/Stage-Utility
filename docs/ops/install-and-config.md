# Install and configure

Node ≥ 24, on Linux, macOS or Windows. The only platform-specific part is how it
auto-starts.

## Install

One line, on any supported machine. Nothing to clone, no Node to install, no
build step — the download carries its own runtime.

**Linux and macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/main/install.sh | sudo bash
```

**Windows** — in an Administrator PowerShell:

```powershell
irm https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/main/install.ps1 | iex
```

It works out which build this machine needs, verifies the download against the
published checksums, registers an auto-starting service, waits for the server to
answer, and prints the address to open. If any of that fails it stops before
writing anything.

| Platform | Architectures | Auto-start | Installs to |
|---|---|---|---|
| Linux (Pi or server) | x64, arm64 | systemd | `/opt/stage-utility` |
| macOS | Apple silicon, Intel | launchd | `/usr/local/stage-utility` |
| Windows | x64 | Scheduled task | `C:\Program Files\Stage Utility` |

A 32-bit Raspberry Pi OS is not published; the arm64 build runs on a 64-bit one.

Options, set as environment variables before the command:

| | |
|---|---|
| `STAGE_TRACK=beta` | follow prereleases instead of stable |
| `STAGE_VERSION=v1.9.2` | pin an exact release |
| `STAGE_PORT=8080` | serve on a different port |
| `STAGE_DATA=/srv/stage` | put config and history somewhere else |
| `STAGE_NO_SERVICE=1` | install the files, register nothing |

After that, update from **Settings → Advanced → Updates** — see
[Releases and distribution](distribution.md).

On a laptop or workstation, [Homebrew](homebrew.md) is an alternative:
`brew tap Cornerstone-Production/stage-utility && brew install stage-utility`.

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

## Updates

**Advanced → Updates** installs in place: fetch, fast-forward, reinstall if the
lockfile changed, rebuild if the UI changed, restart. A live service or an active
recording blocks it until you override.

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

**Advanced** — network address, update track, backups and the data archive.

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
