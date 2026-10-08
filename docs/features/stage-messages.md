# Stage messages

A producer sends a short message to one or more **groups** of screens, or to
**Everyone**. Messages are for the people on stage and in the booth: "walk now",
"you're on after this song", "2 minutes".

## Groups

A group is a named set of screens: Green room, Stage, Booth. A screen can be in
any number of them, and a message can go to several at once. **Everyone** is built
in and reaches every screen, whether it is in a group or not; it cannot be renamed
or deleted, and no group can be named Everyone.

Up to 20 groups, each name 1–40 characters, unique without regard to case.

### Settings → Messages

**Settings → Messages** holds the groups and the two lists of one-press text:

- **Groups.** Add one, rename it (click the name, type, press Enter), or remove
  it. Removing asks first and says how many screens are in it ("Remove Green
  room? 2 screens are in it…"); those screens are taken out of it, and messages
  already sent to it stay in today's thread.
- **Quick messages.** Up to 24, 1–280 characters each: the messages a console can
  send in one press. Six come stocked: *Walk now*, *You're on after this song*,
  *2 minutes*, *Wrap it up*, *Band back on stage*, *Running 5 min late*.
- **Quick replies.** Up to 12, 1–60 characters each: the answers a console can
  send in one press. Three come stocked: *Copy*, *Walking now*, *Need 2 min*.

Both lists are edited the same way: add at the bottom, click a row to edit it,
and move a row with the arrows to change the order consoles offer it in. Every
change is saved at once. A change the server refuses — a duplicate group name, a
list past its limit — says why and leaves what you typed where it is.

If the page is open in two windows, the one that saves second is told the
config changed since the page loaded, reloads what is stored, and saves nothing:
the whole config is replaced at once, so a save built from the old one would
delete the group the other window added. The same message appears when this
page's own earlier save went through after its answer was lost (a timeout).
Make the change again.

These are the operator's own work, so they are carried by every backup.

### Putting a screen in groups

On the **Screens** page, open a screen's menu (the vertical dots) and choose **Groups**. Each
group is a checkbox, and the menu stays open so several can be set in one visit.
The groups a screen is in show as small chips under its name. With no groups made
yet the submenu says so and links to Settings → Messages.

A screen's groups are stored with the screen (`Output.groups`), so they follow it
across a restart and are carried in backups with the rest of the screen's
settings. See [Data model](../reference/data-model.md#stage-messages).

## Messages

A message is a short piece of text addressed to one or more groups, or to
Everyone. It is 1–280 characters once trimmed, has a sender (a name, not an
account: it defaults to `Operator`, at most 60 characters), and may be an
**alert**.

It is sent with `POST /api/messages` and read back with `GET /api/messages`. The
server stamps the id and the time; a body cannot choose either. A message that
breaks a rule is refused with a `400` that says which, is logged as
`[messages] refused: …`, and is neither saved nor sent.

### Alerts

An alert holds the screens for **30 seconds**. The server stamps `alertUntil`
from its own clock, and screens count down against the server's clock, so a
screen with a wrong clock still ends it on time. `POST /api/messages/:id/clear-alert`
ends one early; the message stays in the thread with a `clearedAt` time.
Clearing an alert that is already over is not an error.

`alerts` in the state lists every message whose alert is still running, newest
first. Two alerts to different groups can run at once, and a screen draws the ones
sent to its own groups. Each alert's end goes out as its own frame: when it runs
out, or is cleared, the server sends the state again without it, so a screen that
keeps no timer of its own still stops showing it. Each message carries its own
`alertUntil` and `clearedAt`.

### The day's thread

The day's messages are kept in `messages.json`, so a restart in the middle of a
service keeps them.

- **Cleared nightly.** The date in the [app time zone](../ops/install-and-config.md#time-zone)
  is compared with the day the thread was last cleared, once a minute and once at
  boot, so a server that was off at midnight clears the stale day when it comes
  up. The host's own date is never used: a server running UTC would otherwise clear
  the thread at 19:00 in Chicago. A message sent after midnight but before the
  next check belongs to the new day and is kept.
- **Capped at 200.** Past that the oldest is dropped, and the log says so once a
  day.
- **Not restored from a backup.** A message is an observation about one day; the
  groups, quick messages and quick replies are the operator's work and are carried
  by every backup.

### How screens receive them

One channel, `messages:state`, carries `{ rev, groups, quickMessages, quickReplies,
messages, alerts }`. It is
sent once when a client connects and again on every change. See
[Network traffic](../ops/network-traffic.md#stage-messages).

### Deleting a group

`PUT /api/messaging` replaces the groups, quick messages and quick replies. A
group whose id is gone comes off every screen that held it, in one write, and the
log says how many: `[messages] group "Green room" deleted; removed from 2
screen(s)`. Messages already sent to it keep its id.

What comes off the screens is whatever they hold that the config does not, worked
out afresh on every save and once at start-up, not just the groups that save
removed. If taking a group off the screens fails (a full disk), the config is
already saved: the answer is a `500` that says the groups were saved but the
screens were not cleared, and saving again retries it. The `500` carries no
version, and the save has already moved it on, so the retry has to be built from
a fresh `GET /api/messaging` (a `PUT` with the old version is a `409`); Settings →
Messages does that by reloading when it shows the message. A group id a screen
holds that the config does not have, whether from that failure or a hand-edited
`settings.json`, is taken off at the next save or start, and the log names it:
`[messages] group g-0a1b2c3d is not in the config; taken off 2 screens`.

**At start-up this only happens when `messaging.json` was read whole.** A file
that is missing, truncated, not an object, short of a `groups` list, or that lost
entries reads as an empty config, and taking every group off every screen against
it would delete memberships that restoring the file afterwards does not bring
back. Then start-up leaves the screens alone and says so on the log
(`[messages] taking unknown groups off the screens was skipped at start-up: …`),
only when a screen actually holds a group. Fix or restore the file and restart, or
save the groups in Settings → Messages, which is the operator's own decision and
always runs it.
