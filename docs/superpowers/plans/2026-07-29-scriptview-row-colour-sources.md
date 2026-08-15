# ScriptView row colour sources — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each ScriptView layout chooses what colours its rows — PCO's item colours (remapped to a curated palette), its own note category, or nothing.

**Architecture:** One `rowColour` field per layout replaces the previous precedence rule, so a row never carries two competing colours. PCO's pale swatches map through a hue-band table to colours chosen for a dark panel; the category system returns as a fixed keyword table with no configuration.

**Tech Stack:** TypeScript, React 19, `node:test` via `tsx`.

## Global Constraints

- Branch from `beta`. #145 is open and this builds on it — branch from `feat/scriptview-colours`, not `beta`, and it merges as part of that PR.
- No emojis. Numeric inputs use `NumberInput`.
- Zero purple in our own chrome. PCO lavender is **remapped**, so nothing purple reaches the UI.
- Tests: pure functions only, no network, no DOM.
- Commits carry the Co-Authored-By + Claude-Session trailers.
- Update `docs/features/scriptview-and-baptisms.md` in the same change.

---

## File Structure

- Modify `main/types/stage.ts` — `ScriptViewLayout.rowColour`, un-deprecate `accentDepartment`
- Modify `main/services/scriptview-layouts-store.ts` — starter layouts
- Modify `renderer/main/item-colour.ts` — curated hue-band palette replaces the formula
- Create `renderer/main/category-colour.ts` — the keyword table
- Create `renderer/main/category-colour.test.ts`
- Modify `renderer/main/item-colour.test.ts` — palette tests
- Modify `renderer/main/rundown-table.tsx` — source selection
- Modify `renderer/settings/sections/scriptview-section.tsx` — the Row colour select

---

## Task 1: The curated PCO palette

**Files:** Modify `renderer/main/item-colour.ts`, `renderer/main/item-colour.test.ts`

**Interfaces:** Produces `mapPcoColour(hex: string): string | null` — the curated colour for a PCO swatch, or null when PCO means "no colour". `stripeFor`/`washFor` keep their signatures and now take an already-mapped colour.

- [ ] **Step 1: Write the failing tests**

```ts
describe("mapPcoColour", () => {
  test("PCO green maps to the curated green", () => {
    assert.equal(mapPcoColour("#e8f6df"), "#46a758");
  });

  test("PCO blue maps to the deeper blue", () => {
    // Bands for blue and lavender are deliberately crossed: hue 160-250 (PCO's blue)
    // takes #4a86c8, and 250-290 (lavender) takes #58c1e4.
    assert.equal(mapPcoColour("#e0f7ff"), "#4a86c8");
  });

  test("PCO lavender maps to a blue, never purple", () => {
    assert.equal(mapPcoColour("#e6e0f8"), "#58c1e4");
  });

  test("white is PCO's way of saying no colour", () => {
    assert.equal(mapPcoColour("#ffffff"), null);
  });

  test("a near-grey has no hue to map", () => {
    assert.equal(mapPcoColour("#eaebeb"), null);
  });

  test("nothing maps into the purple band", () => {
    for (let h = 0; h < 360; h += 3) {
      const out = mapPcoColour(hslHex(h, 40, 90));
      if (!out) continue;
      const hue = hueOfHex(out);
      assert.ok(hue == null || hue < 233 || hue > 327, `hue ${h} mapped to purple`);
    }
  });
});
```

- [ ] **Step 2: Run and watch it fail** — `npx tsx --test renderer/main/item-colour.test.ts`

- [ ] **Step 3: Implement**

```ts
/** PCO's swatches are pale pastels for a white table. Each hue band maps to a colour
 *  chosen for a dark panel. Keyed by BAND, not exact hex: only four of PCO's seven
 *  swatch values have ever come back from the API. */
const PALETTE: { from: number; to: number; colour: string }[] = [
  { from: 75, to: 160, colour: "#46a758" },   // green
  { from: 160, to: 250, colour: "#4a86c8" },  // PCO blue
  { from: 250, to: 290, colour: "#58c1e4" },  // PCO lavender — never rendered purple
  { from: 290, to: 345, colour: "#e0729a" },  // pink
];
const WARM = "#ffb224"; // 345-75 wraps zero

export function mapPcoColour(hex: string): string | null {
  if (hex.trim().toLowerCase() === "#ffffff") return null; // PCO's "no colour"
  const h = hueOf(hex);
  if (h == null) return null;                              // near-grey, e.g. Header
  for (const b of PALETTE) if (h >= b.from && h < b.to) return b.colour;
  return WARM;
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(scriptview): map PCO colours to a curated palette"`

