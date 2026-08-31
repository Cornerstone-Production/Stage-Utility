# The operator app

Everything an operator does lives at one address — the same one the screens are
on. Open the server's URL and you get Home, with a sidebar down the left and the
[live service strip](context-bar.md) across the top of every page.

There is no separate settings window and no separate tool pages. Moving between
pages does not reload the browser, so the event stream and the cached plan
survive a navigation.

## Getting started

A fresh install puts a four-step checklist at the top of Home:

| | |
|---|---|
| **Connect Planning Center** | app credentials, so plans, items and the countdown flow in |
| **Select a service & plan** | which service this machine follows |
| **Create a view** | content to show |
| **Route a display** | point a screen at it |

Each row opens the page that finishes it, and ticks itself when the work is
done. Dismiss it and it stays dismissed.

## The sidebar

| Group | Pages |
|---|---|
| — | **Home** |
| Content | **ScriptView**, **Patch** |
| Screens | **Screens** |
| Devices | **Automation** |
| Services | **Plan**, **History**, **Baptisms** |
| Settings | **Integrations**, **Branding**, **Advanced** |

Consoles you have built get a row each, above the groups — see
[Consoles](#consoles). The running version sits at the foot of the sidebar. Drag
its right edge to resize it, or collapse it to icons; on a phone it becomes a
drawer.

**On a phone the hamburger is the only way in.** There is no swipe from the left
edge of the screen — that edge belongs to the browser's own back gesture, and a
page that takes it works on one platform, does nothing on another, and costs you
the most reliable way out of a page. The hamburger works everywhere, in a tab and
in an app added to the home screen alike.

**Drag the open drawer off to the left to close it.** It follows your finger the
whole way, and the page behind it lightens as it goes, so you can see how far you
are before you let go. A quick flick closes it however short; a slow drag lets go
past halfway to close and springs back before that. Catching one that is already
on its way out picks it up where it is rather than snapping it back. Dragging up
or down scrolls the drawer as normal, and tapping a page in it just opens that
page. With reduced motion turned on the drag still follows your finger — it is
the settle at the end that stops animating.

A page you open arrives at the top, whatever you were reading before it. Picking
the page you are already on does the same, and resets it to its top view. Back
and Forward are the exception: they return you to where you were on that page,
because that is what going back means.

Addresses for these pages, and the rules about display slugs that must not
collide with them, are in [Display URLs](../display-urls.md).

## Every page says its name

The page's name sits in the top bar on a phone, and at the left of the
[context bar](context-bar.md) on a desktop. Either way it shares a band with
something else rather than taking one of its own, so one strip of chrome sits
above the page instead of two. A console is named after the view it shows, so the
name you gave it in Screens is the name on the page and in the sidebar.

The page's own controls — Home's **Edit widgets**, for one — sit at the right of
the same band.

**The one-line description of what a page is for is a tooltip now.** A single
44px band has no second line to print it on, so hovering the page's name shows
it. Every page still has one.

Pages you reach from inside another page — the layout editor, a ScriptView
rundown, the patch editor — draw their own heading instead, so the bar shows no
name for them; on a phone the top bar names the section they belong to.

## Home

Home is a grid of widgets you build yourself, out of the same registry every
other surface draws from — anything you can put on a wall you can put here. See
[Widgets](../reference/widgets.md) for what each one shows.

**Editing.** The pencil at the right of the context bar turns on edit mode. Each tile then
gains a size picker, a visibility select, a remove button and a drag handle, and
**Add widget** offers the whole registry. The tick finishes.

**Right-click a tile** for its size, when it shows, remove, and the few settings
that widget supports — seconds and the hour cycle on a clock, hide-when-idle and
fill-when-recording on a status widget. No edit mode needed, and ticking one
leaves the menu open so several can be changed at once.

### Sizes

Five shapes on a three-column grid:

| Size | Columns × rows |
|---|---|
| Small | 1 × 1 |
| Medium | 2 × 1 |
| Large | 2 × 2 |
| Extra large | 3 × 2 |
| Tall | 3 × 4 |

They tile: `Small + Medium`, `Small + Large` and three Smalls each fill a row
exactly, and a Large leaves a gap two stacked Smalls complete.

### When a tile shows

| | |
|---|---|
| **Always** | every day |
| **During a service** | only while a plan is running |
| **Rest of the week** | only while one is not |

### Placement and gaps

A widget with no cell of its own flows into the first gap that fits. Drag one
and it takes a cell — and so does everything else on the page at that moment, so
the move stays local instead of rearranging the page behind it. Nothing re-packs
afterwards, which is what lets you leave a deliberate gap between two widgets.
Dropping onto an occupied cell pushes what was there downward rather than
covering it.

**Pack tight**, beside the pencil while editing, throws every placement away and
lets the page flow again. It appears only once something has actually been
placed.

Cells apply to the full-width page. Below about 520 px the grid narrows to two
columns and then one, and placements are ignored — a column chosen on a
three-wide page is not a column on a phone.

A widget you remove stays removed, across restarts and across updates. A build
that adds a widget gives it to installs that have never edited Home, and leaves
an edited Home alone.

## Consoles

A **console** is a custom view built for someone to touch rather than to watch.
Its buttons fire; the same layout on a wall display draws them and does nothing.

**Building one.** Screens → **New view** → *Custom Layout*, then pick **A
control surface you operate** rather than *A wall screen anyone can see*. Only
custom views can be consoles — the built-in kinds have no layout to put a
control on.

**Reaching one.** Every console gets its own row in the sidebar, at
`/consoles/<view id>`, and the console's own name heads the page. Renaming the
view in Screens renames both. That row is absent until a console exists. A console can
also drive a physical screen, but only one whose mode is set to **panel**; the
server refuses a console view on a screen left in display mode, so a wall cannot
end up rendering a live button by accident.

**Editing one.** A quiet **Edit** button appears near the console's top-right
corner when the pointer comes within reach. It opens the layout editor on the
same URL, and **Done** returns you to the live console. See
[Layout editor](../reference/layout-editor.md#editing-a-console-in-place).

### Running a console without the app's chrome

A console can have the app get out of its way. In Screens, open the console and
press the **bar** button beside *A control surface you operate*. Both bands go —
the top bar and the [context bar](context-bar.md) — and the console gets the
whole window.

On a 390x844 phone that is **89px back out of 844**: the console runs from the
very top of the page to the bottom instead of starting 89px down. On a desktop
it is the context bar, and with it the page's name; the sidebar stays, because
the sidebar is not a band and is the way back. The setting is honoured at every
width, deliberately — a setting that does nothing on the device you set it on is
worse than one that is occasionally unnecessary.

**A menu button floats over the console, and it never fades.** Bottom-left, above
the phone's home indicator, 44px square. It is the way back, and it is the only
one that works in every place this app gets opened: a browser's Back and its
toolbar are gone in an app added to the home screen, and Back needs history that
a console opened from a bookmark does not have. So it does not dim, and it does
not hide until you tap the screen — on a live console that first tap belongs to
whatever is underneath it.

**It sits on top of the console, and it takes the tap.** A console is buttons, so
a fixed position covers something on some layout and the app cannot know which.
It is exactly its own 44px and no more — there is no reserved strip along the
bottom, because a strip would give back half of what hiding the bars won — and it
carries its own background so it stays readable over a dark canvas. If it lands
on a control you use, move that control in the layout editor, or turn the bars
back on.

**Want some context back rather than all of it?** Do not use this — give the
phone its own [context bar](context-bar.md#a-phone-can-have-its-own-set) item
set and trim it to the two readings you actually want. That keeps the bar and
loses the clutter.

This is a different setting from a screen's **Hide top bar**, which is set per
screen and hides the *display's* bar on a wall, in a different page entirely.

## Read-only links to hand out

Two pages are meant to be sent to people outside Production, and are read-only
for that reason:

| | |
|---|---|
| `/history` | service history, timing and attendance, without the controls that change it |
| `/patch` | this week's stage patch, following the live or next plan on its own |

The operator's own versions are in the sidebar: **History** (which is
`/history/manage`, and keeps Edit times, Merge and Delete) and **Patch**, whose
editor is at `/patch/edit`.
