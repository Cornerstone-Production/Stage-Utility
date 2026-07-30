# ScriptView — per-layout row color source

**Status:** approved in conversation; ready for an implementation plan.

Three related changes, all about what colors a rundown row.

| # | Change |
|---|--------|
| A | Each layout chooses its row color source: PCO, category, or off |
| B | PCO's colors map to a curated palette instead of being used literally |
| C | The category system returns — audio blue, lighting amber, video green |

---

## The problem being solved

Two color systems want the same surface, and they answer different questions:

- **PCO item color** — *what kind of item is this* (song, header, video)
- **Category accent** — *does my department have something to do on this item*

For an Audio layout the second is more useful: that a row is a song is already obvious
from its title, key and BPM. For a general rundown the first is. Stacking both puts two
colors on one row, which is too much information per line on a stage display.

So the source is a per-layout choice rather than a precedence rule.

## A — Row color source

```ts
interface ScriptViewLayout {
  // …existing fields
  /** What colors this layout's rows. Default "pco". */
  rowColor?: "pco" | "category" | "none";
  /** Which note category tints a row, when rowColor === "category". */
  accentDepartment?: string | null;
}
```

A `<Select>` in the layout editor: **Row color — From PCO / By category / None**. Picking
"By category" reveals the existing category picker; the other two hide it.

`"none"` is the toggle — a layout that wants a plain rundown.

Existing layouts have no `rowColor`, so they default to `"pco"` and look exactly as they
do today.

## B — Curated palette for PCO's colors

PCO's swatches are pale pastels authored for a white table. Used literally on a dark
panel they read as near-white — `#e0f7ff` is 88% lightness. The current code already
substitutes saturation and lightness while keeping the hue; this replaces that formula
with a chosen color per hue band, so each PCO swatch maps to a specific color we like
rather than a computed approximation.

Keyed by **hue band, not exact hex**. Only four of PCO's seven swatch values have been
observed (`#e8f6df` green, `#e0f7ff` blue, `#eaebeb` gray, `#ffffff` white); lavender,
pink and orange have never come back from the API. A hue band covers those without
guessing their hex, and keeps working if PCO ever adjusts a swatch.

| PCO swatch | Hue band | Maps to |
|---|---|---|
| green | 75–160 | `#46a758` |
| blue / cyan | 160–250 | `#58c1e4` |
| lavender | 250–290 | `#4a86c8` — **remapped out of purple**, per the project rule |
| pink | 290–345 | `#e0729a` |
| orange / red | 345–75 | `#ffb224` |
| white / gray | no hue | no color — see below |

The blue is the one already on screen and liked (`rgb(88, 193, 228)`).

**White and gray stay uncolored.** `#ffffff` is how PCO stores "no color" and is the
default on Media; `#eaebeb` (Header) is a near-gray with no hue to keep. Both leave the
row plain rather than drawing a neutral stripe that means nothing.

Rendering is unchanged: a bright saturated stripe plus a dark wash of the same hue, since
one value cannot serve both a 3px rule read at distance and a background sitting behind
text.

## C — Category colors

The keyword mapping returns, unchanged and not configurable:

| Category name contains | Color |
|---|---|
| light | `#ffb224` amber |
| video, graphic, pro, screen | `#46a758` green |
| audio, sound, foh | `#0091ff` blue |
| vocal, band, music, md, key, drum | `#12a594` teal |
| stage, cam, director | `#e5484d` red |
| anything else | `#8b8d98` neutral |

A row is tinted when the layout's chosen category has a note on that item — so an Audio
layout lights up exactly the items Audio has to do something for.

There is deliberately **no color picker**. PCO has no color for a note category —
`ItemNote` carries only `category_name / content / created_at / updated_at`, and
`ItemNoteCategory` only `name / sequence / frequently_used` — so any category color is
invented by us either way. A keyword default that needs no setup is better than a picker
that has to be filled in per category before the feature does anything.

The unmatched case (`#8b8d98`) is the known weakness: a category named "Hospitality" gets
neutral gray. Acceptable, because the categories that matter on a stage rundown — audio,
lighting, video, band, stage — all match.

## Testing

All pure, no network:

- Row source: `"pco"` uses the PCO color and ignores the category; `"category"` does the
  reverse; `"none"` is always plain; an absent field behaves as `"pco"`.
- Palette: each hue band maps to its color; white and gray map to nothing; a hue exactly
  on a boundary lands in one band, not both.
- Category: each keyword group maps to its color, matching is case-insensitive and
  substring, and an unmatched name is neutral.
- A row is tinted only when the chosen category actually has a note on that item.

## Out of scope

- A color picker for either system.
- Reading category or note colors from PCO. They do not exist.
- Coloring anything other than the row — column headers were tried and removed.
