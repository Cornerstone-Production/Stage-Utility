# ScriptView colours + responsive layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Colour ScriptView rows from PCO's own item row colours, let the operator set one colour per note category app-wide, and reflow the rundown by width instead of centring it.

**Architecture:** PCO's `standard_item_types` / `custom_item_types` ride along on a request `listServiceTypes` already makes, are resolved to a colour by a pure matcher, and render as a 3px stripe plus a 10% wash so a palette authored for a white table survives on a dark panel. Category colours move out of a keyword guess into one app-wide map keyed by normalised name. The table's shape changes at 640px and 1024px; the page never gets a max-width.

**Tech Stack:** TypeScript, Node ≥24 via `tsx` (no compile step), React 19, `node:test`. Zero third-party runtime deps in `main/`.

## Global Constraints

- Branch from `beta`. PRs #139/#140/#142/#143/#144 are open; do not stack on them.
- No emojis anywhere — UI, code, comments, commit messages. Lucide icons or text.
- Zero purple **in our own chrome**. PCO colours are operator data and render as given, including lavender and pink — see spec §A.
- Dark surfaces stay strictly R=G=B neutral. No `saturate()` over dark.
- Numeric inputs use the themed `NumberInput`, never raw `<input type="number">`.
- Colour inputs use the native `<input type="color">`, matching `slots-section.tsx` and `icon-tint.tsx`.
- Prod is plain HTTP — no secure-context-only browser APIs.
- Tests run through `tsx` over `main/**/*.test.ts` and `renderer/**/*.test.ts`. No network, no device I/O.
- Commits end with the Co-Authored-By + Claude-Session trailers.
- Update `docs/` in the same change. Target `beta`, never `main`.

---

## File Structure

**Part A — PCO item colours**
- Modify `main/types/stage.ts` — `PcoItemTypeColor`, `ServiceTypeDTO.itemTypeColors`, `ScriptViewRundownDTO.itemTypeColors`
- Modify `main/services/pco-service.ts:395-411` — stop discarding the two arrays
- Create `renderer/main/item-colour.ts` — `resolveItemColour()`, the pure matcher
- Create `renderer/main/item-colour.test.ts`
- Modify `renderer/main/rundown-table.tsx` — apply stripe + wash

**Part B — app-wide category colours**
- Modify `main/services/settings-store.ts` — `scriptViewCategoryColors`
- Modify `main/types/stage.ts` — same field on `StageState`
- Modify `main/services/stage-controller.ts` — `setCategoryColor()`
- Modify `main/services/routes/scriptview-routes.ts` — `POST /api/scriptview/category-color`
- Modify `renderer/lib/api.ts` — `scriptview:setCategoryColor`
- Create `renderer/main/category-colour.ts` — `categoryColour()`, normalisation + fallback
- Create `renderer/main/category-colour.test.ts`
- Modify `renderer/settings/sections/scriptview-section.tsx` — the management panel
- Modify `renderer/main/rundown-table.tsx` — read the map instead of guessing

**Part C — responsive**
- Modify `renderer/main/rundown-table.tsx` — width-driven shape

---

## Task 1: Carry PCO's item colours through the API

**Files:**
- Modify: `main/types/stage.ts:872-875`, `:938-961`
- Modify: `main/services/pco-service.ts:395-411`
- Modify: `main/services/stage-controller.ts` (rundown assembly)

**Interfaces:**
- Produces: `PcoItemTypeColor { name: string; color: string; custom: boolean }`; `ServiceTypeDTO.itemTypeColors?: PcoItemTypeColor[]`; `ScriptViewRundownDTO.itemTypeColors?: PcoItemTypeColor[]`.

- [ ] **Step 1: Add the types**

In `main/types/stage.ts`, above `ServiceTypeDTO`:

