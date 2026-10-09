# Kiosk devices

A kiosk device is a machine that shows a display — a Raspberry Pi on a wall, a
laptop on a cart, a PC at FOH. You install an agent on it once; it finds the
server itself and waits to be claimed.

Nothing on the device knows which display it is. The server decides that, once,
when you set it up on the **Screens** page.

There is no separate page for them. A device that has been heard but not set up
is a screen you have not finished configuring, so it appears under *Not set up
yet* at the bottom of Screens, and once it is set up it becomes a line on that
screen's own card.

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

**3. Set it up.** Open **Screens** and look under *Not set up yet* — being on
that page is itself the scan. The new device offers two things:

| | |
|---|---|
| **Set up as a new screen** | Opens the [Screen settings panel](features/operator-app.md#adding-a-screen) in three guided steps for this device. **Create screen** makes the screen and binds the device to it in one step; closing the panel first makes nothing. |
| **Use for an existing screen** | Binds it to a screen that already exists — the hardware-swap case. |

The screen redirects itself; you do not have to walk to it.

Nothing is created just because a device was heard. A spare machine booting
mid-service would otherwise mint a screen nobody asked for, and deleting it
would not stick while it kept announcing itself.

A screen that is not set up yet shows its own device id, address, hostname, MAC
and size, large enough to read from across a room. That is how you tell four
identical Pis apart.

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
- An **unclaimed** device is only recorded while a scan is open — pressed in
  Screens, held for as long as that page is open, or a short window every few
  minutes.

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
  deploy for a permanent wall screen.

The installers set what they can and print what is left. On macOS, automatic
login and the screen saver are not scriptable; on Windows, automatic login is set
in `netplwiz`.

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
share its MAC addresses and hostname.

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
yet*: its hostname, OS and address once, then a row per output, displays first and
SDI ports after, each with the two actions above. An output that already has a
screen stays in the group, dimmed, saying which screen it is set up as and
whether that screen is showing. A Mac whose outputs are all set up is not listed.
Outputs of one Mac are not flagged *Looks like … same MAC address* against each
other; a device that is not an output keeps that hint. An output set up as a new
screen starts named for the output, not for the Mac.

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
display outputs, and DeckLink outputs apply Format; the helper does not drive
DeckLink ports yet, so Format is saved but nothing sends it. See the
[API](reference/api.md).

**Health.** Each output reports every ten seconds, authenticated by the device's
own secret, and the server keeps the latest in memory only. It is shown with the
screen: frames per second, the percent of frames repeated because the page was
late, and the frames the card has dropped. Three reports running with frames
dropped or 5% or more repeated mark a DeckLink output **struggling**, and three
clean ones in a row clear it. A display output is never marked: its rate comes
from the display link, which stops while the display sleeps or the screen is
locked, so it can report 0 fps while healthy, and Screens shows that as a dash. A reading that stops being refreshed is dropped after 60
seconds.

## Removing one

*Release*, on the screen's card, unbinds it: the screen keeps its view and its
slug and simply has no machine showing it, and the device returns to the holding
screen.

Uninstalling the agent leaves the device id in place, so reinstalling on the same
machine does not orphan the binding.
