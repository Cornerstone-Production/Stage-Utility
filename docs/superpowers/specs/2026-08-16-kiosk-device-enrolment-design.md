# Kiosk device enrolment — design

**Status:** design, approved in conversation. No implementation.

**Goal:** turn a machine into a display without configuring it. Install once, and
the device finds the server, announces itself, and waits to be claimed. Assigning
it an output in the app binds it permanently.

**Problem it replaces:** every mic-slot Pi is hand-configured — Debian installed
by hand, a boot script that opens a browser at a hardcoded
`http://192.168.16.61/display-1`. The server's address is baked into the SD card,
so moving the server breaks every screen, and replacing a dead Pi means
repeating the whole setup under time pressure.

## What already exists

Most of the display half is built. This design adds the *device* half.

| Piece | State |
|---|---|
| `Output` — permanent id, slug, bound view, mode | exists |
| `/<outputId>` renders a display | exists |
| `display-presence.ts` — kiosk heartbeat, online/offline | exists |
| `POST /api/displays/refresh` — server tells kiosks to reload | exists |
| `node:dgram` UDP, no dependency (OSC, Sennheiser SSC) | exists |
| `renderer/lib/uid.ts` — insecure-context-safe id | exists |
| `scripts/install.sh` / `uninstall.sh` — systemctl, launchctl, schtasks | exists |
| `scripts/survival/` — per-OS reboot/crash runners | exists |

Nothing here needs a new dependency.

## Shape

```
DEVICE (installed agent)                    SERVER
─────────────────────────                   ──────────────────────────
read device id from disk
  │
  ├─ UDP broadcast probe ──────────────────► bound to me?      → always answer
  │   {id, macs, hostname, os, boundTo}       bound elsewhere?  → ignore
  │                                           unbound?          → answer + list,
  │                                                               but only while
  │                                                               scanning
  ◄── unicast reply ────────────────────────  {serverId, name, http://host:port}
  │
  └─ launch browser, kiosk:
       http://<server>/enroll?device=<id>

                                            /enroll looks up the id:
                                              bound   → 302 /<outputId>
                                              unbound → holding screen
```

Assigning an output writes the binding and fires the existing
`/api/displays/refresh`; the holding page re-evaluates and redirects itself.

**The agent is a browser plus a launcher.** No daemon listening for the server, no
polling loop in the app layer, no SSE work. The device connects outward, which is
also why nothing has to be open on the device.

## Identity

The device id is generated **once at install** and written to disk in a
system-level location, outside any browser profile or user profile:

| OS | Path |
|---|---|
| Linux / Pi | `/var/lib/stage-utility-display/device-id` |
| macOS | `/Library/Application Support/StageUtility/device-id` |
| Windows | `%PROGRAMDATA%\StageUtility\device-id` |

It is passed to the browser in the URL. **The browser stores nothing.** Clearing
browser data, wiping the cache, resetting the profile or deleting the user account
does not touch it — which is the whole point: re-claiming a screen that was
already claimed is not acceptable in production.

A new id — and therefore a re-claim — happens only on a full OS reinstall or on
genuinely different hardware. That is correct: it *is* a new device.

**Not derived from hardware.** A CPU serial, `machine-id` or `IOPlatformUUID`
would each be stable on one platform and quirky on another (regenerated on clone,
absent in containers, changed by a motherboard swap). One generated value we own
behaves identically everywhere, and the hardware facts are recorded separately as
hints — see below.

### Claim token

On claim, the server generates a secret and returns it; the agent stores it beside
the id. Later enrolments present both.

This is what makes a binding actually *locked in*. Without it a device id is
self-asserted, so anything on the LAN could claim to be `Left Mic Display` and be
served its content. The LAN is otherwise trusted — the app is plain HTTP by design
— but a claimed display is the one thing worth pinning, and the token costs one
field.

