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
instead of a browser. For a Mac the helper cannot run on, `-s -- --browser` after
`sh` installs a Chrome kiosk instead. On Windows it installs a launcher that follows
the server's version on its own: see [The Windows kiosk's launcher](#the-windows-kiosks-launcher).

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

**Dismiss** on the banner hides one device from the banner, in that browser only:
nothing changes on the server, the device stays under *Not set up yet*, and the
toast offers **Undo**. **Show dismissed** brings every dismissed device back, and
**See all below** scrolls to *Not set up yet*. A dismissal is remembered for 30
days. A device that is set up is no longer dismissed, so if it is released later it
is named again. The **Screens** entry in the sidebar carries a count of the devices
not set up, from any page. A device that is set up on another server is listed under
*Not set up yet* but is not counted.

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
6. Installs the updater, so the helper follows the server's version from then on (see
   [Keeping the helper on the server's version](#keeping-the-helper-on-the-servers-version)).
   A failure here is said plainly and leaves the helper installed; run the installer
   again to add it.

Running it again upgrades in place.

**Where the app comes from.** The installer asks the server first: the address in
`STAGE_DOWNLOAD_FROM` if set, else `STAGE_SERVER`, else the one the server stamped into
the script when it served it, else the `server` file of an earlier install. A script
saved and run by hand has no stamped address, so it needs one of the first two:
`sudo STAGE_DOWNLOAD_FROM=http://<server> sh install-macos.sh`. That names the server to
download from without pinning the Mac to it; the updater installed with the helper asks
that server from then on, as it asks whichever server an install came from, so run it
from the server the Mac belongs to. `STAGE_SERVER` is a different choice: it also writes the
`server` file, which pins the Mac to that server and skips discovery for good, so the
Mac does not follow the server if it moves. Use it only where discovery's broadcast
does not cross. If that server cannot supply a zip
that matches its checksum, it falls back to the GitHub release for the version in the
server's `/api/update/status`, taking the digest from the releases API and the zip from
the release's downloads. The API call carries no token, so GitHub allows 60 an hour per
network; a refusal for that says so. If neither works, it installs nothing and says what each
answered.
A server that has not cached the zip yet sends nothing until it has all of it, so the
installer waits on a server for up to 2 hours 10 minutes. A download from GitHub is given
up on after a minute below 1 KB/s, with the same overall limit.

| Request | |
|---|---|
| `GET /kiosk/StageUtilityOutput-<arch>.zip` | The app. The first request fetches it from the GitHub release matching the server's version and checks it against the SHA-256 the releases API lists for that asset; later requests come from the cache |
| `GET /kiosk/StageUtilityOutput-<arch>.zip.sha256` | That zip's SHA-256, one `shasum` line the server builds from the release's digest, which the installer compares its download with. It is read once per version and cached beside the zip. A refusal is not cached, so each retry asks the releases API again, from the same 60-an-hour allowance the update check uses |

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
Each release attaches the two zips when the build ran for it, and GitHub lists a digest
for each; see [distribution](ops/distribution.md#what-a-release-contains). A release
whose zip has no digest cannot be verified: the server answers `502` and says so, and
the installer's GitHub fallback refuses it the same way.

A release whose helper build failed has no zips either, and the installer does not get
around that: a Mac whose server runs that version cannot install the helper, from the
server or from GitHub, until the server updates to a release that has them.

### Keeping the helper on the server's version

The helper's version is the server's, so a helper is up to date exactly when it runs
the version in the server's `/api/update/status`. When the server updates, each Mac
installs the same version on its own, with nobody at it.

The installer leaves an updater beside the helper: in
`/Library/Application Support/StageUtilityUpdater/`, a folder only root can write, a
copy of the installer, the Mac's device id, and the server the install downloaded
from (the one `STAGE_SERVER` names, when the Mac is pinned); and a LaunchDaemon,
`/Library/LaunchDaemons/com.stageutility.output-updater.plist`, that runs the copy with
`--check-update` every five minutes and at boot. It reads nothing from the state
folder, which the logged-in account owns. Each run:

1. Asks that server whether to update (`GET /api/machine-updates/check`), saying which
   Mac it is, what it runs and what it last did. A server that moves to another
   address is followed by the helper (discovery) but not by the updater: run the
   installer again from the new address.
2. **The server decides when.** Never while Planning Center reports a service live,
   and not within the window around a rehearsal or service (the same window integration
   reconnects use, [Winding down between services](ops/reliability.md#winding-down-between-services):
   *Lead time before rehearsal* and *Keep active after service ends* in Settings >
   Advanced > Server). Not with *Update Mac output helpers and Windows kiosks with this
   server* off (Settings > Advanced > Server; on by default), and not again for a
   version that already failed on that Mac. With Planning Center set up, not until its
   service times and live state have been read: just after the server starts, and
   while Planning Center cannot be reached, a Mac waits. **Update now** and **Try
   again** override the switch, the window, not knowing and a past failure, never a
   live service. With no Planning Center there is no window, and a Mac updates within
   five minutes of the server.
3. Downloads the zip and its SHA-256 from that server exactly as an install does,
   checks the app in it is the version the server named, and clears any
   set-user-id bit (root unpacks it).
4. Stops the helper, swaps the new app in keeping the old one, and starts it through
   launchd. The download, the check and the unpacking all happen while the old helper
   is still on air; only the restart takes the outputs off. Measured on an automatic
   update on an M4 Mac mini with a DeckLink 8K Pro, the SDI port reopened 2.7 s after
   launchd had the old helper gone, and the screen was showing again 0.1 s later.
5. Waits up to 90 s for the new helper to say, in `helper-status.json` in the
   logged-in account's `~/Library/Application Support/StageUtilityOutput/` (only a
   regular file that account owns is read), that it is the new version, with the pid
   launchd started, and that Chromium started. If it does not, the old app goes back
   and is started again; if that one does not come back within 20 s the updater
   restarts it itself, and says so if it still cannot.

**When an update fails.** A failure that belongs to the version (the new helper did
not start, the server sent another version, the zip is not the helper) holds that
version until someone presses Try again. A failure that does not (the download did not
finish, the Mac shut down in the middle) is tried again on its own, half an hour later,
then an hour, two, four, and every six hours after, and Screens shows it as retrying.
A failed update keeps the outputs off air longer than a good one: the new helper is
given its chance to start before the old one goes back. Measured with a build whose
browser host was missing, on the Mac above, it was 22 s from the old helper stopping to
its picture being back. An install run by hand and an update never overlap: whichever
starts second waits for the first (an install by hand up to three minutes).

It does not update a Mac nobody is logged in to (the new helper could not be started
and checked), nor start a helper someone quit at the Mac (to free a card for another
app, say): each waits, and Screens says why. It never runs anything it downloaded as
root: it swaps the app, which runs as the logged-in account. A change to the installer
itself, the agent file it writes for instance, reaches a Mac only when the installer is
run again by hand, and a release that needs that says so in its notes.

**What it trusts.** The app is downloaded over the network from the server, and checked
against the SHA-256 that same server publishes, exactly as `curl ... | sudo sh` already
trusts the server it is pointed at. That checks the download is whole, not who sent it:
anything that can answer as the server on its address can also offer an update. So the
updater only ever asks the address recorded at install, in a folder only root can
write, never one a logged-in account or the network can change (the state folder's
`server` file, discovery); and what it installs runs as the logged-in account, as the
helper always has.

**Installed before this.** A helper installed by an installer older than 1.27.0 has no
updater, and needs the installer run once more, at the Mac, to get it. Its screens say
*Helper version unknown. Run the macOS installer once* once the server has been up
longer than a check takes.

**What Screens shows.** Each screen shown by a helper output has a line under its
device saying what the Mac's helper runs and what it was told: up to date, waiting
(with why, and until when), updating, retrying, updated, or failed and put back
(with why).
Screen settings > Device has the same as a **Helper** row, with **Update now** when
automatic updates are off and **Try again** after a failure. Both act at the Mac's next
check, within five minutes.

**Local Network after an update.** macOS keeps the Local Network answer by bundle id,
and the logs on a Mac running the helper show it kept across an ad hoc signed update.
If it ever asks again, the helper says so in its window and on its outputs, and since it
then cannot reach the server itself, the updater reports it: the screen's line and
`/log` say someone at the Mac has to choose Allow.

**Logs.** On the server, `[helper-update]` lines on `/log`: each Mac's decision when it
changes (waiting and why, going ahead, up to date), what it reports it did (updated,
failed and why, retrying and why, waiting for a login, the helper quit, Local Network
refused), Update
now pressed, and a Mac that stopped checking. Never one per check. On the Mac,
`/Library/Logs/StageUtility/helper-update.log`, the same decisions as the updater saw
them, with the download and the swap.

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

**Removing the helper.** `scripts/uninstall.sh` removes it, as root:

```sh
sudo ./scripts/uninstall.sh --dry-run   # say what it would do, change nothing
sudo ./scripts/uninstall.sh
```

A Mac with no checkout fetches it:
`curl -fsSL https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/main/scripts/uninstall.sh | sudo bash`
(`bash -s -- --dry-run` previews). It stops the updater and removes its LaunchDaemon
and its folder first, so a run mid-update cannot put the app back, then stops the
helper with `launchctl bootout` in every account that has it loaded, and removes the
LaunchAgent and the app. It also
removes the Chrome kiosk's agent and launcher where `--browser` installed them, and
removes the Stage Utility server if one is on the same Mac (its launchd daemon,
`com.stageutility.server`, or `com.cornerstone.stage-utility` from an install that
predates that label). A copy of the helper opened by hand is not launchd's: the script warns that it is still running and leaves
it for you to quit from its menu bar icon.

It lists, and does not remove, the Mac's device id and token in
`/Library/Application Support/StageUtility` and each account's
`~/Library/Application Support/StageUtilityOutput` (`outputs.json` holds the outputs'
secret tokens). With the device id kept, installing again keeps the Mac's binding;
removing it makes the Mac a new device whose screens are claimed again.

It does not put back the sleep and screen saver settings: the installer turned off
display sleep, system sleep and the screen saver's idle time and password, and does
not record what they were. The script prints the commands to set them, or set them in
System Settings > Lock Screen.

By hand, as root: `launchctl bootout system/com.stageutility.output-updater` and remove
`/Library/LaunchDaemons/com.stageutility.output-updater.plist` and
`/Library/Application Support/StageUtilityUpdater`, then
`launchctl bootout gui/<uid>/com.stageutility.output`, and remove
`/Library/LaunchAgents/com.stageutility.output.plist` and
`/Applications/StageUtilityOutput.app`. The plist is what starts the helper at every
login, so removing only the app leaves an agent trying to launch a missing one.
`install-macos.sh --browser` on a Mac that has the helper prints these same commands
rather than running them.

**What a person still has to do, once, at the Mac.** macOS does not let a script:

- turn on **automatic login** (System Settings → Users & Groups). The helper's browser
  needs a logged-in session;
- answer the **Local Network** prompt the first time the helper opens ("Allow Stage
  Utility Output to find devices on local networks?"). Without it the helper cannot
  find the server or load its pages, and says so in its own window and on each output.
  It is the helper's one entry in System Settings > Privacy & Security > Local Network.
  macOS keeps the answer by bundle id, and the logs on a Mac running the helper show it
  kept across an update;
- check **Lock Screen**: require a password after the screen saver or display off is
  *Never*, and the screen saver and display-off times read *Never*. The installer sets
  them where macOS accepts it, and a managed Mac may not.

The installer prints this list when it finishes. On a Mac that is not coming from the
Chrome kiosk, the main display, the one with the menu bar, is off until you turn it on
in the helper's window.

## The Windows kiosk's launcher

The Windows installer writes the device's identity to `%PROGRAMDATA%\StageUtility\`
as before, and downloads the launcher, `kiosk-windows.ps1`, from the server it was
fetched from into that folder as `kiosk.ps1`. The download must be the one the server
names: the installer asks `GET /api/machine-updates/check`, as the updater does, for
the launcher's SHA-256 (updates held or not: the switch stops updates, not a first
install), saying what it downloaded, and installs the file only when its SHA-256 is
the one named and it parses. A server that does not answer, or names no SHA-256,
leaves the launcher as it was (none, on a first install) and the installer stops. This
shows the PC in Screens at once; the updater's first check takes over from there.
That proves the file arrived whole from this server over the same plain-HTTP
connection, not who sent it: anything that can answer as the server can name its own
digest. The updater script the installer also downloads is only checked to parse,
since the server names no SHA-256 for it. The scheduled task `StageUtilityKiosk`
runs it at every sign-in and every minute; it finds the server and opens the
browser on the device's `/enroll` address. The discovery port is in the `port` file
beside it (`STAGE_KIOSK_PORT` at install, 8789 by default).

**Where it downloads from.** The address in `STAGE_DOWNLOAD_FROM` if set, else
`STAGE_SERVER` (which also pins the PC to that server, as on a Mac), else the one the
server stamped into the installer when it served it, else the `server` file of an
earlier install. An installer saved and run by hand has no stamped address:
`$env:STAGE_DOWNLOAD_FROM = 'http://<server>'` first. With none, it changes nothing
and says so.

**Keeping it on the server's version.** The installer also puts
`kiosk-update-windows.ps1` in `%PROGRAMFILES%\StageUtility\kiosk-update.ps1` (only an
administrator can write there; it runs as SYSTEM) and registers the task
`StageUtilityKioskUpdate`, which runs it as SYSTEM every five minutes. Each run asks
the server (`GET /api/machine-updates/check`, the same check a Mac's updater makes)
whether its launcher, compared by SHA-256, is the server's. When the server says to
replace it, it downloads `kiosk-windows.ps1` to a temporary file in
`%PROGRAMFILES%\StageUtility`, checks its SHA-256 is the one the server named and
that it parses, and moves it over `kiosk.ps1`. Nothing restarts: the new launcher
runs at the next sign-in, or the next time the browser exits. The installer stages
its own downloads in the same folder, never in `%PROGRAMDATA%`, where any user can
create files. Any failure leaves `kiosk.ps1` as it was. The switch *Update Mac output
helpers and Windows kiosks with this server* (Settings > Advanced > Server) holds
it, and **Update now** overrides that. Service times do not, since a file replaced
restarts nothing.

How a failure is held depends on whether it would happen again:

| Failure | Reported as | Then |
|---|---|---|
| The download itself fails or times out | `retrying`, with the reason | Not downloaded again for 30 minutes, then 1, 2, 4 and at most 6 hours between tries while it keeps failing; the wait starts over on success or a new launcher. The PC still checks in every five minutes, so it stays listed |
| The SHA-256 does not match, the download does not parse, the server named no SHA-256, or `kiosk.ps1` is a link | `failed` | The server does not offer that launcher again until someone presses **Try again** in Screen settings > Device |

A launcher updated more than a day ago is reported as `idle` again, so Screens stops
saying it takes effect at the next sign-in.

The server it asks is the address in `update-from`, beside the updater in Program
Files. The installer writes it from the address it downloaded from, which is
`STAGE_SERVER` when that pins the PC, so a pinned PC asks its pinned server. The
updater does not read the `server` file in `%PROGRAMDATA%`: it runs as SYSTEM, and
that folder is writable by any user. What it last did is `status.json` beside the
updater, and its log, `kiosk-update.log` beside it, says each decision when it
changes, `[helper-update]`-tagged, as the server's `/log` does. A PC installed before
1.27.0 has no updater and a launcher written by the installer; run the installer once
more to get both.

**Removing it**, in an elevated PowerShell. The updater first, so it does not put the
launcher back:

```powershell
Unregister-ScheduledTask -TaskName StageUtilityKioskUpdate -Confirm:$false
Remove-Item -Recurse -Force "$env:ProgramFiles\StageUtility"
Unregister-ScheduledTask -TaskName StageUtilityKiosk -Confirm:$false
Remove-Item -Force "$env:ProgramData\StageUtility\kiosk.ps1", "$env:ProgramData\StageUtility\port"
```

That leaves the PC's `device-id` and `token` in `%PROGRAMDATA%\StageUtility`: with them
kept, installing again keeps the PC's binding, and removing them makes it a new device
whose screen is set up again.

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
  ignores it;
- **release** it, and the next answer from that server says it is no longer set
  up there. The device forgets that server, its probes stop naming it, and it
  shows on every server again, ready to set up on any of them.

A device learns all of this from the server's answer to its probe, which says
whether the device is set up on the server answering. It remembers a server only
once one says yes: a server that merely answered it, with a Screens page open, has
claimed nothing. When more than one server answers the same probe, the answer from
the server it remembers wins, then one from a server it is set up on.

A Mac output helper output keeps probing every 30 s, so it hears a release within
half a minute. A Pi, Linux, macOS or Windows kiosk probes only when it starts, and
hands over to the browser once a server answers. To move one: release it, open
Screens on the other server, and restart the screen. Told at that probe that it is
released, it forgets the old server and probes again straight away, and the server
with Screens open answers it. A helper output set up nowhere follows the first
server that answered, so two Screens pages open at once do not pass its holding
screen back and forth, until a server sets it up.

A Mac output helper, macOS or Windows kiosk installed before servers said whether
a device is set up there remembers any server that answers it. Re-run its
installer (or update the helper) before releasing it, or it stays out of other
servers' reach. An older Pi or Linux kiosk never sent a binding, so it is free as
it is. Likewise a server that old is remembered on any answer by the helper and
the macOS and Windows agents, never by the Linux agent, until it is updated or the
device's `bound-to` file (`boundTo` in the helper's `outputs.json`) is removed by
hand.

No coordination between servers, and nothing to get out of sync.

A device that cannot reach the server that owns it keeps trying and says so on
screen. It does not re-home itself — a display that changed servers during an
outage would be worse than a dark one — but other servers can show it as *bound
elsewhere* behind an explicit force-claim, so recovering from a decommissioned
server does not need SSH.

## Discovery

The device broadcasts a probe on **UDP 8789** and the server answers it unicast.
The port is adjustable, because AV gear is fond of odd ports: `kioskDiscoveryPort`
in the server's `settings.json` (default 8789), and `STAGE_KIOSK_PORT` for the
installer on the device.

![The Screens page with two screens found on the network, each offered Set up or Dismiss, and the count beside Screens in the sidebar](images/screens-overview.png)

- A device bound to **this** server is answered, unless the bindings cannot be
  read (below), so a display re-finds its
  server after an IP change with nobody present.
- An **unclaimed** device is always **listed**: the server records every one it
  hears, with no scan to open, so the banner, *Not set up yet* and the sidebar
  count are filled the moment anyone looks. A device not heard for 90 seconds
  drops out, and the list holds at most 256 unclaimed devices: the first heard are the ones kept, and the log says when it is full.
- An unclaimed device is **answered** only while a scan is open, which is for as
  long as a Screens page is open. A device loads its holding screen from the
  first server that answers it, so a server answering every new device at all
  times would race any other Stage Utility on the network for it. The answer is also what puts the holding
  screen, with its id, address and MAC, on the physical screen.
- While the server cannot read its record of which devices are bound to it,
  it answers **nothing** and lists nothing, rather than taking every device
  for unclaimed, and the device routes fail (`503`): a screen loading its page
  gets an error rather than the holding screen. To the screens it looks like the server being down. See [When a store file cannot be read](ops/reliability.md#when-a-store-file-cannot-be-read).

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
[Running the helper](#running-the-helper) and the [API](reference/api.md).

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

### Running the helper

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
stored state and exits), `--new-token <output key>` (below), `--dump-frames <dir>` (a PNG of every output and of the window
every 5 s, with no Screen Recording permission), `--discovery-port <n>`, `--log-stderr`,
and, for development, `--virtual-sdi <n>` (n SDI outputs with no card behind them,
offering every format, so the whole card path runs on any Mac), `--test-pattern
latency` (a clock on every output, to photograph two side by side), `--frame-timings
<file>` and `--head-start`/`--fill-lead <ms>`. The log is the unified log, subsystem
`com.stageutility.output`.

**Local Network permission.** One permission, for the app, covers the helper: it finds
the server, loads every output's page and posts health under it. It is asked for the
first time the helper reaches the network, and lives in System Settings > Privacy &
Security > Local Network. A server on the same Mac does not need it.

**When an output cannot load its page** it shows "Can't reach `<server host:port>`",
and keeps trying (after 2, 4, 8, 16, then every 30 s). It never shows Chromium's error
page, which printed the whole address, the output's secret token included. When the
failure looks like Local Network access being off (no route to a server on the local
network that has answered this output's probes since its loads began failing, or every
broadcast probe refused), a second line says
where to turn it on. The helper's log has one line per run of failures, with the error.

**Replacing an output's token.** If an output's token has been seen (an older helper
showed it on air in Chromium's error page), give that output a new one: quit the
helper from its window, run
`/Applications/StageUtilityOutput.app/Contents/MacOS/StageUtilityOutput --new-token <output key>`
(the key is the first column of `--list-outputs`), and start the helper again. The
server still holds the old token, so the output shows the holding screen and the server
logs `[output-helper] <device id> showed a token other than the one pinned`. **Release**
the screen in its Screen settings, which drops the old token, then set the output up
on that screen again when it appears under *Not set up yet*: the server pins the token
the output showed it since the release. Until the release, the old token still opens
the screen; if the output stays on the holding screen and the mismatch line comes
back, something else showed the old token first, so release and set it up again.

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