```ts
/** One of PCO's item row colours, from ServiceType.standard_item_types /
 *  custom_item_types. Standard entries match an item's `itemType`; custom entries
 *  match text CONTAINED in the title ("Items that include this text in the title
 *  will be highlighted"). */
export interface PcoItemTypeColor {
  /** "Header" / "Song" / "Media" for standard; the operator's text for custom. */
  name: string;
  /** "#rrggbb". PCO stores #ffffff to mean "no colour". */
  color: string;
  custom: boolean;
}
```

Then extend `ServiceTypeDTO`:

```ts
export interface ServiceTypeDTO {
  id: string;
  name: string;
  /** Item row colours configured on this service type in PCO. */
  itemTypeColors?: PcoItemTypeColor[];
}
```

And `ScriptViewRundownDTO`, after `noteCategories`:

```ts
  /** Item row colours for this rundown's service type (see PcoItemTypeColor). */
  itemTypeColors?: PcoItemTypeColor[];
```

- [ ] **Step 2: Stop discarding them in pco-service**

Replace the `result` mapping in `listServiceTypes` (`pco-service.ts:404-407`):

```ts
    const result: ServiceTypeDTO[] = items.map((item) => ({
      id: item.id,
      name: String(item.attributes.name ?? "Unknown"),
      // Free: this resource already carries the colours, we just stopped throwing
      // them away. `index` is PCO's palette slot and is not useful to us.
      itemTypeColors: [
        ...toItemColors(item.attributes.standard_item_types, false),
        ...toItemColors(item.attributes.custom_item_types, true),
      ],
    }));
```

Add above the class:

```ts
/** Normalise PCO's item-type arrays. Anything without a usable name + #rrggbb is
 *  dropped rather than guessed at. */
function toItemColors(raw: unknown, custom: boolean): PcoItemTypeColor[] {
  if (!Array.isArray(raw)) return [];
  const out: PcoItemTypeColor[] = [];
  for (const e of raw) {
    const name = typeof e?.name === "string" ? e.name.trim() : "";
    const color = typeof e?.color === "string" ? e.color.trim().toLowerCase() : "";
    if (!name || !/^#[0-9a-f]{6}$/.test(color)) continue;
    out.push({ name, color, custom });
  }
  return out;
}
```

Import `PcoItemTypeColor` in the type import at the top of `pco-service.ts`.

- [ ] **Step 3: Attach them to the rundown**

Find where `stage-controller.ts` builds the `ScriptViewRundownDTO` and add, alongside `noteCategories`:

```ts
      itemTypeColors: (await this.listServiceTypes()).find((t) => t.id === serviceTypeId)?.itemTypeColors ?? [],
```

`listServiceTypes` is cached for 15 minutes, so this adds no request.

- [ ] **Step 4: Verify against the live API**

Run: `npm run type-check`, then restart the dev server and

```bash
curl -s "http://localhost:8788/api/scriptview/rundown?serviceTypeId=41227" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('itemTypeColors'))"
```

Expected: the three standard entries — Header `#eaebeb`, Media `#ffffff`, Song `#e8f6df` — each with `custom: false`.

- [ ] **Step 5: Commit**

```bash
git add main/types/stage.ts main/services/pco-service.ts main/services/stage-controller.ts
git commit -m "feat(scriptview): carry PCO's item row colours through to the rundown"
```

---

## Task 2: The colour matcher

**Files:**
- Create: `renderer/main/item-colour.ts`
- Create: `renderer/main/item-colour.test.ts`

**Interfaces:**
- Consumes: `PcoItemTypeColor` (Task 1).
- Produces: `resolveItemColour(item: {itemType: string; title: string}, colours: PcoItemTypeColor[] | undefined): string | null`.

- [ ] **Step 1: Write the failing test**

Create `renderer/main/item-colour.test.ts`:

