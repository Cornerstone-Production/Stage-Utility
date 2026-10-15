# Kiosk devices

A kiosk device is a machine that shows a display — a Raspberry Pi on a wall, a
laptop on a cart, a PC at FOH. You install an agent on it once; it finds the
server itself and waits to be claimed.

Nothing on the device knows which display it is. The server decides that, once,
when you set it up on the **Screens** page.

There is no separate page for them. A device that has been heard but not set up
is a screen you have not finished configuring, so it appears in a banner at the
top of Screens and under *Not set up yet*, below the cards, and once it is set up
it becomes a line on that screen's own card.

## Setting one up

**1. Turn discovery on.** Settings → Advanced → Server → *Answer devices
looking for a server*. It is off until you switch it on, so a test instance on
the same network cannot claim a screen meant for the real server. Restart the
server afterwards.

**2. Run the installer on the screen.** The exact command, with this server's
address already in it, is under *Setting up a screen* on the same card — click
"Show commands" to reveal it.

| | |
|---|---|
| Linux / Raspberry Pi | `curl -fsSL http://<server>/kiosk/install-linux.sh \| sudo sh` |
| macOS | `curl -fsSL http://<server>/kiosk/install-macos.sh \| sudo sh` |
| Windows (elevated) | `irm http://<server>/kiosk/install-windows.ps1 \| iex` |

