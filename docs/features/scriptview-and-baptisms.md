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

A 3px stripe in the literal PCO colour, plus a hue-matched wash behind the row:

```css
box-shadow: inset 3px 0 0 hsl(<hue> 72% 62%);   /* stripe — bright, still coloured */
background:              hsl(<hue> 42% 15%);    /* wash  — sits behind the text */
```

Neither can use the literal PCO colour. Those colours are pale
pastels authored for a white table, and mixing one into a near-black background keeps
its lightness while losing its hue: `#e8f6df` at 10% over `#0a0a0a` measures
**rgb(33, 34, 32)** on screen — neutral grey, so a song row just looked lighter rather
than green. Keeping the hue and substituting a saturation/lightness that works on a dark
panel is what makes it read as a colour.

The stripe has the same problem, less obviously: `#e0f7ff` is 88% lightness, so at full
strength on a dark panel it reads **white** — the hue is present but there is almost no
colour in it. It takes the same hue at a brighter, saturated value.

A near-grey PCO value (Header is `#eaebeb`) has no hue worth keeping; the wash falls back
to plain white and the stripe to a neutral rule.

PCO's palette is authored against a white table, so used directly as row backgrounds on a
dark panel two of the three read as near-white blocks. The stripe carries the hue where it
is legible at distance; the wash groups the row without lifting the background into the
text. PCO's palette includes lavender and pink — those render as chosen. The project's
zero-purple rule governs our own chrome, not a colour an operator picked in PCO.

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

## Previews render with kiosk colours

A kiosk preview embedded in the settings page (`.kiosk-surface`) sets the Tailwind
`--color-*` variables directly rather than the `--su-*` ones.

That looks redundant next to `.kiosk`, and is not. `--color-fg: var(--su-fg)` is declared
on `:root`, so it **resolves there** and inherits its computed value down — redefining
`--su-fg` on a nested element changes nothing. `.dark` and `.kiosk` get away with it only
because they sit on `<html>`, the same element as `:root`.

Without this, a preview inside the light theme drew near-black text on the kiosk's
near-black panel: measured at **1.14:1**, versus 19.80:1 after. Real displays already
carry `.kiosk` on `<html>` and are unaffected (measured 17.93:1 before and after).