---

## Task 2: The category keyword table

**Files:** Create `renderer/main/category-colour.ts` + test

**Interfaces:** Produces `categoryColour(name: string): string`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("categoryColour", () => {
  test("the categories that matter on a rundown each get their colour", () => {
    assert.equal(categoryColour("Lighting"), "#ffb224");
    assert.equal(categoryColour("Video"), "#46a758");
    assert.equal(categoryColour("Audio"), "#0091ff");
    assert.equal(categoryColour("Band"), "#12a594");
    assert.equal(categoryColour("Stage Manager"), "#e5484d");
  });

  test("matching is case-insensitive and substring", () => {
    assert.equal(categoryColour("  MD + Playback Tech "), "#12a594");
    assert.equal(categoryColour("FOH"), "#0091ff");
  });

  test("an unmatched category is neutral rather than arbitrary", () => {
    assert.equal(categoryColour("Hospitality"), "#8b8d98");
  });
});
```

- [ ] **Step 2: Run and watch it fail**
- [ ] **Step 3: Implement** the keyword table exactly as the spec lists it.
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

---

## Task 3: Per-layout row colour source

**Files:** Modify `main/types/stage.ts`, `main/services/scriptview-layouts-store.ts`, `renderer/main/rundown-table.tsx`

- [ ] **Step 1: The type**

```ts
  /** What colours this layout's rows. Absent = "pco", so existing layouts are unchanged. */
  rowColour?: "pco" | "category" | "none";
  /** Which note category tints a row, when rowColour === "category". */
  accentDepartment?: string | null;
```

- [ ] **Step 2: Resolve the colour in the table**

```tsx
  // One source per row, chosen by the layout. Never both: a row carrying two colours
  // is more information than a line on a stage display can hold.
  const src = rowColour ?? "pco";
  const rowTint = isCurrent || src === "none"
    ? null
    : src === "category"
      ? (accentDepartment && it.notesByCategory[accentDepartment]?.trim()
          ? categoryColour(accentDepartment) : null)
      : mapPcoColour(resolveItemColour(it, itemTypeColors) ?? "");
```

Apply as today: `boxShadow: inset 3px 0 0 0 ${stripeFor(rowTint)}` and
`background: washFor(rowTint)`.

- [ ] **Step 3: Starter layouts** — give the Audio/Video/Lighting/Stage starters
  `rowColour: "category"` with their matching `accentDepartment`, and Simple `"none"`.

- [ ] **Step 4: Verify** — `npm run type-check && npm run lint && npm test && npm run build`
- [ ] **Step 5: Commit**

---

## Task 4: The layout editor control

**Files:** Modify `renderer/settings/sections/scriptview-section.tsx`

- [ ] **Step 1: Add the select**

A `Row colour` select — From PCO / By category / None — and, only when "By category" is
chosen, the existing category picker beside it.

- [ ] **Step 2: Verify in the browser** — switch a layout between all three and confirm the
  preview updates, then check the live page at `/scriptview/weekend/audio`.

- [ ] **Step 3: Commit**

---

## Task 5: Docs

- [ ] **Step 1:** Document the three sources, the hue-band table (noting blue and lavender
  are crossed deliberately), the keyword table, and that PCO has no category or note
  colour so the category palette is necessarily ours.
- [ ] **Step 2:** Commit and push to the existing PR.

---

## Self-review notes

**Spec coverage.** §A → Tasks 3, 4. §B → Task 1. §C → Task 2. Testing → Tasks 1, 2.

**Deliberate deviation.** The spec's table has blue at 160-250 and lavender at 250-290
mapping to `#58c1e4` and `#4a86c8` respectively; those targets are swapped here at the
operator's request, so PCO blue renders as `#4a86c8` and lavender as `#58c1e4`.

**Not covered by tests.** The layout editor select is verified in the browser; the repo
has no React testing harness.
