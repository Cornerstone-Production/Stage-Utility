# The context bar

The strip above every operator page: the clock, which service is loaded, whether
one is running, and whether anything needs attention. It is the same on every
page, so `/patch` and `/history` know a service is live without carrying their
own copy of the state.

**Right-click the bar and choose "Configure bar"**, or use **Settings → Advanced
→ Context bar**. Both open the same thing. The arrangement is shared — one bar,
and every operator sees it.

## What it can show

| Item | Shows |
|---|---|
| **Clock** | The current time, with seconds. |
| **Service type and plan** | Which service, and which plan is active. |
| **Live state and timer** | Whether a service is running, and the countdown. |
| **Current plan item** | What Planning Center says is happening now. |
| **Integration health** | How many set-up integrations are disconnected. |
| **Recording** | Whether OBS or REAPER is rolling. |
| **Streaming** | Whether Resi, YouTube or OBS is live, and for how long. |
| **Live scores** | A followed team's score while its game is being played. Click it for the full card. |

An unconfigured bar shows the service type and plan, the current item, and the
live state and timer.

## Nothing appears or disappears

Every item you turn on is always on screen. An item with nothing to report says
so — `No item`, `All connected`, `Standby`, `Off air` — rather than
vanishing and
letting its neighbours slide across. The bar keeps one shape, so you learn where
to look once.

**Live scores is the exception, and the only one.** It draws nothing at all
unless a followed game is actually in play, and takes no room while it is empty.
The other seven always have something true to say, so their resting state is a
reading; scores would spend most of the year showing a word that never changed.
See [Live scores](../integrations/scores.md).

Colour carries the state instead:

| | |
|---|---|
| **Grey** | Resting. Nothing is running, and nothing is wrong. |
| **Green** | A service is live, or a recorder is rolling. |
| **Red** | Act now: an item has run past its length, the service start time has passed with nothing begun, or a connected recorder has stopped. |

Red is deliberately scarce. An idle bar is grey, so red on this strip always
means something wants you.

**Integration health** counts only integrations you have set up and enabled — one
you never configured is absent, not disconnected. When something is down the
count becomes a button: it names them, and clicking one opens its card on the
Integrations page.

## The configurator

The dialog works the way the macOS toolbar editor does. Along the top is every
item, as a tile; below it is the bar itself, live, showing real readings.

- **Drag a tile into the bar** to add it, at the point you drop it. Clicking a
  tile appends it to the end, which is the same thing without a mouse.
- **Drag an item out of the bar** and let go anywhere else to remove it. The
  small × on an item does the same.
- **Drag an item along the bar** to move it. A line shows where it will land —
  drop on the left half of an item to go before it, the right half to go after.
  No line means letting go there places nothing: a bar item is removed, and a
  palette tile springs back.
- A tile already in the bar is dimmed. **Space** and **Flexible space** never
  dim, because you can use as many of either as you like.
- **Use the default set** puts the bar back to how it ships.

Every change saves as you make it. There is nothing to apply.

## 12-hour or 24-hour

**Settings → Advanced → Network & behavior → Clock format**, beside the time
zone. It sets how *every* clock in the app reads — the context bar, service
times in History and the Overview, the rundown, the automation log, and stage
displays.

A **clock object** in a custom layout that has been set to 12h or 24h explicitly
keeps its own choice; one that never was follows this setting.

It is a display preference only. Nothing the server decides by the clock changes
with it — which day a service files under, the update window and the automation
time conditions all read the **time zone**, because 8pm and 20:00 are the same
instant.

## Spacing

Two kinds, doing different jobs.

**Flexible space** draws nothing and takes all the room going, which pushes what
follows it away from what comes before. It decides **alignment**.

| Arrangement | Result |
|---|---|
| None, or one at the end | Everything packs to the left |
| One in the middle | A left group and a right group |
| One at the very start | Everything packs to the right |
| Two | The items between them are centred |

**Space** is a fixed 24px gap — a deliberate break between two groups that does
not push either to an edge. It decides **distance**. Put several side by side
for a wider one; the gap is the number of Spaces times 24px. (Items sit 12px
apart without one.)

Reach for a Space when you want a reading set slightly apart from its
neighbours; reach for a Flexible space when you want a group pinned to an edge
or centred.

On a phone the bar wraps onto as many lines as it needs. Flexible spaces are
ignored there — there is no slack to distribute, and one would push the next
item onto a line of its own — but a Space still separates, at the same width it
has anywhere else.

A bar arranged before spacers existed keeps the left/right split it already had.
