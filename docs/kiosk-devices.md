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

**1. Turn discovery on.** Settings → Advanced → Kiosk devices → *Answer devices
looking for a server*. It is off until you switch it on, so a test instance on
the same network cannot claim a screen meant for the real server. Restart the
server afterwards.

**2. Run the installer on the screen.** The exact command, with this server's
address already in it, is on that same panel.

| | |
|---|---|
| Linux / Raspberry Pi | `curl -fsSL http://<server>/kiosk/install-linux.sh \| sudo sh` |
| macOS | `curl -fsSL http://<server>/kiosk/install-macos.sh \| sudo sh` |
| Windows (elevated) | `irm http://<server>/kiosk/install-windows.ps1 \| iex` |

**3. Set it up.** Open **Screens** and look under *Not set up yet* — being on
that page is itself the scan. The new device offers two things:

| | |
|---|---|
| **Set up as a new screen** | Creates a screen and binds the device to it in one step. |
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

## Using one for signage

A screen showing graphics on a schedule is set up exactly like any other — it is
the VIEW it is routed to that makes it signage, and Signage can do that routing
for you. See [signage](features/signage.md).

## Removing one

*Release*, on the screen's card, unbinds it: the screen keeps its view and its
slug and simply has no machine showing it, and the device returns to the holding
screen.

Uninstalling the agent leaves the device id in place, so reinstalling on the same
machine does not orphan the binding.
