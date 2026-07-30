# ScriptView and Baptisms

Two operator-facing surfaces built on the PCO plan.

## ScriptView

A per-service-type PCO **rundown dashboard** at `/scriptview` — an in-app replacement
for ScriptViewer. The landing page lists the service types you enable; each opens a
**deep-linkable** rundown at a readable URL (`/scriptview/weekend/audio`) you can pin in
its own browser tab. **Layouts are global** column presets (Audio / Video / Lighting / …)
shared across every service type, each with per-element toggles (**clock, time, song
key / BPM / arrangement, item notes, total time**) and **department row coloring**. The
projected clock follows the **plan's timezone**; the current item highlights live only
while a service is actually running. Configured in **Settings → ScriptView** with a live
preview.

## Baptisms

A standalone **`/baptism` operator page** (also a Settings tab) with a **grouped
workflow** (all testimonies, then all baptisms). Sessions are named by service and
**cross-linked into Service History** with per-person splits + averages. An on-air
**"Baptism timer"** layout object shows the live count/timer on a display.

## Row colours

Three sources, first match wins.

**1. PCO item row colours.** `ServiceType.standard_item_types` and `custom_item_types`
carry `{name, color}` and ride along on the `listServiceTypes` request the app already
makes, so they cost nothing extra. Standard entries match an item's `itemType`
(header / song / media). Custom entries match text **contained in the title** — PCO's own
wording is "Items that include this text in the title will be highlighted."

`#ffffff` means *unset*, not white: PCO ships it as the default on Media, so rendering it
would stripe every video row for no reason. Only exact white is special — a near-white is
treated as a real choice.

Because the app renders whatever the arrays contain, **a colour added in PCO needs no
change here**. It appears within the 15-minute service-type cache, or immediately on a
manual refresh, including brand-new custom types.

**2. Category accent.** When a layout selects a note category as its row accent and an
item has a note in it. Colour comes from the app-wide map below.

**3. Nothing.** A plain row.

A live item outranks all three — a running item stays the most prominent row.

### How they render

A 3px full-strength stripe plus a 10% wash:

```css
box-shadow: inset 3px 0 0 var(--colour);
background: color-mix(in srgb, var(--colour) 10%, transparent);
```

PCO's palette is authored against a white table, so used directly as row backgrounds on a
dark panel two of the three read as near-white blocks. The stripe carries the hue where it
is legible at distance; the wash groups the row without lifting the background into the
text. PCO's palette includes lavender and pink — those render as chosen. The project's
zero-purple rule governs our own chrome, not a colour an operator picked in PCO.

## Column header colours

Each note column's header takes its own colour so a layout's columns are told apart at
a glance — the Audio layout's Band and Vocals, or a fourteen-column layout's whole set.
Structural columns (Clock, Time, Item) keep the default.

**Nothing to configure.** PCO has no colour for a note category — `item_note_categories`
carries only `name` / `sequence` / `frequently_used` — so any configurable colour would
be invented here rather than read from the plan.

Colours are spread **evenly across the columns a layout shows**, not hashed from the
category name. Hashing was tried first and cannot guarantee the one thing that matters:
with fourteen columns in a ~260-degree hue space, collisions are a birthday problem, and
two columns sharing a colour inside one layout defeats the point. Even spacing
guarantees maximum separation in every layout, at the cost of a category not keeping the
same colour across layouts that show different column sets.

Hues 230-330 are skipped for the zero-purple rule. The gap is generous at both ends
deliberately: 249 reads indigo and 320 reads violet, so a narrow "purple only" gap still
produced purple headers.

**Rows are never coloured by category.** Row colour has one source — PCO's item row
colours above — so a plan reads the way PCO shows it. There is no row accent setting.

## Responsive layout

ScriptView is a kiosk `ViewKind`, so it renders on stage panels as well as laptops and
phones. There is **no page max-width**: a centred column leaves dead margins on a 37-inch
panel and shrinks the text relative to the viewport, which is backwards for a surface read
at distance. The shape changes instead:

| Container width | Shape |
|---|---|
| `< 640` | Stacked. Each item is a block; every column keeps its header as a label. |
| `640-1024` | Table without the Clock column (a projected time, the least load-bearing). |
| `> 1024` | Every column, filling the width. |

Measured with a `ResizeObserver` on the table's own wrapper, **not** the viewport — the
table also renders inside the settings live preview, a narrow container on a wide screen,
which a viewport media query would get exactly backwards.

## Files

- `renderer/main/item-colour.ts` — `resolveItemColour()`, PCO matching
- `renderer/main/category-colour.ts` — `categoryColour()`, normalisation + fallback
- `renderer/main/rundown-table.tsx` — precedence, stripe + wash, the three shapes
- `main/services/pco-service.ts` — `toItemColors()`, colours off `listServiceTypes`
- `main/services/stage-controller.ts` — `setCategoryColor()`
