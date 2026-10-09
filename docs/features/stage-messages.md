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

On the **Screens** page, open a screen's menu (the vertical dots), choose **Screen
settings…** and tick the screen's groups under **Messages**. Each group is a
checkbox, so several can be set in one visit. The groups a screen is in show as
small chips under its name on its card. With no groups made yet the section says
so and links to Settings → Messages.

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

One channel, `messages:state`, carries `{ rev, serverNow, groups, quickMessages,
quickReplies, messages, alerts }`. It is
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

## On screens

### Alerts on screens

Every kiosk screen (a display, or a panel running a console) draws a running alert
over whatever it is showing, whatever the layout or the kind of view, with no
widget needed. A console open in the operator app is not a kiosk screen and draws
no banner; its Messages and Message composer widgets show the messages and the
alert in the thread.

The banner is the word **Alert** and the message large and white on a deep red
banner across the bottom (3% in from each side, 4% up), with a bar along its foot
that runs down to nothing as the 30 seconds do. It rises into place when it
arrives.

- Which alert: the newest running one sent to Everyone or to a group the screen is
  in. When it ends, the next one sent to this screen, if any, shows. A screen in no
  group still gets Everyone's.
- How long: counted against the **server's** clock from the server-stamped
  `alertUntil`, so a wall whose own clock is wrong still ends it on time. Every
  messages frame and read carries `serverNow`, and a screen sets its clock from them
  (the first read measures its own round trip, so one is enough), so this holds on a
  slots view or an unrouted screen as on a layout. The
  banner goes at that moment without waiting for the server's frame that says the
  alert ran out. A screen with no alert keeps no timer.
- Never over **blackout**: a blacked-out screen stays black, because blackout is a
  deliberate choice for that screen. Never on a **preview**, such as a Screens card,
  which is a picture of a screen and not one.
- A **screen-embed tile** (a picture of another screen on a producer wall) does not
  draw that screen's alert banner; a Messages widget inside it follows the screen it
  shows, not the one it sits on, and never draws reply buttons: a tile is a monitor
  of that screen, and only the screen itself answers. A composer in a tile signs as
  the view that holds it, not as the screen it monitors.
- A screen subscribes to `messages:state` for this whatever view it shows, once it has
  loaded (a screen still loading, showing an error, or blacked out draws no banner). If the banner
  itself fails to draw, it is hidden and `[messages] the alert banner failed to
  draw` is on `/log`; the screen underneath stays up, and the next update from the server gets a fresh
  try. A frame that is not the shape it should be is handled the same way.

### The Message composer widget

The **Message composer** [widget](../reference/widgets.md#control) is where a
message is sent from. It goes on Home, a console or a panel like any other widget,
so a producer's phone, the booth's panel and Home can each be a composer. It draws
**To** chips, the quick messages, a text box, the **Alert** switch and **Send**, a
line saying how many screens the message reaches, and **Today**, the day's thread
with every reply under its message.

- **To**: Everyone, and each group. Everyone stands alone; several groups can be
  picked; the choice stays after a send.
- **Alert** turns **Send** into a red **Send alert**; the message then takes the
  screens in those groups over for 30 seconds ([Alerts](#alerts)). **Clear alert**
  on a message in the thread ends one early.
- The message is signed with the **screen's name** on a screen, the **console's
  name** on a console in the app, and **Home** on Home.
- A send that fails keeps what was typed, the groups and the alert switch, and says
  why; the failure is also on `/log` as `[messages]`.

### The Messages widget

The **Messages** [widget](../reference/widgets.md#control) draws the newest three
messages sent to Everyone or to a group it follows: the newest large, the older two
smaller and muted, each with its sender and how long ago above it and the latest
reply in green below. Ages are counted against the server's clock.

Which groups it follows is its **Groups** setting in the layout editor's inspector:

- **Follow screen** (the default) takes the groups of the screen that draws it,
  set on the Screens page. One layout shown on screens in different rooms follows
  each of them.
- **Own groups** is the widget's own list, and overrides the screen's. It is also
  the only way for a widget on a console in the operator app to follow any, because
  a console is not a screen. With none chosen it says **Choose groups for this
  widget** on the console, and **Follows the screen it is on** in the layout editor.

A Screens-card preview is a picture of a screen, not a screen, so a Messages widget
that follows its screen follows no group in one and draws only its heading; one with
groups of its own shows them.

### Replies, and who may answer

Where controls are live, the widget also lets a console answer. Under the newest
message it shows is the line **Answering: <text>** and the quick replies as
buttons; with nothing to answer it says **Nothing to answer. This console can reply
only to messages sent to Stage, Booth or Everyone.** (naming the groups it
follows, then Everyone). Controls are live on a screen in **panel** mode and on a console in the
operator app, never on a wall display, which draws no buttons.

A reply is sent with `POST /api/messages/:id/replies`, and the server checks it
against the stored layouts and screens:

- the widget the reply is pressed on is found by its id in every view's layout, and
  must be a Messages widget;
- a reply that names a screen must name one in **panel** mode that actually draws
  that widget, in the view it is routed to or one that view embeds. A display never
  replies, and a screen that does not draw the widget cannot answer for it;
- a reply that names no screen (a console in the app) must come from a widget with
  groups of its own, because a widget that follows its screen has no screen to
  follow;
- the widget's groups are its own list when it has one, else the screen's, and the
  message must have gone to Everyone or to one of them, otherwise the answer is
  `403` and nothing is recorded.

A tile of a screen on a producer wall shows that screen's messages but never
answers for it: only the screen itself replies. A Message composer in such a tile
signs as the view that holds it, not as the screen it monitors.

This keeps honest clients honest. It is not authentication: the app has no logins,
so anyone who knows a real panel and a Messages widget that panel draws can still
send a reply that is signed as that panel.

The reply is signed with the screen's name, or the name of the view holding the
widget when it is not on a screen, and appears under the message in the composer's
thread and in green under it on every Messages widget showing it. A message cleared
at midnight cannot be answered, and a message keeps at most 20 replies: the 21st is
refused with `409` and the reason, so nothing a console sent silently disappears. Each reply, and each refusal with its reason, is
logged as `[messages]`; a console that could not send one says so and logs it from
the browser.

## From automation and Companion

A rule, or an **Action button** on any console, can send a message and clear the
running alerts: the automation actions **Send a stage message** and **Clear stage
message alerts**, sent from `Automation`. See
[Automation](../automation.md#actions).

The [Companion](../integrations/companion.md#what-the-module-exposes) module sends
messages from a button, shows an alert on one, and puts the newest message and
reply into variables. It sends from `Companion`, through the same
`POST /api/messages` a console uses.