An enrolment presenting a known id with a wrong or missing token is treated as a
**new, unclaimed device**, never as the bound one. It shows up in Devices as a
separate entry rather than silently taking over a screen.

## MAC and hostname recording

Every probe carries the device's MAC addresses (all interfaces — a machine may
have both Ethernet and Wi-Fi), its hostname, and its OS. The server records them
against the device and updates them on each probe.

**They are hints, never identity.** Three uses:

1. **Recognising a returning device.** When an unclaimed device appears whose MAC
   matches a device that is claimed but offline, the app offers: *"This looks like
   Left Mic Display, which went offline yesterday — is it the same screen?"* One
   click re-binds instead of hunting. This is the OS-reinstall case, and the
   swapped-SD-card case.
2. **Telling two identical Pis apart** in the Devices list, without walking to
   each screen.
3. **Support.** "Which box is `192.168.16.74`?" is answerable from the app.

**Why not identity.** Modern OSes randomise Wi-Fi MACs — usually stable per
network, but not guaranteed, and a network change rotates them. A NIC swap changes
it. A cloned VM may duplicate it. So a MAC match *suggests*, and a person
confirms; a MAC never binds anything on its own.

**Both Ethernet and Wi-Fi installs are supported.** On Ethernet the MAC never
randomises and the hint is dependable. The mic-slot Pis are on Wi-Fi today, where
Raspberry Pi OS normally connects with the real hardware MAC — but that is a
default, not a guarantee, and an OS update could change it underneath us. So a
**Wi-Fi install pins the connection MAC** rather than trusting the default, which
keeps the hint reliable on exactly the devices that need it most.

Stored per device: `macs: string[]`, `hostname`, `os`, `ip`, `lastSeen`.

## Data model

**Two halves, and only one of them is stored.**

- **A bound device is config.** The binding is the operator's work — it must be
  restored. `devices.json`, declared `"config"`, and added to `CONFIG_FILES` **in
  the same change** or it is silently missing from every backup.
- **An unclaimed device is runtime.** It exists only while it is actually probing:
  in memory, TTL'd, never persisted. Same shape as `display-presence.ts`.

That split is what makes the behaviour below fall out for free. Power a Pi off
before pairing it and it stops probing, so it ages out of every server's list —
there was never anything stored to clean up.

```ts
/** Stored. The operator's work. */
interface BoundDevice {
  id: string;
  /** Issued on claim, presented on every enrolment afterwards. */
  token: string;
  outputId: string;
  label?: string;
  /** Hints, refreshed whenever the device is seen. Never used to bind. */
  macs: string[];
  hostname?: string;
  os?: string;
  ip?: string;
  lastSeen?: number;
}

/** In memory only. Gone when it stops probing, gone on restart. */
interface SeenDevice {
  id: string;
  macs: string[];
  hostname?: string;
  os?: string;
  ip: string;
  firstSeen: number;
  lastSeen: number;
  /** Present when the device says it belongs to a server. Set → this server
   *  hides it unless the id is its own. */
  boundTo?: string;
}
```

**Binding is to an existing Output.** A replacement is claimed as *Left Mic
Display* and inherits the slot — its view, slug and QR codes. An output per device
leaves a dead entry behind on every hardware swap. One device per output; claiming
over an existing binding asks first, then moves it.

## Discovery protocol

UDP, `node:dgram`, no dependency. Same broadcast/respond pattern the OSC manager
and the Sennheiser provider already use.

- **Port: 8789 by default, and configurable.** Nothing in the app uses it (the app
  uses or talks to 2202, 4455, 7788, 8080, 8788, 24480, 26000 and 80), but AV gear
  is fond of odd UDP ports, so the setting exists to make a collision a
  five-second fix rather than a rebuild.
- **Probe:** device → broadcast
  `{"stageUtility":"discover","v":1,"id":"…","macs":[…],"hostname":"…","os":"…","boundTo":"…"|null}`
