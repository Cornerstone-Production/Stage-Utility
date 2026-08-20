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
| **Clock** | The current time, 24-hour. |
| **Service type and plan** | Which service, and which plan is active. |
| **Live state and timer** | Whether a service is running, and the countdown. |
| **Current plan item** | What Planning Center says is happening now. |
| **Integration health** | How many set-up integrations are disconnected. |
| **Recording** | Whether OBS or REAPER is rolling. |

An unconfigured bar shows the service type and plan, the current item, and the
live state and timer.

## Nothing appears or disappears

Every item you turn on is always on screen. An item with nothing to report says
so — `No item`, `All connected`, `No recorder` — rather than vanishing and
letting its neighbours slide across. The bar keeps one shape, so you learn where
to look once.

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
- **Drag an item along the bar** to move it.
- A tile already in the bar is dimmed. **Flexible space** never dims, because
  you can use more than one.
- **Use the default set** puts the bar back to how it ships.

Every change saves as you make it. There is nothing to apply.

## Spacing

**Flexible space** draws nothing and takes all the room going, which pushes what
follows it away from what comes before. It is how you decide where things sit.

| Arrangement | Result |
|---|---|
| No spacer, or one at the end | Everything packs to the left |
| A spacer in the middle | A left group and a right group |
| A spacer at the very start | Everything packs to the right |
| Two spacers | The items between them are centred |

On a phone the bar wraps onto as many lines as it needs and spacers are ignored
— there is no slack to distribute, and a spacer would push the next item onto a
line of its own.

A bar arranged before spacers existed keeps the left/right split it already had.
