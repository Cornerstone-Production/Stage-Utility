# Signage

Graphics and video on a schedule, on groups of screens.

A signage screen is an ordinary screen. It is set up in [Screens](../kiosk-devices.md)
like any other, then routed to a **Signage** view; what it plays is worked out on
the server and pushed to it. Nothing about a signage screen is special to the
device, so swapping a dead Pi loses nothing.

## The parts

| | |
|---|---|
| **Media** | the library of graphics and video |
| **Playlists** | ordered sets of media, each item with a duration and a transition |
| **Groups** | named sets of screens — a foyer, a hallway |
| **Schedules** | a playlist on a group, between certain times |

A single graphic is a playlist with one item in it. There is no separate concept.

## Media

Drop files onto the Media section, or press Upload. PNG, JPG, WebP, GIF, MP4 and
WebM. Graphics up to 12 MB, video up to 200 MB.

SVG is not accepted. An SVG can carry script, and these files are served from
URLs anyone on the network can request.

Uploading the same file twice does not make a second copy — the library says it
already has it, under whatever name it was first given.

Deleting a file removes it from the playlists that used it, and says which.

## Playlists

Each item is on screen for a number of seconds. A **video ignores that** and
plays for its own length; cutting a clip off after eight seconds because that is
the playlist default is never what anyone means.

**Fit** decides what happens when a graphic is not the shape of the screen:
*contain* shows all of it with black bars, *cover* fills the screen and crops.

**Transitions** are cut, crossfade, fade through black, slide and wipe, from 0 to
3000 ms. A transition happens inside the incoming item's own time, so changing it
does not change how long a lap of the playlist takes.

Every screen in a group is at the same point in the playlist at the same moment,
including mid-transition. Nothing coordinates them; they each work it out from
the clock.

## Groups

A screen can be in any number of groups. Which schedule wins when two of them
disagree is settled by the schedule list, not by the groups — see below.

A group can name a **default playlist**. It plays when no schedule matches,
instead of the screen going black, and it is also what a screen plays when it
starts up with no server (see *Offline*).

## Schedules

**Order is priority.** When two schedules both match a screen at the same moment,
the one nearer the top of the list wins. Move a schedule up to give it priority.
The row currently winning is marked.

Five kinds of window:

| | |
|---|---|
| **Always** | no time limit |
| **Weekly** | chosen days, between two times |
| **Date range** | between two dates, optionally on chosen days |
| **One-off** | a single date |
| **Planning Center** | derived from that service type's plan times |

A weekly window whose end is before its start runs into the next day: `22:00` to
`02:00` on Thursday ends on Friday morning. The schedule row says so.

Times are read in the app's time zone, so a window keeps its local hours across a
daylight-saving change.

### Planning Center windows

Pick a service type and a padding — say 60 minutes before and 30 after. The
window runs from the first service time that day minus the lead, to the last plus
the trail. Rehearsal times are ignored.

**Stay on while the service is live** holds the window open past its end for as
long as Planning Center reports that service type live, so a service running long
does not blank the screens mid-service.

If Planning Center cannot be reached, the last plan times this server fetched
keep being used, and Signage says so. They keep working; they may be out of date.

## Taking over

**Take over** puts a playlist on a group immediately, beating every schedule until
released. **Blank** does the same with nothing. A banner names every active
take-over, so a forgotten one is visible rather than mysterious.

A take-over survives a server restart. It is deliberately not carried in a
config backup — restoring a two-week-old backup should not put a forgotten
announcement back on a wall.

## When the server goes away

A screen holds a whole day's plan, not just what to show now, so it keeps working
without the server.

**At a boundary, a screen advances only if it is connected.** Disconnected, it
keeps playing what it is playing and does not go black. It is not a grace period:
a brief drop that heals before the next boundary changes nothing at all. When the
server comes back the screen jumps straight to whatever is correct then.

A screen that was already blank when the server went away stays blank.

## Offline

A screen that **starts up** with no server has nothing to hold, so it plays its
group's **default playlist** and never consults a schedule. That is deliberate: a
Raspberry Pi has no battery-backed clock, so after a cold boot with no network it
cannot trust what time it thinks it is — and a screen that picks a window
confidently and wrongly is worse than one that plays what it was given.

To take a screen offsite, put it in a group, give that group a default playlist,
and use **Prepare for offline**.

**Prepare for offline works on the browser it is opened in.** On a Raspberry Pi
that means opening the Signage tab on the Pi itself, not from a laptop.

### Coming back after a power cut

A screen that reboots with no server on the network comes up playing, without
waiting for one. Three things make that work, and all three need a run against
a live server first:

- the app itself is held on the device, so the page loads with nothing to load it
  from;
- the graphics are held on the device (that is what **Prepare for offline**
  does);
- the screen remembers that it is a signage screen, so it starts playing rather
  than waiting for the server to tell it what it is.

A kiosk device opens the same URL forever (`/enroll?device=…`) and is redirected
from there to its display, so with no server there is no redirect. It plays
anyway. When the server answers again, the screen reloads and the server decides
where it belongs — which may have changed while it was dark.

Every other kind of display still shows "could not load" with no server, which is
the truth: there is nothing for it to draw.

## Backups

Playlists, groups, schedules and the media library are all carried in a config
backup. Media **files** are carried up to 12 MB each, which is every graphic and
no video. Anything skipped is named in the backup, so a restore can say what did
not come back.

## Limits worth knowing

- A screen's day-long plan is a snapshot. If a Planning Center time moves while a
  screen is disconnected, it cannot know.
- Offline, a screen plays its group's default and ignores schedules entirely.
  Time-based schedules need a server.
