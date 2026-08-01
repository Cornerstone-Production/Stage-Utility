# Stage Utility

Monitors around a stage, showing your production team what they need during a
service — who is on which mic, what slide is up, how loud it is, how far behind
the plan you are.

It reads your service plan from **Planning Center** and pulls live data from the
gear you already run: wireless receivers, ProPresenter, OBS, SPL meters, people
counters. Everything is on your own network; a small Node server drives the
screens, the settings UI and a phone remote from one port.

---

## Contents

**In this file** — [How it works](#how-it-works) · [Get the code](#get-the-code) ·
[What it connects to](#what-it-connects-to) · [Branches and releases](#branches-and-releases)

**Documentation**

| | |
|---|---|
| [Install, deploy and configure](docs/ops/install-and-config.md) | putting it on a machine, running it in development |
| [Integrations](docs/integrations/README.md) | every device and service it talks to |
| [Data model](docs/reference/data-model.md) | Views, Outputs and Slots — the nouns |
| [Display URLs](docs/display-urls.md) | addressing screens |
| [Slots](docs/slots.md) | matching people and devices to positions |
| [Attendance and service history](docs/features/attendance-and-history.md) | what a service records, and reading it back |
| [ScriptView and Baptisms](docs/features/scriptview-and-baptisms.md) | two operator surfaces on the plan |
| [Patch sheet](docs/patch-sheet/README.md) | the stage patch sheet |
| [Automation](docs/automation.md) | rules that fire on live events |
| [Data archive](docs/data-archive.md) | raw sample retention, export and import |
| [Reliability and data](docs/ops/reliability.md) | behaviour under load, where your data lives |
| [Network traffic](docs/ops/network-traffic.md) | what it puts on your LAN |
| [Updates and logs](docs/ops/updates-and-logs.md) | the in-app updater |
| [API reference](docs/reference/api.md) | the HTTP surface |
| [Contributing](docs/contributing.md) | commit convention, branching, releases |
| [Project structure](docs/contributing-appendix.md) | orientation in the codebase |

---

## How it works

Each screen is a **display** — a browser at its own URL, typically a Pi or a
smart TV. A display shows a **view**: the content you built, which can be a mic
slot grid, a tech dashboard, a stage/confidence screen, full-screen captions, or
a layout you design yourself by dragging clocks, timers, slide text and mic grids
onto a canvas.

Views and displays are separate on purpose. Build a view once and point as many
screens at it as you like; change the view and every screen follows. A
phone-friendly remote runs on the same network, so someone on the floor can
reassign a mic or switch plans without going back to the booth.

```
Planning Center ─┐                        ┌─ Displays      /display-1, /display-2 …
   plan, people  │    ┌──────────────┐    │
Wireless, audio ─┼───▶│  Node server │───▶├─ Settings      /settings
   and video gear│    │    :8788     │    │
                 │    └──────────────┘    ├─ Phone remote
                 │                        │
                 └── on your network ─────┴─ REST /api/*  ·  SSE /api/events
```

The server holds the connections to your gear, resolves the current plan into
slots, and pushes changes to every screen over one event stream. Nothing routes
through the internet except Planning Center, and video never passes through the
app at all.

**Does it fit your setup?** You need Planning Center Services, a machine to run it
on (a Pi is enough), and screens that can open a URL. Everything else is optional
— the app works with whatever subset of gear you have, and each integration is
enabled independently.

## Get the code

```bash
git clone https://github.com/Cornerstone-Production/Stage-Utility.git
cd Stage-Utility
```

Installing on a display device, or running it locally to develop against, is in
[install and config](docs/ops/install-and-config.md).

## What it connects to

**Planning Center Services** is the one requirement — it supplies the plan, the
people, their photos and the live service countdown.

Everything else is optional and independently enabled: Shure and Sennheiser
wireless, ProPresenter, Smaart (SPL), SenSource (people counting), OBS, REAPER,
OSC, RossTalk, Ross TSL, ProdCom transcription, and Bitfocus Companion.

Setup and behaviour for each is in [integrations](docs/integrations/README.md).

## Branches and releases

- **`main`** — the stable line. This is what you install, and what the in-app
  updater follows. Tagged releases are under
  [Releases](https://github.com/Cornerstone-Production/Stage-Utility/releases).
- **`beta`** — pre-release track. A device on `beta` auto-updates from `beta`.

## License

**GNU General Public License v3.0 or later** — see [LICENSE](LICENSE).

## Security

Found a vulnerability? Report it privately — see [SECURITY.md](SECURITY.md).
