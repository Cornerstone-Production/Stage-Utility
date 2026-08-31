# The context bar

The strip above every operator page: the clock, which service is loaded, whether
one is running, and whether anything needs attention. It is the same on every
page, so `/patch` and `/history` know a service is live without carrying their
own copy of the state.

On a desktop it also carries the **page's name** at its left and the page's own
controls at its right, so a page has one band of chrome above it rather than two.
See [Every page says its name](operator-app.md#every-page-says-its-name). Neither
is an item and neither can be configured — the readings below are what you
arrange.

**Right-click the bar and choose "Configure bar"**, or use **Settings → Advanced
→ Context bar**. Both open the same thing. There are two arrangements, both
shared by everybody: the one above a desktop page, and the one a phone shows.

## What it can show

| Item | Shows |
|---|---|
| **Clock** | The current time, with seconds. |
| **Service type** | Which service this is — the same name most weeks. |
| **Service plan** | The title of the plan that is loaded. |
| **Live state and timer** | Whether a service is running, and the countdown. |
| **Current plan item** | What Planning Center says is happening now. |
| **Integration health** | How many set-up integrations are disconnected. |
| **Recording** | Whether OBS or REAPER is rolling. |
| **Streaming** | Whether Resi, YouTube or OBS is live, and for how long. |
| **Live scores** | A followed team's score while its game is being played. Click it for the full card. |

The service type and the plan are two items, so either can go on the bar without
the other. A bar saved when they were one item keeps both, side by side, exactly
as it drew them.

An unconfigured bar shows the service type, the plan, the current item, and the
live state and timer.

## Nothing appears or disappears

Every item you turn on is always on screen. An item with nothing to report says
so — `No plan`, `No item`, `All connected`, `Standby`, `Off air` — rather than
vanishing and
letting its neighbours slide across. The bar keeps one shape, so you learn where
to look once.

**Live scores is the exception, and the only one.** It draws nothing at all
unless a followed game is actually in play, and takes no room while it is empty.
The other eight always have something true to say, so their resting state is a
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

**Desktop and Phone** at the top of the dialog choose which of the two bars you
are arranging. The strip below shows the one you picked, at the width it will
have, and the line under it says what will happen on a 320px phone — the
narrowest screen the bar promises to fit.

Every change saves as you make it. There is nothing to apply.

## A phone can have its own set

A phone has room for four or five readings, not every item there is. So the bar has **two**
arrangements: the one above a desktop page, and the one a phone shows. They are
chosen independently, and both are shared — one desktop bar and one phone bar for
everybody, like the rest of this app's config.

**A phone follows the desktop bar until you give it a set of its own.** Nothing
changes on upgrade, and nothing changes the first time you open the Phone tab —
it shows what the phone is already showing. The first change you make there is
what splits the two apart; **Follow the desktop bar** puts them back together.

"A phone" means **narrower than 640px**, the same width at which the sidebar
becomes a drawer and the page's name moves from this strip to the top bar. It is one number for the whole app,
not a second one the bar invented.

Curating a phone's set is how you keep a reading whole rather than cut. The
service type, the plan title and the current item are the only readings on the
bar with no predictable length, and they are the only ones a narrow screen ever
has to shorten — so taking one off the phone's bar is usually all it takes. The dialog measures your
arrangement at 320px and tells you which way it lands before you leave it.

## When it runs out of room

The bar never wraps and never scrolls, at any width. Instead it gives things up,
in a fixed order, and the order is the design:

| | What goes |
|---|---|
| *(before any of these)* | On a desktop, the **page's name** gives up width first — down to about 14 characters and no further. Every built-in page name is shorter than that and so is never shortened at all; only a console you have given a long name ever ends in an ellipsis here. |
| **Full** | Nothing. Everything at its full length. |
| **Qualifiers** | The clock's seconds. The score capsule's inning or period. The label beside a pre-service countdown. |
| **Compact** | Every idle word becomes that item's own mark — `No item`, `Off air`, `Standby`, `All connected`. The word `LIVE` goes; its dot does not. Gaps and edge padding tighten. The score capsule tightens. |
| **The floor** | Names somebody wrote — the service type, the plan title, the current item — give way and end in an ellipsis. |

Four things it may never do:

- **Never remove a number.** `6 disconnected` keeps its 6, `3d 3h` keeps every
  character, a score is never shortened. A mark may replace a *word*, never a
  value. The clock's seconds are the one deliberate exception, and what they cost
  is precision, not a reading: `16:59` is still the time.
- **Never remove a state colour.** Live green, overrun red and the amber on a
  disconnected count survive every step.
- **Never drop an item.** Every reading on the strip is one somebody put there on
  purpose — and shortening an item to nothing is dropping it, so no step takes an
  item's only reading. (Live scores is still the one item that draws nothing when
  no followed game is on — see above.) The page's name is the shell's rather than
  one you placed, which is why it is the one thing on the row allowed to give way,
  and why it has a floor of its own so it can never be shortened to nothing.
- **Never wrap and never scroll.**

Every word taken is clipped out of the layout rather than deleted, so a screen
reader still reads the full reading at any width.

**The floor is not meant to be reached.** It exists because a strip that has run
out of room has to do *something*, and of the four things available — shorten the
prose, wrap, scroll, or silently clip — only shortening keeps one row, keeps
every number, and shows the reader that a word was cut. A bar carrying none of
the service type, the plan and the current item can never land there.

### Measured

On a plan called "Carry The Light" under a service type called "Weekend Service",
in both themes. `strip` is the room the bar actually has, which is narrower than
the window once the sidebar is open.

Five arrangements: the service type on its own, the plan on its own, the two of
them together, the bar an install upgrading into this change carries — the clock,
the service type, the plan, the current item and the timer — and every item at
once.

| Window | strip | Type alone | Plan alone | Both | The upgraded bar | Everything |
|---|---|---|---|---|---|---|
| 320px | 320 | Full | Full | Full | Floor — plan title 87 of 88px | Floor — service type 65 of 100px, plan title 57 of 88px |
| 390px | 390 | Full | Full | Full | Compact | Compact |
| 640px | 416 | Full | Full | Full | Compact | Compact |
| 1440px | 1216 | Full | Full | Full | Full | Full |

One row, no scrolling and no wrapping in all 40 of those, and every reading whole
in 36 of them. Only the narrowest phone made shortens anything, and only when the
strip is carrying five readings or more.

### Measured, with the page's name on the row

The same plan and service type, in both themes, with the sidebar at its default
224px. Three arrangements: two readings, the set an unconfigured bar shows, and
every item at once. Three page names: the shortest built-in one, the longest
built-in one, and a console named past the floor.

| Window | strip | Two readings | Unconfigured | Everything |
|---|---|---|---|---|
| 1024px | 800 | Full | Full | `Home` Qualifiers · `Integrations` Compact · long console name Compact |
| 1280px | 1056 | Full | Full | Full |
| 1440px | 1216 | Full | Full | Full |
| 1920px | 1696 | Full | Full | Full |

`scrollWidth` equalled `clientWidth` in every one of those, nothing was ever cut
short, and the page's name kept every character in all of them — including the
22-character console name, which has room to spare well below the floor it would
give way to. Light and dark measured identically, to the pixel.

Only a 1024px window carrying every item at once ever gives anything up, and what
it gives up is words the ladder was built to give up.

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

The bar is one row at every width. A Flexible space on a phone has very little
slack to eat, but it still decides which side of the strip a group sits on, and
a Space still separates at the same width it has anywhere else.

A bar arranged before spacers existed keeps the left/right split it already had.
