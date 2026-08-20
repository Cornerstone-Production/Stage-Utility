# The context bar

The strip above every operator page: the clock, which service is loaded, whether
one is running, and whether anything needs attention. It is the same on every
page, so `/patch` and `/history` know a service is live without carrying their
own copy of the state.

Configure it under **Settings → Advanced → Context bar**. The arrangement is
shared — one bar, and every operator sees it.

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

## Left and right

The bar has one left group and one right group. In the chooser, a dashed
**Right-aligned from here** row marks where the cut falls: everything above it
sits at the left of the bar, everything below it at the right.

Drag it like any other row.

- At the top, the whole bar is right-aligned.
- At the bottom, the whole bar is left-aligned.
- Anywhere else, it splits there.

There is one cut, so the order is left group, then right group — you cannot
interleave the two sides.

A bar arranged before this row existed keeps the split it already had.
