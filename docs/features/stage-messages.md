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

## Messages

A message is a short piece of text addressed to one or more groups, or to
Everyone. It is 1–280 characters once trimmed, has a sender (a name, not an
account: it defaults to `Operator`, at most 60 characters), and may be an
**alert**.

It is sent with `POST /api/messages` and read back with `GET /api/messages`. The server stamps the id and the time; a
body cannot choose either. A message that breaks a rule is refused with a `400`
that says which, is logged as `[messages] refused: …`, and is neither saved nor
sent.

### Alerts

An alert holds the screens for **30 seconds**. The server stamps `alertUntil`
from its own clock, and screens count down against the server's clock, so a
screen with a wrong clock still ends it on time. `POST /api/messages/:id/clear-alert`
ends one early; the message stays in the thread with a `clearedAt` time.
Clearing an alert that is already over is not an error.

`alert` in the state is the newest message whose alert is still running. When it
runs out the server sends the state again with `alert` back to `null`, so a screen
that keeps no timer of its own still stops showing it. Two alerts to different
groups can run at once; each message carries its own `alertUntil` and
`clearedAt`.

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

One channel, `messages:state`, carries `{ rev, groups, messages, alert }`. It is
sent once when a client connects and again on every change. See
[Network traffic](../ops/network-traffic.md#stage-messages).

### Deleting a group

`PUT /api/messaging` replaces the groups, quick messages and quick replies. A
group whose id is gone comes off every screen that held it, in one write, and the
log says how many: `[messages] group "Green room" deleted; removed from 2
screen(s)`. Messages already sent to it keep its id.
