# ScriptView — PCO row colours, custom accents, responsive layout

**Status:** approved in conversation; ready for an implementation plan.

Three changes to the ScriptView rundown.

| # | Change | Where |
|---|--------|-------|
| A | Pull PCO's item row colours and render them as stripe + wash | `pco-service.ts`, `rundown-table.tsx` |
| B | One editable colour per category, shared app-wide | `rundown-table.tsx`, `scriptview-section.tsx`, `settings-store.ts` |
| C | Responsive layout — reflow by width, no page max-width | `rundown-table.tsx` |

---

## A — PCO item row colours

### What the API gives us

Confirmed against the live API. `ServiceType` carries two arrays the app currently
discards:

```json
"standard_item_types": [
  {"name":"Header","index":6,"color":"#eaebeb"},
  {"name":"Media", "index":7,"color":"#ffffff"},
  {"name":"Song",  "index":0,"color":"#e8f6df"}
],
"custom_item_types": []
```

`listServiceTypes` already fetches this resource and maps only `{id, name}`, so the
colours cost **no extra request** — just stop dropping the fields.

**Matching.** Standard types match the item's `item_type` (`header` / `song` / `media`).
Custom types match by **text contained in the title** — PCO's own tooltip reads *"Items
that include this text in the title will be highlighted."* Matching is
case-insensitive and substring, not exact.

**Freshness.** `listServiceTypes` caches for `TTL_LONG_MS` (15 minutes). A colour added
in PCO therefore appears within 15 minutes, or immediately on a manual refresh, with no
app configuration. Because the app renders whatever the array contains, **new custom
types appear on their own** — nothing to add on this side.

### Rendering: stripe plus wash

PCO's palette is authored against a white table, so applied directly to a dark stage
display two of the three read as near-white blocks. The treatment is therefore:

```css
box-shadow: inset 3px 0 0 var(--pco);
background: color-mix(in srgb, var(--pco) 10%, transparent);
```

The stripe carries the hue at full strength (legible at distance); the wash groups the
row without lifting the background enough to fight the text.

**Pure white is "unset".** `#ffffff` is how PCO stores *no colour* — Media has it by
default. Rendering it produces a neutral grey stripe that looks deliberate but carries
no information, so `#ffffff` is treated as absent and falls through to the department
accent. Near-white values are kept: only exact white is special.

**Note on the palette.** PCO offers seven fixed swatches, two of which are lavender/pink.
The project rule is zero purple in the UI. That rule governs *our* chrome, not data an
operator chose in another system — if someone picks lavender in PCO, showing something
else would be worse. A 3px stripe at 10% wash keeps it well short of a purple surface.

## B — One colour per category, app-wide

Today `departmentColor()` infers a colour from keywords in the department name:
"Lighting" → amber, "Audio" → blue, and anything unmatched → grey with no way to change
it. That inference goes away.

**The accent options stay exactly as they are.** A layout still picks *which* category
drives its row accent (Audio, Lighting, …). What changes is only where that category's
colour comes from.

### Why the colours are global, not per layout

Note categories are fetched per service type (`listScriptViewNoteCategories(serviceTypeId)`),
so "Audio" exists independently under Weekend, Cornerstone Youth, The Salt Company and
Events. Storing colours on the layout would mean setting Audio's colour once per layout
*per service type* — and they would drift apart the first time one was missed.

So colours live once, app-wide, keyed by category name:

```ts
// settings.json
scriptViewCategoryColors?: Record<string, string>;   // "audio" -> "#0091ff"
```

Keys are normalised (trimmed, lowercased) on read and write, so "Audio", "audio" and
"Audio " are one entry. Set Audio once and every Audio column, in every layout, under
every service type, matches.

### Managing them

A single panel under Settings → ScriptView, above the layouts:

- **List** every known category with its swatch. Known = every category PCO reports across
  the configured service types, plus any added by hand, so the common case needs no typing.
- **Edit** a colour with the native `<input type="color">` — the same control the
  static-slot colour and the icon tint use.
- **Add** a category by name, for one PCO has not reported yet, or a name used in only one
  service type.