```ts
// Matching PCO's item row colours. Two rules that are easy to get backwards: custom
// types match text CONTAINED in the title (not the whole title, not the item type),
// and #ffffff means "no colour" rather than "white" — PCO ships it as the default on
// Media, so rendering it would paint a meaningless stripe on every video row.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { resolveItemColour } from "./item-colour.js";

const STANDARD = [
  { name: "Header", color: "#eaebeb", custom: false },
  { name: "Media", color: "#ffffff", custom: false },
  { name: "Song", color: "#e8f6df", custom: false },
];

describe("standard types match the item type", () => {
  test("a song gets the Song colour", () => {
    assert.equal(resolveItemColour({ itemType: "song", title: "He Will Be" }, STANDARD), "#e8f6df");
  });

  test("a header gets the Header colour", () => {
    assert.equal(resolveItemColour({ itemType: "header", title: "SERVICE START" }, STANDARD), "#eaebeb");
  });

  test("matching is case-insensitive on the type name", () => {
    const c = [{ name: "SONG", color: "#e8f6df", custom: false }];
    assert.equal(resolveItemColour({ itemType: "song", title: "x" }, c), "#e8f6df");
  });

  test("a plain item matches nothing", () => {
    assert.equal(resolveItemColour({ itemType: "item", title: "Welcome" }, STANDARD), null);
  });
});

describe("#ffffff means unset", () => {
  test("Media's default white does not colour the row", () => {
    assert.equal(resolveItemColour({ itemType: "media", title: "VIDEO: Pre-roll" }, STANDARD), null);
  });

  test("but a near-white is a real choice and is kept", () => {
    const c = [{ name: "Media", color: "#fffffe", custom: false }];
    assert.equal(resolveItemColour({ itemType: "media", title: "x" }, c), "#fffffe");
  });
});

describe("custom types match text inside the title", () => {
  const CUSTOM = [...STANDARD, { name: "VIDEO", color: "#ffd9b0", custom: true }];

  test("a title containing the text matches", () => {
    assert.equal(resolveItemColour({ itemType: "item", title: "VIDEO: Need To Know" }, CUSTOM), "#ffd9b0");
  });

  test("matching is case-insensitive and substring, not exact", () => {
    assert.equal(resolveItemColour({ itemType: "item", title: "Roll the video now" }, CUSTOM), "#ffd9b0");
  });

  test("a custom match beats a standard one", () => {
    // A song whose title contains the custom text takes the custom colour — the
    // operator typed that text deliberately.
    assert.equal(resolveItemColour({ itemType: "song", title: "VIDEO: Song Intro" }, CUSTOM), "#ffd9b0");
  });

  test("a custom entry set to white is still unset", () => {
    const c = [{ name: "VIDEO", color: "#ffffff", custom: true }];
    assert.equal(resolveItemColour({ itemType: "item", title: "VIDEO: x" }, c), null);
  });

  test("an empty custom name never matches everything", () => {
    // "" is contained in every string; guard against a blank entry painting the plan.
    const c = [{ name: "", color: "#ff0000", custom: true }];
    assert.equal(resolveItemColour({ itemType: "item", title: "Welcome" }, c), null);
  });
});

describe("absent config", () => {
  test("no colours configured means no colour", () => {
    assert.equal(resolveItemColour({ itemType: "song", title: "x" }, undefined), null);
    assert.equal(resolveItemColour({ itemType: "song", title: "x" }, []), null);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test renderer/main/item-colour.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the matcher**

Create `renderer/main/item-colour.ts`:

```ts
import type { PcoItemTypeColor } from "../../main/types/stage.js";

/** PCO stores #ffffff to mean "no colour" — it is the shipped default on Media. */
const UNSET = "#ffffff";

/**
 * The PCO item row colour for one item, or null when PCO says nothing about it.
 *
 * Custom types are checked first: they match text CONTAINED in the title, which the
 * operator typed deliberately, so they beat the broad standard type match.
 */
