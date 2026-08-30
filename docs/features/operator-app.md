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

A page you open arrives at the top, whatever you were reading before it. Picking
the page you are already on does the same, and resets it to its top view. Back
and Forward are the exception: they return you to where you were on that page,
because that is what going back means.

Addresses for these pages, and the rules about display slugs that must not
collide with them, are in [Display URLs](../display-urls.md).

## Home

Home is a grid of widgets you build yourself, out of the same registry every
other surface draws from — anything you can put on a wall you can put here. See
[Widgets](../reference/widgets.md) for what each one shows.

**Editing.** The pencil in the page header turns on edit mode. Each tile then
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
`/consoles/<view id>`. That row is absent until a console exists. A console can
also drive a physical screen, but only one whose mode is set to **panel**; the
server refuses a console view on a screen left in display mode, so a wall cannot
end up rendering a live button by accident.

**Editing one.** A quiet **Edit** button appears near the console's top-right
corner when the pointer comes within reach. It opens the layout editor on the
same URL, and **Done** returns you to the live console. See
[Layout editor](../reference/layout-editor.md#editing-a-console-in-place).

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