- **Delete** an entry, which reverts that category to the default rather than removing the
  category itself. A category always exists as long as PCO reports it; only the colour is
  the operator's to add or remove.

`departmentColor()` survives **only** as the suggested initial value when a category is
first given a colour — so existing boards keep the colours they have today, and the
keyword guess becomes a starting point rather than a permanent verdict. A category with
no entry falls back to it, then to the theme default.

The colour applies to that category's text in the row (the person's name, in practice)
and to the row accent when a layout selects that category — so colouring "names" and
colouring rows remain one setting, not two.

## C — Responsive layout

ScriptView is a kiosk `ViewKind`, so it renders on stage panels as well as laptops and
phones. **No page-level max-width**: a centred fixed column leaves dead margins on a
37&Prime; panel and forces text smaller relative to the viewport, which is backwards for a
surface read at distance.

Instead the shape changes where a column stops earning its space:

| Width | Shape | Why there |
|---|---|---|
| `< 640` | Stacked. Time becomes a chip, description under the title. | Three columns at phone width leaves the title ~12 characters, wrapping to four lines. |
| `640–1024` | Two columns. Description moves beneath the title, same row. | Description is the widest and least-scanned column, so it gives way first. |
| `> 1024` | Three columns, filling the width. Fixed time column; title and description share the rest. | Above this the table earns its full shape; on a stage panel every pixel of description is useful. |

If an ultrawide is ever used, cap the **description column**, not the page — a
page-level cap is what creates the dead-margin problem.

---

## What already colours a row today

Worth stating, because a reference screenshot of **ScriptViewer** (the separate product
at `cornerstonelife.scriptviewer.io`) shows richer colouring that is easy to mistake for
PCO data. It is not — it is that product's own styling. Ours currently has:

| Element | Treatment | Source |
|---|---|---|
| Key / BPM / arrangement metadata | `text-accent/85`, italic | local, `scriptview-columns.tsx:114` |
| SERVICE START / END headers | stronger band than ordinary section rows | local, `rundown-table.tsx:8` |
| Live item | accent stripe + wash | local |
| Department accent | `departmentColor()` keyword guess | local — replaced by B |

Things ScriptViewer colours that we do not: `VIDEO:` items in green, song titles in
italic, a pre-message countdown. Those are **item-type styling**, a third system
separate from both PCO row colours and department accents. Not in scope here, but the
PCO work supersedes most of it — a `Media` custom type in PCO would colour the VIDEO
rows without any hardcoded rule.

## Precedence

One row, three possible sources, first match wins:

1. **PCO item type colour** — the item's `item_type` matches a `standard_item_types`
   entry, or its title contains a `custom_item_types` name, and that colour is not
   `#ffffff`.
2. **Category accent** — the layout has an accent category set and this item has a note
   in it. Colour comes from the app-wide `scriptViewCategoryColors`, falling back to
   `departmentColor()` and then the theme default.
3. **Nothing** — plain row.

Both systems stay available: PCO takes precedence, and the department accent fills
every row PCO says nothing about.

## Testing

Matching and precedence are pure and belong in tests, with no network:

- `item_type: "song"` picks the Song colour; a title containing a custom type name picks
  that colour; a custom match beats a standard one.
- `#ffffff` is treated as unset and falls through to the category accent.
- Category keys normalise: "Audio", "audio" and "Audio " resolve to one colour.
- Deleting a colour reverts to the fallback without removing the category.
- Matching is case-insensitive and substring, not exact.
- With no PCO colour and no accent category, a row is plain.

The colour treatment itself (stripe + wash) is CSS and verified visually.

## Out of scope

- Item-type styling of our own (green VIDEO rows, italic song titles). PCO's custom item
  types cover the same ground from data the operator already controls.
- Person or team colours from PCO. `Team.stage_color` exists but returns *named* colours
  ("blue", "orange") for PCO's own Stage Display, and on this org resolves to two
  colours across five teams — not enough signal to be worth wiring up. The yellow names
  in the reference screenshot are that ScriptViewer's own styling, not PCO data.
- Writing colours back to PCO.
- Renaming ScriptView (deferred deliberately).