export function resolveItemColour(
  item: { itemType: string; title: string },
  colours: PcoItemTypeColor[] | undefined,
): string | null {
  if (!colours || colours.length === 0) return null;
  const title = item.title.toLowerCase();
  const type = item.itemType.trim().toLowerCase();

  for (const c of colours) {
    if (!c.custom) continue;
    const needle = c.name.trim().toLowerCase();
    // "" is contained in every string — a blank entry must not paint the whole plan.
    if (!needle) continue;
    if (title.includes(needle)) return c.color === UNSET ? null : c.color;
  }

  for (const c of colours) {
    if (c.custom) continue;
    if (c.name.trim().toLowerCase() === type) return c.color === UNSET ? null : c.color;
  }

  return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx tsx --test renderer/main/item-colour.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Prove they aren't vacuous**

Change `if (title.includes(needle))` to `if (title === needle)`. Re-run — the two substring tests must fail. Revert. Then change `c.color === UNSET ? null : c.color` to `c.color` in both places. Re-run — the two "#ffffff means unset" tests must fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add renderer/main/item-colour.ts renderer/main/item-colour.test.ts
git commit -m "feat(scriptview): match PCO item row colours to plan items"
```

---

## Task 3: App-wide category colours — storage and resolution

**Files:**
- Modify: `main/services/settings-store.ts`
- Modify: `main/types/stage.ts` (StageState)
- Modify: `main/services/stage-controller.ts`
- Modify: `main/services/routes/scriptview-routes.ts`
- Modify: `renderer/lib/api.ts`
- Create: `renderer/main/category-colour.ts`
- Create: `renderer/main/category-colour.test.ts`

**Interfaces:**
- Produces: `StageState.scriptViewCategoryColors?: Record<string, string>`; `stageController.setCategoryColor(category: string, color: string): Promise<StageState>`; `categoryColour(category: string, map: Record<string,string> | undefined): string`.

- [ ] **Step 1: Write the failing test**

Create `renderer/main/category-colour.test.ts`:

```ts
// Category colours are stored once, app-wide, because note categories are fetched per
// service type — "Audio" exists separately under Weekend, Youth and Salt Company. Keys
// therefore normalise, so setting Audio once colours all of them.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { categoryColour, normaliseCategory, DEFAULT_CATEGORY_COLOUR } from "./category-colour.js";

describe("normalisation", () => {
  test("case and surrounding space collapse to one key", () => {
    assert.equal(normaliseCategory("Audio"), "audio");
    assert.equal(normaliseCategory("  audio "), "audio");
    assert.equal(normaliseCategory("AUDIO"), "audio");
  });
});

describe("categoryColour", () => {
  test("uses the configured colour", () => {
    assert.equal(categoryColour("Audio", { audio: "#0091ff" }), "#0091ff");
  });

  test("finds it regardless of how the category is cased", () => {
    assert.equal(categoryColour("  AUDIO ", { audio: "#0091ff" }), "#0091ff");
  });

  test("falls back to the keyword suggestion when unset", () => {
    // departmentColor()'s guess survives ONLY as a fallback, so an existing board
    // looks identical until someone chooses a colour.
    assert.equal(categoryColour("Lighting", {}), "#ffb224");
    assert.equal(categoryColour("Audio", undefined), "#0091ff");
  });

  test("an unrecognised category gets the neutral default", () => {
    assert.equal(categoryColour("Hospitality", {}), DEFAULT_CATEGORY_COLOUR);
  });

  test("a configured colour beats the keyword guess", () => {
    // The whole point: "Lighting" is no longer forced to amber.
    assert.equal(categoryColour("Lighting", { lighting: "#12a594" }), "#12a594");
  });

  test("deleting an entry reverts to the fallback rather than blanking", () => {
    const map: Record<string, string> = { lighting: "#12a594" };
    delete map.lighting;
    assert.equal(categoryColour("Lighting", map), "#ffb224");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test renderer/main/category-colour.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the resolver**

Create `renderer/main/category-colour.ts`:

```ts
/** Neutral used when a category has no colour and matches no keyword. */
export const DEFAULT_CATEGORY_COLOUR = "#8b8d98";

/** One key per category name, regardless of casing or padding — note categories come
 *  from PCO per service type, so "Audio" under Weekend and "audio " under Youth must
 *  resolve to the same colour. */
export function normaliseCategory(name: string): string {
  return name.trim().toLowerCase();
}

/** The keyword guess that used to BE the colour. It survives only as the suggested
 *  fallback, so boards look identical until someone picks something. */
function suggestion(name: string): string {
  const d = normaliseCategory(name);
  if (d.includes("light")) return "#ffb224";
  if (d.includes("video") || d.includes("graphic") || d.includes("pro") || d.includes("screen")) return "#46a758";
  if (d.includes("audio") || d.includes("sound") || d.includes("foh")) return "#0091ff";
  if (d.includes("vocal") || d.includes("band") || d.includes("music") || d.includes("md") || d.includes("key") || d.includes("drum")) return "#12a594";
  if (d.includes("stage") || d.includes("cam") || d.includes("director")) return "#e5484d";
  return DEFAULT_CATEGORY_COLOUR;
}

/** The colour for a note category: the operator's choice, else the keyword suggestion. */
export function categoryColour(name: string, map: Record<string, string> | undefined): string {
  const chosen = map?.[normaliseCategory(name)];
  return chosen || suggestion(name);
}

/** The value a colour picker should open on for a category with no colour yet. */
export function suggestedCategoryColour(name: string): string {
  return suggestion(name);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx tsx --test renderer/main/category-colour.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the storage**

In `main/services/settings-store.ts`, beside `iconColors`:

```ts
  /** Note category (normalised) → "#rrggbb". App-wide so one Audio colour covers
   *  every service type. */
  scriptViewCategoryColors?: Record<string, string>;
```

and in the defaults object: `scriptViewCategoryColors: {},`

In `main/types/stage.ts`, on `StageState` beside `iconColors`:

```ts
  scriptViewCategoryColors?: Record<string, string>;
```

- [ ] **Step 6: Add the controller method**

In `main/services/stage-controller.ts`, beside `setIconColor`:

```ts
  /**
   * Set (or clear, with "") one note category's colour. Stored app-wide and keyed by
   * the normalised name, so Audio is the same colour under every service type.
   * Clearing removes the entry and the category falls back to its suggestion — it
   * does not hide the category, which PCO owns.
   */
  async setCategoryColor(category: string, color: string): Promise<StageState> {
    const key = category.trim().toLowerCase();
    if (!key) throw new Error("category-color — category required");
    const c = color.trim().toLowerCase();
    if (c !== "" && !/^#[0-9a-f]{6}$/.test(c)) {
      throw new Error('category-color — color must be "#rrggbb" or "" to clear');
    }
    const next = { ...(this.state.scriptViewCategoryColors ?? {}) };
    if (c === "") delete next[key];
    else next[key] = c;
    console.log(`[stage-controller] setCategoryColor ${key} → ${c || "(cleared)"}`);
    this.state = { ...this.state, scriptViewCategoryColors: next };
    await settingsStore.patch({ scriptViewCategoryColors: next });
    this.broadcast();
    return this.state;
  }
```

- [ ] **Step 7: Add the route and channel**

In `main/services/routes/scriptview-routes.ts`, beside the other POST routes:

```ts
    if (method === "POST" && pathname === "/api/scriptview/category-color") {
      const body = await readBody(req) as Record<string, unknown>;
      const category = typeof body.category === "string" ? body.category : "";
      const color = typeof body.color === "string" ? body.color : "";
      try {
        json(res, await stageController.setCategoryColor(category, color));
      } catch (err) {
        error(res, err instanceof Error ? err.message : String(err));
      }
      return;
    }
```

In `renderer/lib/api.ts`, beside the other scriptview channels:

```ts
    // "" clears the colour; the category then falls back to its suggestion.
    case "scriptview:setCategoryColor":
      return post<T>("/api/scriptview/category-color", { category: p.category, color: p.color });
```

- [ ] **Step 8: Verify against the running server**

```bash
curl -s -X POST http://localhost:8788/api/scriptview/category-color \
  -H 'Content-Type: application/json' -d '{"category":"Audio","color":"#ff6600"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('scriptViewCategoryColors'))"
```

Expected: `{'audio': '#ff6600'}` — note the normalised key. Then post `{"category":"Audio","color":"red"}` and expect the `#rrggbb` error, and `{"category":"Audio","color":""}` and expect `{}`.

- [ ] **Step 9: Commit**

```bash
git add main/ renderer/lib/api.ts renderer/main/category-colour.ts renderer/main/category-colour.test.ts
git commit -m "feat(scriptview): one colour per note category, stored app-wide"
```

---

## Task 4: Apply both colour systems to the rundown

**Files:**
- Modify: `renderer/main/rundown-table.tsx:23-31` (delete `departmentColor`), `:86-110` (row render)
- Modify: `renderer/main/scriptview-plan-view.tsx` (pass the two inputs down)

**Interfaces:**
- Consumes: `resolveItemColour` (Task 2), `categoryColour` (Task 3), `ScriptViewRundownDTO.itemTypeColors` (Task 1).

- [ ] **Step 1: Replace departmentColor with the shared resolver**

Delete `departmentColor()` from `rundown-table.tsx` and re-export the new one so existing importers keep working:

```ts
export { categoryColour, suggestedCategoryColour } from "./category-colour";
```

Update every `departmentColor(x)` call site to `categoryColour(x, categoryColors)`.

- [ ] **Step 2: Take the new props**

Add to the table's props:

```ts
  /** PCO's item row colours for this service type. */
  itemTypeColors?: PcoItemTypeColor[];
  /** App-wide note category → colour. */
  categoryColors?: Record<string, string>;
```

and pass both from `scriptview-plan-view.tsx`:

```tsx
  itemTypeColors={rundown?.itemTypeColors}
  categoryColors={state?.scriptViewCategoryColors}
```

- [ ] **Step 3: Apply the precedence**

In the row render, before the existing accent logic:

```tsx
          // PCO's colour wins where it has one; the category accent fills the rest.
          const pco = resolveItemColour(it, itemTypeColors);
          const accent = pco
            ?? (accentActive && accentDepartment ? categoryColour(accentDepartment, categoryColors) : null);
```

and apply it as stripe + wash — a palette authored for a white table needs both to survive a dark panel:

```tsx
            style={accent ? {
              boxShadow: `inset 3px 0 0 ${accent}`,
              background: `color-mix(in srgb, ${accent} 10%, transparent)`,
            } : undefined}
```

Keep the live-item treatment taking precedence over both: a running item must stay the most prominent row.

- [ ] **Step 4: Verify**

Run: `npm run type-check && npm run lint && npm test && npm run build`, then open
`http://localhost:8788/scriptview/weekend/audio` and confirm song rows carry a pale
green stripe, `VIDEO:` rows carry none (Media is `#ffffff`), and the live row still wins.

- [ ] **Step 5: Commit**

```bash
git add renderer/main/rundown-table.tsx renderer/main/scriptview-plan-view.tsx
git commit -m "feat(scriptview): render PCO and category colours as stripe plus wash"
```

---

## Task 5: The category colour panel

**Files:**
- Modify: `renderer/settings/sections/scriptview-section.tsx`

- [ ] **Step 1: Build the panel**

Above the layouts list, a panel listing every known category — the union of the note
categories reported for the configured service types and any key already in the map, so
the common case needs no typing:

```tsx
{/* One colour per category, app-wide: note categories are per service type, so
    setting Audio here covers Weekend, Youth and Salt Company at once. */}
<FieldSet title="Category colours">
  <div className="flex flex-col gap-1">
    {knownCategories.map((cat) => {
      const key = normaliseCategory(cat);
      const set = colors[key];
      return (
        <div key={key} className="flex items-center gap-2">
          <label
            className="size-5 shrink-0 cursor-pointer rounded border border-line-strong"
            style={{ backgroundColor: categoryColour(cat, colors) }}
            title={`Change the ${cat} colour`}
          >
            <input
              type="color"
              className="sr-only"
              value={categoryColour(cat, colors)}
              aria-label={`${cat} colour`}
              onChange={(e) => void invoke("scriptview:setCategoryColor", { category: cat, color: e.target.value })}
            />
          </label>
          <span className="flex-1 min-w-0 truncate text-caption1 text-gray-11">{cat}</span>
          {set && (
            <Button
              variant="transparent"
              size="small"
              onClick={() => void invoke("scriptview:setCategoryColor", { category: cat, color: "" })}
              title="Reset to the default colour"
            >
              Reset
            </Button>
          )}
        </div>
      );
    })}
  </div>
</FieldSet>
```

Add a small "Add category" row — an `Input` plus a button that calls
`scriptview:setCategoryColor` with the typed name and its suggested colour, for a
category PCO has not reported.

The delete affordance is labelled **Reset**, not Delete: it clears the colour and the
category falls back to its suggestion. PCO owns whether a category exists.

- [ ] **Step 2: Verify**

Set Audio to orange, confirm it applies on `/scriptview/weekend/audio` **and**
`/scriptview/cornerstone-youth/audio` — the same colour under both service types is the
whole point. Then Reset and confirm it returns to `#0091ff`.

- [ ] **Step 3: Commit**

```bash
git add renderer/settings/sections/scriptview-section.tsx
git commit -m "feat(scriptview): manage category colours from settings"
```

---

## Task 6: Responsive rundown

**Files:**
- Modify: `renderer/main/rundown-table.tsx`

- [ ] **Step 1: Measure the container, not the viewport**

The table renders inside a display frame and inside the settings live preview, so a
media query on the viewport would be wrong in the preview. Use a `ResizeObserver` on the
table's own wrapper:

```tsx
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1280);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const shape = w < 640 ? "stacked" : w < 1024 ? "compact" : "full";
```

- [ ] **Step 2: Change the shape, not the width**

No page-level max-width — a centred column leaves dead margins on a stage panel and
shrinks the text relative to the viewport, which is backwards for a surface read at
distance. Instead:

- `full` — every column, filling the width (today's behaviour).
- `compact` — drop the Clock column; note-category columns move under the title.
- `stacked` — one column per row: time as a chip, title, then each note category on its
  own line labelled with its name.

- [ ] **Step 3: Verify at each width**

Open a ScriptView display and resize from 1800 down to 380, confirming the two
transitions and that nothing overflows horizontally at any width. Check the settings
live preview still renders correctly, since it is a narrow container on a wide viewport
— the case a viewport media query would have got wrong.

- [ ] **Step 4: Commit**

```bash
git add renderer/main/rundown-table.tsx
git commit -m "feat(scriptview): reflow the rundown by container width"
```

---

## Task 7: Docs

**Files:**
- Modify: `docs/features/scriptview-and-baptisms.md`

- [ ] **Step 1: Document all three**

Cover: where PCO's colours come from and that new custom types appear on their own
within the 15-minute service-type cache; that `#ffffff` means unset; the precedence
(PCO, then category, then plain); that category colours are app-wide and normalised;
that Reset clears a colour rather than hiding a category; and the three responsive
shapes with the reason there is no page max-width.

- [ ] **Step 2: Commit and open the PR**

```bash
git add docs/
git commit -m "docs(scriptview): colours and responsive layout"
gh pr create --base beta --title "feat(scriptview): PCO row colours, category colours, responsive layout"
```

---

## Self-review notes

**Spec coverage.** §A → Tasks 1, 2, 4. §B → Tasks 3, 5. §C → Task 6. Precedence → Task 4
step 3. Testing → Tasks 2 and 3. Docs → Task 7.

**Deviation from the spec, deliberate.** The spec said the responsive breakpoints are
width-driven without saying *which* width. Task 6 uses a `ResizeObserver` on the table's
container rather than a viewport media query, because the table also renders inside the
settings live preview — a narrow container on a wide viewport, which a media query would
get wrong.

**Not covered by tests.** The settings panel (Task 5) and the responsive shapes (Task 6)
are verified in the browser; the repo has no React testing harness and adding one is out
of scope. The logic behind both — matching, normalisation, fallback — is unit-tested.