On a Mac the same command installs the [Mac output helper](#installing-the-mac-output-helper)
instead of a browser. The Chrome kiosk is still there for a Mac the helper cannot
run on: add `-s -- --browser` after `sh`.

**3. Set it up.** Open **Screens**. A screen that has been heard and not set up
is named in a banner at the top of the page, with **Set up** beside it, and again
under *Not set up yet*, which sits directly below the cards. Having the page open
is also what gets the device answered (see [Discovery](#discovery)). Under *Not
set up yet* the new device offers two things:

| | |
|---|---|
| **Set up as a new screen** | Opens the [Screen settings panel](features/operator-app.md#adding-a-screen) in two guided steps for this device: its name, then what it shows. **Create screen** makes the screen and binds the device to it in one step; closing the panel first makes nothing. |
| **Use for an existing screen** | Binds it to a screen that already exists — the hardware-swap case. |

The screen redirects itself; you do not have to walk to it.

**Dismiss** on the banner hides one device from the banner in that browser; it
stays under *Not set up yet*, and **Show dismissed** brings it back. Screens in the
sidebar shows how many devices are not set up, from any page.

Nothing is created just because a device was heard. A spare machine booting
mid-service would otherwise mint a screen nobody asked for, and deleting it
would not stick while it kept announcing itself.

A screen that is not set up yet shows its own device id, address, hostname, MAC
and size, large enough to read from across a room. That is how you tell four
identical Pis apart.

## Installing the Mac output helper

On macOS 14 or later, on Apple silicon or Intel, `install-macos.sh` installs the
**Stage Utility Output** helper, a menu bar app that turns the Mac's displays and
DeckLink SDI ports into screen devices. What the helper does once it runs is
under [Mac output helper](#mac-output-helper); this is how it gets there.

```sh
curl -fsSL http://<server>/kiosk/install-macos.sh | sudo sh
```

| Option, after `sudo sh -s --` | |
|---|---|
| `--dry-run` | Prints every step and changes nothing. Needs no `sudo` |
| `--browser` | The Chrome kiosk instead, one full-screen browser with the same identity files. For a Mac the helper cannot run on, such as one older than macOS 14 |

**What it does:**

1. Keeps the Mac's `device-id`, `token` and `server` file in
   `/Library/Application Support/StageUtility/`, and makes them as the Chrome kiosk
   did if they are missing. Running the installer again never makes a new id.
2. Downloads `StageUtilityOutput-arm64.zip` or `StageUtilityOutput-x86_64.zip`,
   whichever this Mac is (an Apple silicon Mac gets the arm64 app even from a shell running under Rosetta), and checks its SHA-256. The app is a few hundred MB
   because it carries Chromium.
3. Unpacks it beside `/Applications`, checks it is the helper, then swaps it in. The
   old copy is kept until the new one is in place and put back if anything fails,
   so a Mac is never left without the app.
4. Writes `/Library/LaunchAgents/com.stageutility.output.plist`, root-owned, the same
   place the Chrome kiosk's agent lived, so the helper starts at every GUI login of
   any account, is restarted if it crashes, and stays closed if someone quits it. If
   someone is logged in it is started for them now; if nobody is, it starts at the next
   login, and the installer says so. The helper's own *Open at login* switch adds a
   second way to start it, which does no harm: a second copy hands over to the first.
5. Turns off display sleep and system sleep (`pmset`), and sets the console user's
   screen saver to never and the password after it to off, where macOS accepts it. With
   nobody logged in the screen saver is left alone, since it is a per-account setting,
   and the token is readable by administrators until an account owns it: if the first
   account to log in is not one, run the installer again after it has.

Running it again upgrades in place.

**Where the app comes from.** The installer asks the server first: the address in
`STAGE_DOWNLOAD_FROM` if set, else `STAGE_SERVER`, else the one the server stamped into
the script when it served it, else the `server` file of an earlier install. A script
saved and run by hand has no stamped address, so it needs one of the first two:
`sudo STAGE_DOWNLOAD_FROM=http://<server> sh install-macos.sh`. That names the server for
this run and saves nothing. `STAGE_SERVER` is a different choice: it also writes the
`server` file, which pins the Mac to that server and skips discovery for good, so the
Mac does not follow the server if it moves. Use it only where discovery's broadcast
does not cross. If that server cannot supply a zip
that matches its checksum, it falls back to the GitHub release for the version in the
server's `/api/update/status`. If neither works, it installs nothing and says what each
answered.
A server that has not cached the zip yet sends nothing until it has all of it, so the
installer waits on a server for up to 2 hours 10 minutes. A download from GitHub is given
up on after a minute below 1 KB/s, with the same overall limit.

| Request | |
|---|---|
| `GET /kiosk/StageUtilityOutput-<arch>.zip` | The app. The first request fetches it from the GitHub release matching the server's version and checks it against the checksum the release publishes; later requests come from the cache |
| `GET /kiosk/StageUtilityOutput-<arch>.zip.sha256` | That zip's SHA-256, one line, which the installer compares its download with |

The cache is `cache/output-helper/<version>/` in the data directory. It holds the
running version only, is not part of a config backup, and costs one download to
rebuild. One fetch runs at a time per file, a transfer that goes a minute without data is
given up on (one that keeps moving, however slowly, is not, up to two hours in all),
and a file over 1 GB is refused. A download that does not match
its checksum is never stored and answers `502`. A cached zip is hashed again against
its checksum the first time it is served after the server starts, and again whenever its
size or modification time changes, so a file damaged on disk is dropped and fetched
again rather than served; every other request is a single stat.

**Disk use.** Each architecture's zip is about 145 MB, so a version takes about 290 MB
once Macs of both kinds have asked for it, and only an architecture someone has asked
for is stored. On a Pi that serves from an SD card, that is real space. Older versions
are removed when the server starts and on the first request after an update, so the
cache never holds more than one.

**With no internet on the server** and nothing cached, the route answers `404`
with the reason. The installer then goes to GitHub from the Mac itself, so a Mac
with internet still installs; a Mac with none cannot until the server has the file,
which any request for the zip made while the server is online puts in its cache. A
release made before the helper existed has no zip, and answers `404` the same way.
Each release attaches the two zips and their `.sha256` files when the build ran for it;
see [distribution](ops/distribution.md#what-a-release-contains).

A release whose helper build failed has no zips either, and the installer does not get
around that: a Mac whose server runs that version cannot install the helper, from the
server or from GitHub, until the server updates to a release that has them.

**Coming from the Chrome kiosk.** If the earlier agent is there
(`com.stageutility.kiosk`), the installer writes
`/Library/Application Support/StageUtility/migrated-from-kiosk` before it stops, swaps
in or starts the helper, because the helper reads the file once, when it launches. Once
the helper's agent is in, it stops the kiosk's agent and removes its LaunchAgent and
launcher. The file is written only for a Mac that has the kiosk's agent, never on a
fresh install, and a failure anywhere in the install takes it back and leaves the kiosk
as it was. The Mac keeps its device id, token and Chrome profile. The helper reads the
file and gives the Mac's main display the kiosk's own id and token, and turns it on, so
the screen the Chrome kiosk showed comes back by itself on that display. The Mac's other
displays are new outputs under *Not set up yet*. Deleting the file stops the helper doing
this. With nobody logged in the kiosk is replaced at the next login.

**Removing the helper.** Quit it from its menu bar icon, then, as root:

```sh
launchctl bootout gui/<uid>/com.stageutility.output
rm -f /Library/LaunchAgents/com.stageutility.output.plist
rm -rf /Applications/StageUtilityOutput.app
```

The plist is what starts it at every login, so removing only the app leaves an agent
trying to launch a missing one. The helper's own state folder,
`~/Library/Application Support/StageUtilityOutput`, can go too if you do not want
its settings back. The device id in `/Library/Application Support/StageUtility` stays,
so installing again keeps the Mac's binding. `install-macos.sh --browser` on a Mac that
has the helper prints these same commands rather than running them.

**What a person still has to do, once, at the Mac.** macOS does not let a script:

- turn on **automatic login** (System Settings → Users & Groups). The helper's browser
  needs a logged-in session;
- answer the **Local Network** prompt the first time the helper opens ("Allow Stage
  Utility Output to find devices on local networks?"). Without it the helper cannot
  find the server, and says so in its own window. The answer is tied to the app's
  signature, so after an update macOS may ask again;
- check **Lock Screen**: require a password after the screen saver or display off is
  *Never*, and the screen saver and display-off times read *Never*. The installer sets
  them where macOS accepts it, and a managed Mac may not.

The installer prints this list when it finishes. On a Mac that is not coming from the
Chrome kiosk, the main display, the one with the menu bar, is off until you turn it on
in the helper's window.

## Size

Two things say how big a screen is, and they can disagree:

- the **browser** reports CSS pixels on every platform;
- the **physical mode** is read from `/sys/class/drm` and put on the discovery
  probe. Linux only.

A disagreement is the useful part — `1280 × 720 (driving 1920 × 1080)` means the
desktop is scaled, which is the usual reason a 1080p panel renders a 720p layout.
Both are kept, and both are shown on the card and on the screen itself.

Only the device bound to a screen may report that screen's size. Opening a
display's URL in a browser to check on it does not overwrite it — otherwise a
phone held up to the wall would record itself as the screen.

## What survives what

The device id is generated once at install and stored outside any browser
profile:

| OS | Path |
|---|---|
| Linux / Pi | `/var/lib/stage-utility-display/device-id` |
| macOS | `/Library/Application Support/StageUtility/device-id` |
| Windows | `%PROGRAMDATA%\StageUtility\device-id` |

So clearing browser data, wiping a cache, resetting a profile, a reboot, a DHCP
change or the server moving all leave the binding intact. Re-running the
installer keeps the existing id on purpose.
The Mac output helper reads the same file. Each of its outputs is a device whose
id starts with it, so one Mac's outputs keep their bindings across a re-install.

You have to claim again only after a full OS reinstall or on different hardware —
which is a different device. Even then, if the MAC matches a screen that is
claimed but offline, Screens says so and offers to re-bind it.

## Bindings, and more than one server

A binding is to an **output**, not to a name — so a replacement Pi claimed as
*Left Mic Display* inherits that output's view, its slug and every QR code
pointing at it.

A device carries its own binding, which is what keeps two servers out of each
other's way:

- an **unclaimed** device shows on every server that hears it, which is harmless;
- the moment you claim it on one, its probe says so and every **other** server
  ignores it.

No coordination between servers, and nothing to get out of sync.

A device that cannot reach the server that owns it keeps trying and says so on
screen. It does not re-home itself — a display that changed servers during an
outage would be worse than a dark one — but other servers can show it as *bound
elsewhere* behind an explicit force-claim, so recovering from a decommissioned
server does not need SSH.

## Discovery

The device broadcasts a probe on **UDP 8789** and the server answers it unicast.
The port is adjustable, because AV gear is fond of odd ports.

- A device bound to **this** server is always answered, so a display re-finds its
  server after an IP change with nobody present.
- An **unclaimed** device is always **listed**: the server records every one it
  hears, with no scan to open, so the banner, *Not set up yet* and the sidebar
  count are filled the moment anyone looks. A device not heard for 90 seconds
  drops out, and at most 256 are listed at once (the log says when it is full).
- An unclaimed device is **answered** only while a scan is open, which is for as
  long as a Screens page is open (or a short window after one is pressed). A device
  binds to the first server that answers it, so a server answering every new device
  at all times would race any other Stage Utility on the network for it. The answer
  is also what puts the holding screen, with its id, address and MAC, on the
  physical screen.

Where broadcast does not cross a VLAN, write the server address into a `server`
file beside the device id and discovery is skipped.

## Reliability, honestly

Not every platform is equal at this, and pretending otherwise is how a screen is
dark on a Sunday:

- **Raspberry Pi** — the intended home. Auto-login, blanking, browser flags and
  update policy are all controlled.
- **Linux desktop** — nearly as good, subject to whatever else the machine does.
- **macOS / Windows** — best-effort. They need automatic login enabled and sleep
  and screen lock turned off, and they live on a general-purpose OS that reboots
  for updates on its own schedule. Good for a laptop on a cart; not what to
  deploy for a permanent wall screen. On a Mac that is a screen for several
  outputs, use the [output helper](#installing-the-mac-output-helper); with
  `--browser` the installer sets up one Chrome kiosk.

The installers set what they can and print what is left. On macOS, automatic
login is not scriptable and the screen saver may not be; the helper installer sets
what it can. On Windows, automatic login is set in `netplwiz`.

## The prebuilt Pi image

Flash and boot, with no SSH step. Built by the **Kiosk image** workflow on
demand, not on every release — the image changes rarely, because what is on
screen is a web page from the server, so the payload updates itself and only the
OS and kiosk layer live in the image.

It runs the SAME `install-linux.sh` this server hands out, on first boot rather
than during the build: the device id and secret must be unique per SD card, and
generating them at build time would put one identity on every card ever flashed.

**Wi-Fi credentials are not in the image.** Raspberry Pi Imager already sets
SSID, password, hostname and SSH keys, and its customisation applies to this
image like any other Raspberry Pi OS one — so they go in at flash time, on the
machine doing the flashing. This repository is public; a released image must
never carry a credential or a site's server address.

## Mac output helper

A Mac running the **output helper** (a menu bar app) is not one screen but
several: each of its own displays and each port of a Blackmagic DeckLink or
UltraStudio card is a separate output. The helper announces one device per
output and the server sets each up like any other. A screen can therefore go out
over SDI from a Mac mini, and the SDI ports are not counted against the Mac's
limit on external displays.

Each output is a device of its own, with an id of the form
`<the Mac's device id>.<output key>`. A binding is to an output, so moving a
cable to another port moves which screen goes out where. All of a Mac's outputs
share its MAC addresses and hostname. Screens groups outputs by the Mac's id in
that name, not by MAC address: Intel Macs with a T2 chip report the same MAC, and
two of them stay two machines.

The probe gains an `output` object, otherwise the probe described under
[Discovery](#discovery):

| Field | |
|---|---|
| `kind` | `display` or `decklink`. A probe with any other kind is treated as a plain device |
| `name` | What the row calls it, for example `SDI 1 · Card A` |
| `port` | The physical port, for example `SDI 1` |
| `modes` | Optional. The video modes a DeckLink port reported, for example `1080p59.94` |

A probe without `output` behaves exactly as it always has. Every field is
bounded like the rest of the probe: names and ports at 128 characters, at most
24 modes of 32 characters each.

**On the server's own Mac.** The responder ignores a probe that carries one of
the server's own MAC addresses, because a kiosk agent on the server's machine was
never a wall screen. A probe with an `output` is let through, so the helper on the
server's Mac works.

The stored binding keeps the `output`, so a bound screen still names its port
while the output is off.

**On Screens.** The outputs of one Mac are grouped under the Mac in *Not set up
yet*: its hostname, OS, address and the DeckLink card its SDI ports are on once,
then a row per output, displays first and SDI ports after, each with the two
actions above and what it is: a display reads `Built-in display · 1920 × 1080`
and the refresh rate when the Mac reports one. An output that already has a
screen stays in the group, dimmed, saying which screen it is set up as and
whether that screen is showing. A Mac whose outputs are all set up is not
listed. Outputs of one Mac are not flagged *Looks like … same MAC address*
against each other; a device that is not an output keeps that hint. An output
set up as a new screen starts named for the output, not for the Mac.

A screen's card says `<hostname> · <port> · <mode>`: the Mac, the port, and the
video mode the port sends (a display shows the size it is driven at). Its
[Screen settings](features/operator-app.md#adding-a-screen) Device section shows the port and
card, whether the screen is online, **Format** (DeckLink ports only, from the
modes the port reported that the server accepts, otherwise all of them),
**Rotation**, the output's health and **Release**. Releasing returns the output
to *Not set up yet*.

**Format and rotation** are settings of the screen, not of the Mac: a DeckLink
port's video mode (`videoMode`, `1080p59.94` unless changed) and a quarter-turn
rotation for a monitor on its side (`rotation`, 0 unless changed). They are
written through `PATCH /api/outputs/:id`, are in every backup, and the helper
reads its output's record from `GET /api/outputs`. The helper applies rotation to
every output and opens each DeckLink port in its Format; see
[Running the helper](#running-the-helper-beta) and the [API](reference/api.md).

**Health.** Each output reports every ten seconds, authenticated by the device's
own secret, and the server keeps the latest in memory only. It is shown with the
screen: frames per second, the percent of frames repeated because the page was
late, and the frames the card has dropped. A DeckLink output that has measured it
also shows its **latency**, in milliseconds from render to air; the line is absent
until the helper reports one. Latency is information only and does not count
towards *struggling*. Three reports running with frames dropped or 5% or more
repeated mark a DeckLink output **struggling**, and three clean ones in a row clear it. A display output is never marked: its rate comes
from the display link, which stops while the display sleeps or the screen is
locked, so it can report 0 fps while healthy, and Screens shows that as a dash. A
struggling output also puts a warning on its screen's card, under the preview: the
port, what the report shows (the percent of frames repeated, the frames the card
dropped) and what to check. A reading that stops being refreshed is dropped after
60 seconds. Until one arrives, the Device section says the helper has not reported
yet; after one was dropped, that it stopped reporting; and for a screen no page is
showing, that it is offline.

### Running the helper (beta)

Build it with `helper/macos/build-app.sh --arch arm64` (or `x86_64`; macOS 14 or later,
and the Command Line Tools are enough). That downloads the pinned Chromium Embedded
Framework, checks its checksums, and writes `StageUtilityOutput.app` for that
architecture, about 325 MB, signed ad hoc. It renders every screen in Chromium, as the
Raspberry Pi kiosks do. Open it: the menu bar icon opens its window, where each of the
Mac's displays and DeckLink ports has a switch and a status line. Launching it again
brings the window back. Where `/Library/LaunchAgents/com.stageutility.output.plist`
exists, it starts at every login from that LaunchAgent, and the window says "Starts at
login (installed)"; the installer writes the file, see
[Installing the Mac output helper](#installing-the-mac-output-helper).

**DeckLink outputs.** Each output port of a Blackmagic DeckLink or UltraStudio card
appears under *Not set up yet* as its own output, named as Blackmagic's driver names
it ("DeckLink Duo 2 (3)"), with the formats the port can play, and is set up like a
display. It needs Blackmagic's **Desktop Video** driver, 12.0 or later, installed on
the Mac; without it there are no DeckLink outputs and the helper's window says so.
**Restart the helper after installing or updating Desktop Video**: it looks for the
driver only when it starts. The screen's **Format** (1080p59.94 unless changed) is the
mode the port is opened in; a change reopens it, and a format the port does not have
is refused, with the reason on that output's line in the helper's window. Rotation
applies as it does on a display. A card unplugged keeps its screen and comes back by
itself when plugged in again. A connector set as an input in Desktop Video Setup is
not an output: the window lists it as "Set as an input in Desktop Video Setup", and it
appears under *Not set up yet* within about 10 s of being set as an output. A DeckLink
output runs 20 ms behind its page at 1080p59.94, and its line in the window says how
far behind it is.

Flags, for a Mac nobody is looking at: `--show-window`, `--list-outputs` (reads the
stored state and exits), `--dump-frames <dir>` (a PNG of every output and of the window
every 5 s, with no Screen Recording permission), `--discovery-port <n>`, `--log-stderr`,
and, for development, `--virtual-sdi <n>` (n SDI outputs with no card behind them,
offering every format, so the whole card path runs on any Mac), `--test-pattern
latency` (a clock on every output, to photograph two side by side), `--frame-timings
<file>` and `--head-start`/`--fill-lead <ms>`. The log is the unified log, subsystem
`com.stageutility.output`.

Where `/Library/Application Support/StageUtility/migrated-from-kiosk` exists, the Mac
was a Chrome kiosk and keeps its screen: its main display takes over the kiosk's device
id and secret. The installer writes the marker, see
[Installing the Mac output helper](#installing-the-mac-output-helper).

Everything else about it (state files, discovery, health, rotation, DeckLink outputs,
Chromium and its sandbox, the Local Network permission, recovering an output from a
server that is gone) is in [helper/macos/README.md](../helper/macos/README.md), and the
DeckLink layer itself in [helper/macos/DECKLINK.md](../helper/macos/DECKLINK.md).

## Removing one

*Release*, on the screen's card, unbinds it: the screen keeps its view and its
slug and simply has no machine showing it, and the device returns to the holding
screen.

Uninstalling the agent leaves the device id in place, so reinstalling on the same
machine does not orphan the binding.