- **Reply:** server → unicast to the probe's source
  `{"stageUtility":"server","v":1,"serverId":"…","name":"FOH — Stage Utility","url":"http://…"}`
- **Retry:** every 2s, backing off to 30s after ten attempts, forever. A Pi that
  boots before the server — a power cut bringing the rack up at once — waits and
  finds it rather than failing.
- **Re-discovery:** on browser exit, and every 15 minutes, so moving the server
  does not mean touching a single screen.

**Manual override.** A `server=` line beside the device id skips discovery, for
networks where broadcast does not cross a VLAN.

### Which server answers, and when

Two rules, and the distinction matters more than it looks:

1. **A device that says it is bound to THIS server is always answered.** That is
   how a bound display re-finds its server after an IP change, with nobody
   present. Turning this off would leave a screen dark until someone opened
   settings, which is the opposite of what discovery is for.
2. **An unclaimed device is only recorded and surfaced during a SCAN.** Nothing
   new appears in the app unless somebody is looking.

A scan runs when:

- **you press Scan for devices** in settings — an explicit window;
- **the Devices page is open** — continuously, following the house rule of gating
  work on whether anyone is subscribed;
- **a periodic lazy scan**, a short window every few minutes, so a Pi plugged in
  while nobody was watching is waiting for you rather than needing a hunt. On by
  default, and switchable off.

### Bound elsewhere

**A device carries its own binding, so servers never talk to each other.**

An unclaimed device is fair game: during a scan it shows on *every* server that
hears it, which is fine — it is not bound to anything. The moment it is claimed on
one, its probe starts carrying that `serverId`, and every other server sees a
device that belongs to somebody and leaves it out of its list. Bind it on one
server and it disappears from all the others, with no coordination protocol,
no shared database, and nothing to get out of sync.

**When its own server is gone.** A bound device that cannot reach its server keeps
trying and shows a "cannot reach *name*" screen with its id — it does **not**
silently re-home, because a display that re-binds itself during an outage is worse
than a dark one. Other servers may show it in a separate **bound elsewhere,
unreachable** state, which needs an explicit force-claim. Visible, never automatic,
and it means recovering a device from a decommissioned server does not need SSH.

### Rate limiting

Probes from an unknown id are recorded at most once per minute, so a
misconfigured or malicious device cannot flood the list. A rogue device can
announce itself; it appears unclaimed and renders nothing until a person claims
it, which is the gate.

## Server surface

- **`GET /enroll?device=<id>&token=<t>`** — bound and token valid → `302` to
  `/<outputId>`. Otherwise the holding screen.
- **Holding screen** — shows the device id (short form), IP, hostname and MAC, so
  you can tell which physical screen you are looking at from across the room, and
  a line saying it is waiting to be assigned. Heartbeats like any display.
- **`POST /api/devices/claim`** — `{deviceId, outputId}` → binds, issues the token,
  fires `/api/displays/refresh` for that device.
- **`POST /api/devices/release`** — unbinds; the device falls back to the holding
  screen on its next load and starts advertising as unclaimed again.
- **`POST /api/devices/scan`** — opens a scan window. The Devices page holds one
  open while it is on screen.
- **`GET /api/devices`** — bound devices from config, plus whatever the current
  scan has heard that is not bound elsewhere.

## Devices page

A new destination under SCREENS. Screens stays about *outputs* — what shows what.
Devices is about *hardware* — which box is which, is it alive, what is it showing.

Each row: label / hostname, what it is showing (or **Unclaimed**), online dot and
last seen, IP, and the id and MAC in smaller type. Actions: assign an output,
rename, release, and — for a device whose MAC matches an offline claimed one —
*"Looks like Left Mic Display"* with a one-click re-bind.

Unclaimed devices sort to the top. A newly booted screen should be the first thing
on the page, because that is the moment somebody is standing at it.

## Installer

One script per OS, following `scripts/install.sh`'s existing shape and installing
into the service manager it already uses.

What it does:

