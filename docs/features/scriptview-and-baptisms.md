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

Each layout picks **one** source for its row colour. Never two: PCO's colour answers
*what kind of item is this*, the category answers *does my department have something to
do here*, and stacking both puts more on a line than a stage display can carry.

Settings → ScriptView → a layout → **Row colour**:

| Setting | Rows are tinted by |
|---|---|
| **From PCO** (default) | PCO's item row colours — song, header, media, custom title matches |
| **By category** | the chosen note category, wherever that category has a note on the item |
| **None** | nothing |

A layout saved before this existed has no `rowColour` and behaves as **From PCO**.
A live item outranks all three — a running item stays the most prominent row.

### From PCO — remapped, not literal

PCO's swatches are pale pastels authored for a white table; used literally on a dark
panel they read as near-white (`#e0f7ff` is 88% lightness). Each hue **band** maps to a
colour chosen for a dark surface:

| PCO swatch | Hue band | Renders as |
|---|---|---|
| green | 75-160 | `#46a758` |
| blue | 160-250 | `#4a86c8` |
| lavender | 250-290 | `#58c1e4` |
| pink | 290-345 | `#e0729a` |
| orange / red | 345-75 (wraps) | `#ffb224` |
| white, grey | no hue | no colour |

Keyed by band rather than exact hex because only four of PCO's seven swatch values have
ever come back from the API; a band covers the rest without guessing, and holds if PCO
adjusts a swatch. **Blue and lavender are crossed deliberately** — PCO's blue takes the
deeper `#4a86c8`, lavender the brighter `#58c1e4`. Lavender never renders purple, which
the project rule forbids.

`#ffffff` is how PCO stores *no colour* (it is Media's default) and `#eaebeb` (Header) is
a near-grey with no hue; both leave the row plain rather than drawing a meaningless
neutral stripe.

Add or change a colour in PCO and rows follow within the 15-minute service-type cache,
including brand-new custom item types — nothing to configure here.

### By category — a fixed table

| Category name contains | Colour |
|---|---|
| light | `#ffb224` amber |
| video, graphic, pro, screen | `#46a758` green |
| audio, sound, foh | `#0091ff` blue |
| vocal, band, music, md, key, drum | `#12a594` teal |
| stage, cam, director | `#e5484d` red |
| anything else | `#8b8d98` neutral |

Not configurable, deliberately. PCO has no colour for a note category — `ItemNote`
carries only `category_name / content / created_at / updated_at`, and `ItemNoteCategory`
only `name / sequence / frequently_used` — so any category colour is invented here
either way. A default that needs no setup beats a picker that must be filled in per
category before the feature does anything. The weakness is that an unmatched name
("Hospitality") is neutral grey; the categories that matter on a rundown all match.

### How a tint renders

```css
box-shadow: inset 3px 0 0 hsl(<hue> 72% 62%);   /* stripe — bright, reads at distance */
background:              hsl(<hue> 42% 15%);    /* wash  — sits behind the text */
```

One value cannot serve both a 3px rule and a text background, so the stripe and the wash
take the same hue at different saturation and lightness.

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
