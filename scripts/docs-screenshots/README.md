# Documentation screenshots

Real screenshots of the app for `docs/`, made from invented data on a throwaway
server by a script anyone can re-run when the UI changes.

```bash
npm run build                                   # the server serves build/
npm run docs:screenshots                        # every image, into docs/images/
npm run docs:screenshots -- --only wall-stage-wall,screens-overview
npm run docs:screenshots -- --serve             # seed a server and leave it up to look at
```

It needs Google Chrome installed (the capture step drives it through
`playwright-core` with `channel: "chrome"`, so there is no browser download) and
`npm ci --include=dev`. A full run takes about a minute and a half.

| Option | |
|---|---|
| `--only a,b` | only those images (names are in [capture/shots.ts](capture/shots.ts)) |
| `--out <dir>` | write somewhere other than `docs/images/` |
| `--port <n>` | serve on another port; the default is 8797 |
| `--data <dir>` | the scratch data directory; it must not exist or must be empty |
| `--serve` | seed, then leave the server running. Stop it by port: `kill $(lsof -tiTCP:8797 -sTCP:LISTEN)` |

## What runs

1. **A scratch data directory**, new every run (`$TMPDIR/stage-docs-shots-*`). Never
   an install's, never a copy of one: `lib/server.ts` refuses a directory that is
   not empty or that is a known install location.
2. **History files** are written into it ([seed/history.ts](seed/history.ts)).
3. **The app's own server**, `server.ts` unmodified, started with a preload
   ([preload.ts](preload.ts)) and its own settings, on port 8797.
4. **Seeding through the server's API** ([seed/](seed/)).
5. **Capture** ([capture/](capture/)): Chrome opens every screen at its own address
   at 1920x1080 (so each counts as connected), then takes the app pages at
   1440x900, light theme, and the screens as they render.
6. The server is stopped by port.

## Why it cannot touch anything real

The machine this runs on usually has a real install beside it, so each of these is
enforced in code rather than left to care:

- **Port and data**: its own port and an empty data directory; the server must
  answer `/api/version` with that directory before anything is written to it.
- **Discovery**: the server's `kioskDiscoveryPort` is moved to 48789 in the scratch
  `settings.json` before it starts, so the Mac output helper, which probes UDP 8789,
  is never answered or claimed. The friendly port 80 is switched off.
- **Network**: the preload gives the server process an offline world. Any request
  that is not to loopback and not to Planning Center is refused, and any connection
  or datagram to a private address goes to loopback and dies there. Nothing reaches
  the update check, a photo CDN, or a real device.
- **Names and addresses**: everything shown is invented ([world.ts](world.ts)):
  people are `Alex Rivera`, `Jordan Lee` and the like; service types are `Weekend`,
  `The Gathering` and `Youth Night`; every address is in `192.168.1.x`, which is also
  what `scripts/check-public-hygiene.ts` allows. There are no photos: a person with
  no photo draws the app's default avatar.

## How each feature is fed

| Feature | Source |
|---|---|
| Planning Center plans, rundown, roster, live item | [fakes/pco.ts](fakes/pco.ts). The app pins every Planning Center request to the real host, so this is not a server it is pointed at: the preload swaps `fetch` in the screenshot server's process for one that answers Planning Center's address from the invented world. The app code is not changed |
| Wireless mics | [fakes/shure.ts](fakes/shure.ts), a Shure ULX-D speaking the ASCII protocol on loopback. The preload redirects the two invented receivers (`192.168.1.41` and `.42`, port 2202) to it, so the app's real driver reads them |
| Found devices (Screens banner, sidebar count) | [lib/probe.ts](lib/probe.ts) sends two discovery datagrams to the moved port, as a Pi would; the preload gives them LAN source addresses |
| Views, layouts, mic board, screens | the views, outputs and slots routes ([seed/layouts.ts](seed/layouts.ts)) |
| Stage messages, groups, replies | the messaging and messages routes ([seed/messages.ts](seed/messages.ts)); replies are posted as the stage panels |
| Automation rules | the rules routes, with an invented OSC target ([seed/automation.ts](seed/automation.ts)) |
| Video feeds | the feeds routes. The relay stays off (turning it on downloads a binary), so feeds show as configured, not playing |
| Patch sheet | the patch route ([seed/patch.ts](seed/patch.ts)) |
| ServiceCue | the ServiceCue config, roles and layouts routes |
| Home | the Home view's layout ([seed/home.ts](seed/home.ts)) |
| History, baptisms | files, the shapes in `main/types/history.ts` and `baptism.ts` ([seed/history.ts](seed/history.ts)): thirteen weeks of services with a growing attendance, one holiday dip, and sound levels per item |

**Two phases.** The images that need a service on air (Home, the screens, the
messages) are taken after the capture step switches the fake onto a Weekend plan
that started 14 minutes ago, with "Hold Fast" live. Everything else is taken first,
because a live service makes the app's recorders start a record for today, and
that belongs in no screenshot of History.

## When the UI changes

Re-run the whole thing, look at every image it writes (an open banner, a spinner,
a "not configured" card is a seed that no longer matches the UI), and commit the
changed PNGs with the change. `docs/images/README.md` lists each image and what it
shows.

When a screenshot needs a feature the seed does not have yet, add it to the seed
step, through the server's API where there is a route, and name what it shows in
[capture/shots.ts](capture/shots.ts). Keep data invented, and the address in
`192.168.1.x`.

`docs-screenshots.test.ts` runs the fake Planning Center through the app's own
client, and the seeded history files through the app's own stores. If a change to
either side makes the screenshots quietly wrong, that test fails first.

## Not captured

Anything that needs a real account or a real device cannot be shown from invented
data: ProPresenter, ProdCom, Smaart (SPL), SenSource attendance counts, OBS, REAPER,
Resi, YouTube, Companion, a running video relay with a live picture. Those cards
read "Not set up" on the Integrations page, which is true of this machine, and the
Home and wall images leave their tiles out.