1. Generate and store the device id, if absent.
2. Install the launcher and register it to start at boot/logon —
   `systemd` (Linux/Pi), `launchd` LaunchAgent (macOS), Task Scheduler (Windows).
3. The launcher loop: discover → launch browser in kiosk at the enrol URL → if the
   browser exits, re-discover and relaunch.
4. Best-effort display hygiene: disable screen blanking and sleep, suppress the
   browser's "Restore pages?" prompt after an ungraceful shutdown.

Uninstall removes the service and the launcher, and **leaves the device id in
place** — reinstalling on the same machine must not orphan its binding.

### Reliability tiers, stated plainly

Kiosk reliability is not equal across platforms, and pretending otherwise is how a
screen is dark on a Sunday:

- **Pi image (Phase 2)** — auto-login, blanking, browser flags and update policy
  all controlled. Genuinely set-and-forget.
- **Linux box** — nearly as good, subject to whatever else the machine does.
- **macOS / Windows** — best-effort. Needs auto-login configured, sleep and screen
  lock off, and lives on a general-purpose OS that reboots for updates on its own
  schedule. Good for a laptop on a cart or a Windows box already at FOH; not what
  to deploy for a permanent wall screen.

The installer sets what it can and the Devices page reports what it finds, rather
than the docs implying parity that does not exist.

## Phase 2 — prebuilt Pi image

Only after Phase 1 works. `pi-gen` in CI on release: Raspberry Pi OS Lite plus the
Linux installer already baked, so the card is flash-and-boot with no SSH step.

- **Wi-Fi credentials are not baked.** Raspberry Pi Imager's customisation already
  sets SSID, password, hostname and SSH keys, and applies to any Pi OS-based image.
  Reimplementing it would be redundant — and this repo is **public**, so a released
  image must never contain a credential or a site's server address.
- Budget ~20–40 min of CI and a 1–2 GB release asset.
- The image changes rarely: what is on screen is a web page from the server, so the
  payload updates itself. Only the OS and kiosk layer live in the image.

**Not built from inside the app.** Image building needs a Linux host with root,
loop devices and qemu; the app runs on macOS and on Pis. CI is the right home.

## Testing

- **Discovery** — probe/reply encode and decode, retry and backoff, unknown-id rate
  limiting. Pure functions over the datagram payloads, no sockets.
- **Enrolment** — bound/unbound/wrong-token routing, and that a wrong token yields a
  *new unclaimed device* rather than access to the bound one. This is the guard
  that matters; it must fail if the token check is removed.
- **Binding** — one device per output; claiming over an existing binding moves it;
  release leaves the output intact.
- **Config snapshot** — `devices.json` appears in `CONFIG_FILES`. The existing
  `config-snapshot.test.ts` already fails when a store is missing or on the wrong
  side.
- **Installer** — extend `scripts/survival/` to cover the kiosk agent surviving a
  reboot and a killed browser, on all three OSes, as the server already is.
- **Browser** — the holding screen and the Devices page against a copy of a real
  config, never the live one.

## Decisions taken

The three questions this spec opened with, answered:

1. **Discovery port** — 8789, and adjustable. No known conflict on the production
   LAN; the setting exists so a future one is a settings change.
2. **Ethernet and Wi-Fi both.** The Pis are on Wi-Fi today, so a Wi-Fi install pins
   the connection MAC to keep the re-identification hint dependable.
3. **A second server on the same LAN** — the reply carries a server name; unclaimed
   devices surface only during a scan; and a device carries its own binding so
   claiming it on one server removes it from every other. No server-to-server
   protocol.

## Still open

- **Scan cadence for the lazy periodic scan.** Every few minutes is the proposal;
  the right number is easier to pick once the Devices page exists and it is
  obvious how long "I just plugged it in" should feel.
- **Force-claim from a decommissioned server.** The *bound elsewhere, unreachable*
  path is described above but its UI is not designed. It can wait — it is a
  recovery case, not a setup one.
