# Slot matching, cell labels, Ross grouping, live Overview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a slot match a range of PCO positions with per-position notes, show custom/RX labels on live slot cells, group the two Ross integrations into one card, and include the running service in the History Overview trend.

**Architecture:** Four independent changes sharing no code. A replaces `SlotLink.teamPositionName` with a `positions` array and adds identical-set claiming to the pure `resolveSlots`. B changes only rendering — `device.label`/`device.iemLabel` already reach live slots. C is a presentation wrapper; both integration ids stay. D removes one guard clause and splits the average out.

**Tech Stack:** TypeScript, Node ≥24 via `tsx` (no compile step), React 19, `node:test`. Zero third-party runtime deps in `main/`.

## Global Constraints

- Branch from `beta`, not from the current branch. PRs #134 and #135 are still open; do not stack on them.
- Each phase (A/B/C/D) is one PR. They can merge in any order.
- No emojis anywhere — UI, code, comments, commit messages. Use Lucide icons or text.
- Zero purple. Dark surfaces must be strictly R=G=B neutral. No `saturate()` over dark.
- Numeric inputs use the themed `NumberInput`, never raw `<input type="number">`.
- Prod is served over plain HTTP — no secure-context-only browser APIs (`crypto.randomUUID` etc.).
- Tests: `npm test` runs `main/**/*.test.ts` and `renderer/**/*.test.ts` through `tsx`. No network, no device I/O, no real timers left pending.
- Commits: Conventional Commits, concise. Every commit body ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
  ```
- Update `docs/` with each phase. Do not open a PR to `main`; target `beta`.

---

## File Structure

**Phase A**
- Modify `main/types/stage.ts` — `SlotPositionMatch`, `SlotLink.positions`
- Modify `main/services/slot-resolver.ts` — per-entry matching + identical-set claiming
- Modify `main/services/slots-store.ts` — v3 link migration in `loadNormalised`
- Create `main/services/slot-resolver.test.ts`
- Modify `renderer/settings/sections/slots-section.tsx` — multi-select editor
- Modify `renderer/settings/settings-view.tsx:719`, `renderer/settings/sections/inline-slots-editor.tsx:80`, `renderer/settings/sections/slots-section.tsx:85,94` — default link
- Modify `renderer/components/slot-panel.tsx:204` — position caption

**Phase B**
- Create `renderer/components/slot-strip-mode.ts` — pure strip/pill decision
- Create `renderer/components/slot-strip-mode.test.ts`
- Modify `renderer/components/status-strip.tsx:154-168` — label replaces frequency, IEM second line
- Modify `renderer/components/slot-panel.tsx:209-223` — use the helper
- Modify `renderer/settings/sections/slots-section.tsx` — "Use receiver name" action

**Phase C**
- Modify `renderer/components/integrations-panel.tsx` — `IntegrationPairRow`

**Phase D**
- Modify `renderer/settings/sections/service-history-section.tsx:441-512`
- Create `renderer/settings/sections/overview-scope.test.ts`

---

# Phase A — Position ranges

### Task A1: The type and the migration

**Files:**
- Modify: `main/types/stage.ts:992`
- Modify: `main/services/slots-store.ts:16-40`
- Test: `main/services/slots-store-migration.test.ts` (create)

**Interfaces:**
- Produces: `SlotPositionMatch { name?: string; notesStartsWith?: string }`; `SlotLink` variant `{ kind: "pco"; matchBy: "position"; positions: SlotPositionMatch[] }`; exported `migrateSlotLink(link: unknown): SlotLink`.

- [ ] **Step 1: Write the failing test**

Create `main/services/slots-store-migration.test.ts`:

```ts
// The v3 link migration. Runs once per install against config written by an older
// version — get it wrong and a configured mic board silently stops matching anyone.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { migrateSlotLink } from "./slots-store.js";

describe("v2 -> v3 slot link migration", () => {
  test("a position + note becomes a single-entry range", () => {
    assert.deepEqual(
      migrateSlotLink({ kind: "pco", matchBy: "position", teamPositionName: "Vocals", notesStartsWith: "4" }),
      { kind: "pco", matchBy: "position", positions: [{ name: "Vocals", notesStartsWith: "4" }] },
    );
  });

  test("a position with no note keeps the entry, drops the key", () => {
    assert.deepEqual(
      migrateSlotLink({ kind: "pco", matchBy: "position", teamPositionName: "Acoustic" }),
      { kind: "pco", matchBy: "position", positions: [{ name: "Acoustic" }] },
    );
  });

  test("the empty-string default becomes an unconfigured slot", () => {
    // settings-view.tsx and the slot editors create links with teamPositionName: "".
    assert.deepEqual(
      migrateSlotLink({ kind: "pco", matchBy: "position", teamPositionName: "" }),
      { kind: "pco", matchBy: "position", positions: [] },
    );
  });

  test("an already-migrated link is returned untouched", () => {
    const v3 = { kind: "pco", matchBy: "position", positions: [{ name: "Keys" }] };
    assert.deepEqual(migrateSlotLink(v3), v3);
  });

  test("migration is idempotent", () => {
    const once = migrateSlotLink({ kind: "pco", matchBy: "position", teamPositionName: "Drums", notesStartsWith: "1" });
    assert.deepEqual(migrateSlotLink(once), once);
  });

  test("non-position links pass through unchanged", () => {
    for (const link of [
      { kind: "pco", matchBy: "person", personId: "123" },
      { kind: "static", label: "Pastor", color: "#336699" },
      { kind: "empty" },
      { kind: "spacer", showEmptyImage: true },
    ]) {
      assert.deepEqual(migrateSlotLink(link), link);
    }
  });

  test("garbage becomes an unconfigured position link rather than throwing", () => {
    // DataStore does not deep-merge on load, so a hand-edited file can hold anything.
    assert.deepEqual(migrateSlotLink(null), { kind: "pco", matchBy: "position", positions: [] });
    assert.deepEqual(migrateSlotLink({ kind: "pco", matchBy: "banana" }), { kind: "pco", matchBy: "position", positions: [] });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/slots-store-migration.test.ts`
Expected: FAIL — `migrateSlotLink` is not exported from `slots-store.js`.

- [ ] **Step 3: Add the type**

In `main/types/stage.ts`, immediately above `SlotLink` (around line 985), add:

```ts
/** One position a slot will accept, with an optional note filter scoped to it.
 *  `name` omitted = any position (the note is then the only constraint). An entry
 *  with neither is a misconfiguration and never matches. */
export interface SlotPositionMatch {
  name?: string;
  notesStartsWith?: string;
}
```

Then replace the `matchBy: "position"` variant:

```ts
  | { kind: "pco"; matchBy: "position"; positions: SlotPositionMatch[] }
```

- [ ] **Step 4: Add the migration**

In `main/services/slots-store.ts`, add the import and the exported function above `loadNormalised`:

```ts
import type { Slot, SlotLink } from "../types/stage.js";

/** v2 -> v3: a single `teamPositionName` + `notesStartsWith` becomes a `positions`
 *  range. Exported for tests. Total by design — DataStore does not deep-merge on
 *  load, so anything on disk must come back as a valid SlotLink. */
export function migrateSlotLink(link: unknown): SlotLink {
  const l = link as Record<string, unknown> | null;
  if (!l || typeof l !== "object") return { kind: "pco", matchBy: "position", positions: [] };

  if (l.kind === "static" || l.kind === "empty" || l.kind === "spacer") return l as unknown as SlotLink;
  if (l.kind === "pco" && l.matchBy === "person") return l as unknown as SlotLink;

  if (l.kind === "pco" && l.matchBy === "position") {
    if (Array.isArray(l.positions)) return l as unknown as SlotLink; // already v3
    const name = typeof l.teamPositionName === "string" ? l.teamPositionName.trim() : "";
    const note = typeof l.notesStartsWith === "string" ? l.notesStartsWith.trim() : "";
    if (!name) return { kind: "pco", matchBy: "position", positions: [] };
    return {
      kind: "pco",
      matchBy: "position",
      positions: [note ? { name, notesStartsWith: note } : { name }],
    };
  }

  return { kind: "pco", matchBy: "position", positions: [] };
}
```

Then apply it inside `loadNormalised`, just before the v2 return (replacing line 38-39):

```ts
  // v3: rewrite every slot's link into the positions-range shape. Cheap and
  // idempotent, so it runs on every load rather than needing a version stamp.
  const map = raw as SlotsMap;
  let changed = false;
  for (const byType of Object.values(map)) {
    for (const slots of Object.values(byType)) {
      for (const slot of slots as Slot[]) {
        const next = migrateSlotLink(slot.link);
        if (JSON.stringify(next) !== JSON.stringify(slot.link)) {
          slot.link = next;
          changed = true;
        }
      }
    }
  }
  if (changed) {
    await store.save(map);
    console.log("[slots-store] migrated v2 links -> v3 position ranges");
  }
  return map;
```

- [ ] **Step 5: Run the test — it should pass**

Run: `npx tsx --test main/services/slots-store-migration.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Prove the tests aren't vacuous**

Temporarily change `if (!name) return { ... positions: [] }` to `if (false)`. Re-run.
Expected: the empty-string test FAILS. Revert the change.

- [ ] **Step 7: Type-check**

Run: `npm run type-check`
Expected: errors in `slot-resolver.ts`, `slots-section.tsx`, `slot-panel.tsx`, `settings-view.tsx`, `inline-slots-editor.tsx` — every remaining reader of `teamPositionName`. That is the point of the change; A2 and A3 fix them.

- [ ] **Step 8: Commit**

```bash
git add main/types/stage.ts main/services/slots-store.ts main/services/slots-store-migration.test.ts
git commit -m "feat(slots): position ranges with per-position notes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task A2: Resolver — per-entry matching and identical-set claiming

**Files:**
- Modify: `main/services/slot-resolver.ts:75-115` and `117-168`
- Test: `main/services/slot-resolver.test.ts` (create)

**Interfaces:**
- Consumes: `SlotPositionMatch`, `SlotLink.positions` from Task A1.
- Produces: unchanged public signature `resolveSlots(slots: Slot[], members: TeamMemberDTO[], deviceStatuses: Map<string, DeviceStatus>): Slot[]`. Callers pass slots in board order; claiming honours that order.

- [ ] **Step 1: Write the failing test**

Create `main/services/slot-resolver.test.ts`:

```ts
// resolveSlots is pure, so everything here is data in / data out — no devices.
//
// The load-bearing rule is claiming: slots with an IDENTICAL positions set compete
// for distinct people; slots that differ resolve independently. Get that backwards
// and either a guitarist appears in three slots at once, or the acoustic player
// vanishes from the slot holding their pack.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { resolveSlots } from "./slot-resolver.js";
import type { Slot, SlotLink, TeamMemberDTO } from "../types/stage.js";
import type { DeviceStatus } from "../types/devices.js";

const NO_DEVICES = new Map<string, DeviceStatus>();

function member(personId: string, name: string, teamPositionName: string, notes: string | null = null): TeamMemberDTO {
  return { personId, name, teamPositionName, notes, photoUrl: null } as TeamMemberDTO;
}

function slot(id: string, link: SlotLink, order = 0): Slot {
  return {
    id, order, link,
    displayName: null, photoUrl: null,
    deviceBinding: null, iemBinding: null,
    deviceLabel: null, iemLabel: null,
    chargeSource: "mic", chargeBayId: null, hideRf: false,
  } as unknown as Slot;
}

const pos = (...positions: Array<{ name?: string; notesStartsWith?: string }>): SlotLink =>
  ({ kind: "pco", matchBy: "position", positions });

const names = (out: Slot[]) => out.map((s) => s.displayName);

describe("matching one slot", () => {
  const team = [
    member("p1", "Sarah", "Vocals", "1"),
    member("p2", "Dana", "Vocals", "10"),
    member("p3", "Ali", "Acoustic"),
  ];

  test("a single position with a note behaves exactly as before", () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "1" }))], team, NO_DEVICES)), ["Sarah"]);
  });

  test("an exact note wins so \"1\" does not grab \"10\"", () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "1" }))], team, NO_DEVICES)), ["Sarah"]);
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "10" }))], team, NO_DEVICES)), ["Dana"]);
  });

  test("a position with no note takes the first person in it", () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Acoustic" }))], team, NO_DEVICES)), ["Ali"]);
  });

  test("a noted position never falls back to an arbitrary person", () => {
    // The HH-slot-shows-the-HS-pastor bug. A note that matches nobody = empty.
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "9" }))], team, NO_DEVICES)), [null]);
  });

  test("sub-variant positions group under their base", () => {
    const bgv = [member("p9", "Chris", "Vocals (BGVs)", "3")];
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "3" }))], bgv, NO_DEVICES)), ["Chris"]);
  });

  test("entries are tried in order — first hit wins", () => {
    const link = pos({ name: "Vocals", notesStartsWith: "4" }, { name: "Acoustic" });
    // No vocalist noted 4, so it falls through to Acoustic.
    assert.deepEqual(names(resolveSlots([slot("s", link)], team, NO_DEVICES)), ["Ali"]);
  });

  test("a nameless entry matches on the note across every position", () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos({ notesStartsWith: "10" }))], team, NO_DEVICES)), ["Dana"]);
  });

  test("an entry with neither name nor note matches nobody", () => {
    // Guard against a misconfigured slot silently claiming the first person on the team.
    assert.deepEqual(names(resolveSlots([slot("s", pos({}))], team, NO_DEVICES)), [null]);
  });

  test("an empty range is an unconfigured slot", () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos())], team, NO_DEVICES)), [null]);
  });
});

describe("claiming between slots", () => {
  test("identical sets compete — two guitarists fill two of three slots", () => {
    const team = [member("g1", "Ali", "Acoustic"), member("g2", "Bo", "Electric")];
    const link = pos({ name: "Acoustic" }, { name: "Electric" });
    const out = resolveSlots([slot("a", link, 0), slot("b", link, 1), slot("c", link, 2)], team, NO_DEVICES);
    assert.deepEqual(names(out), ["Ali", "Bo", null]);
  });

  test("different sets do NOT compete — the pack slot still shows the player", () => {
    // The operator's case: slot 4 accepts Vocals-4 or Acoustic; a separate slot
    // holds that player's acoustic pack. Both must show them.
    const team = [member("g1", "Ali", "Acoustic")];
    const slot4 = pos({ name: "Vocals", notesStartsWith: "4" }, { name: "Acoustic" });
    const packSlot = pos({ name: "Acoustic" });
    const out = resolveSlots([slot("s4", slot4, 0), slot("pack", packSlot, 1)], team, NO_DEVICES);
    assert.deepEqual(names(out), ["Ali", "Ali"]);
  });

  test("competing slots claim in board order", () => {
    const team = [member("g1", "Ali", "Acoustic"), member("g2", "Bo", "Acoustic")];
    const link = pos({ name: "Acoustic" });
    const out = resolveSlots([slot("a", link, 0), slot("b", link, 1)], team, NO_DEVICES);
    assert.deepEqual(names(out), ["Ali", "Bo"]);
  });

  test("entry order does not change whether two slots compete", () => {
    // Identical means the same SET, so [Acoustic, Electric] == [Electric, Acoustic].
    const team = [member("g1", "Ali", "Acoustic")];
    const a = pos({ name: "Acoustic" }, { name: "Electric" });
    const b = pos({ name: "Electric" }, { name: "Acoustic" });
    assert.deepEqual(names(resolveSlots([slot("a", a, 0), slot("b", b, 1)], team, NO_DEVICES)), ["Ali", null]);
  });

  test("notes are part of the identity — same position, different notes never compete", () => {
    const team = [member("p1", "Sarah", "Vocals", "1"), member("p2", "Dana", "Vocals", "2")];
    const out = resolveSlots(
      [slot("a", pos({ name: "Vocals", notesStartsWith: "1" }), 0), slot("b", pos({ name: "Vocals", notesStartsWith: "2" }), 1)],
      team, NO_DEVICES,
    );
    assert.deepEqual(names(out), ["Sarah", "Dana"]);
  });

  test("a person-linked slot is unaffected by claiming", () => {
    const team = [member("p1", "Sarah", "Vocals", "1")];
    const out = resolveSlots(
      [slot("a", { kind: "pco", matchBy: "person", personId: "p1" }, 0), slot("b", pos({ name: "Vocals" }), 1)],
      team, NO_DEVICES,
    );
    assert.deepEqual(names(out), ["Sarah", "Sarah"]);
  });

  test("spacer and empty slots resolve to nothing and claim nobody", () => {
    const team = [member("p1", "Sarah", "Vocals")];
    const out = resolveSlots(
      [slot("sp", { kind: "spacer" }, 0), slot("e", { kind: "empty" }, 1), slot("v", pos({ name: "Vocals" }), 2)],
      team, NO_DEVICES,
    );
    assert.deepEqual(names(out), [null, null, "Sarah"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/slot-resolver.test.ts`
Expected: FAIL — `resolveSlots` still reads `link.teamPositionName`.

- [ ] **Step 3: Replace `matchMember` with per-entry matching**

In `main/services/slot-resolver.ts`, replace the whole `matchMember` function (lines 75-115) with:

```ts
/** Canonical identity of a positions range. Two slots compete for people only when
 *  these are equal — same (position, note) pairs, order-insensitive. Notes are part
 *  of the identity, so "Vocals note 1" and "Vocals note 2" never compete. */
function positionSignature(positions: SlotPositionMatch[]): string {
  return JSON.stringify(
    positions
      .map((p) => [normalizePosition(p.name), (p.notesStartsWith ?? "").trim().toLowerCase()] as const)
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))),
  );
}

/** First unclaimed person matching any entry, entries tried in configured order.
 *  `taken` holds people already claimed by slots with the SAME signature. */
function matchByPositions(
  positions: SlotPositionMatch[],
  members: TeamMemberDTO[],
  taken: Set<string>,
): TeamMemberDTO | null {
  for (const entry of positions) {
    const wantPos = entry.name && entry.name.trim() ? normalizePosition(entry.name) : null;
    const prefix = entry.notesStartsWith?.trim().toLowerCase() || null;

    // Neither constraint = a misconfigured entry. Skip it rather than claim the
    // first person on the team.
    if (wantPos === null && prefix === null) continue;

    const pool = (
      wantPos === null ? members : members.filter((m) => normalizePosition(m.teamPositionName) === wantPos)
    ).filter((m) => !taken.has(m.personId));

    if (prefix) {
      // A note pins this entry to a specific person. Require an actual match — do
      // NOT fall back to an arbitrary person in the position, or every unmatched
      // slot would duplicate the first member and appear to ignore the note.
      const matches = pool.filter((m) => m.notes != null && m.notes.trim().toLowerCase().startsWith(prefix));
      // Prefer an exact note match so "1" doesn't grab "10".
      const hit = matches.find((m) => m.notes!.trim().toLowerCase() === prefix) ?? matches[0];
      if (hit) return hit;
      continue;
    }

    if (pool[0]) return pool[0];
  }
  return null;
}
```

Add `SlotPositionMatch` to the type import at the top of the file:

```ts
import type { Slot, SlotDevice, SlotPositionMatch, TeamMemberDTO } from "../types/stage.js";
```

- [ ] **Step 4: Thread claiming through `resolveSlots`**

In `resolveSlots`, add the claim map above the `slots.map(...)` call and replace the PCO branch's `matchMember` call.

Directly before `return slots.map((slot): Slot => {`:

```ts
  // Claimed people, keyed by positions-signature. Slots with the same signature
  // compete for distinct people; slots with different signatures are independent.
  // Board order is the array order the caller passes.
  const claimed = new Map<string, Set<string>>();
```

Then replace `const member = matchMember(slot, members);` (line 147) with:

```ts
    const { link } = slot;
    let member: TeamMemberDTO | null = null;
    if (link.kind === "pco" && link.matchBy === "person") {
      member = members.find((m) => m.personId === link.personId) ?? null;
    } else if (link.kind === "pco" && link.matchBy === "position") {
      const sig = positionSignature(link.positions);
      let taken = claimed.get(sig);
      if (!taken) {
        taken = new Set<string>();
        claimed.set(sig, taken);
      }
      member = matchByPositions(link.positions, members, taken);
      if (member) taken.add(member.personId);
    }
```

- [ ] **Step 5: Run the tests — they should pass**

Run: `npx tsx --test main/services/slot-resolver.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 6: Prove the claiming tests aren't vacuous**

Delete the `if (member) taken.add(member.personId);` line and re-run.
Expected: "identical sets compete" and "competing slots claim in board order" FAIL.
Then restore it and instead make `positionSignature` return `""` for every input.
Expected: "different sets do NOT compete" FAILS (both slots would share one claim pool).
Restore both.

- [ ] **Step 7: Full suite**

Run: `npm test`
Expected: all pass. If any pre-existing test built a `teamPositionName` link, update it to `positions`.

- [ ] **Step 8: Commit**

```bash
git add main/services/slot-resolver.ts main/services/slot-resolver.test.ts
git commit -m "feat(slots): match a range of positions, claim within identical sets

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task A3: Slot editor — multi-select with per-entry notes

**Files:**
- Modify: `renderer/settings/sections/slots-section.tsx:85,94,290-379`
- Modify: `renderer/settings/settings-view.tsx:719`
- Modify: `renderer/settings/sections/inline-slots-editor.tsx:80`
- Modify: `renderer/components/slot-panel.tsx:199-206`

**Interfaces:**
- Consumes: `SlotPositionMatch`, `SlotLink.positions` (A1); `positionSignature` semantics (A2) for the competes-with hint.

- [ ] **Step 1: Fix the three default-link call sites**

In each of `settings-view.tsx:719`, `inline-slots-editor.tsx:80`, `slots-section.tsx:85` and `slots-section.tsx:94`, replace:

```ts
link: { kind: "pco", matchBy: "position", teamPositionName: "" },
```

with:

```ts
link: { kind: "pco", matchBy: "position", positions: [] },
```

- [ ] **Step 2: Fix the cell's position caption**

In `renderer/components/slot-panel.tsx`, replace lines 199-206 with:

```tsx
            {!isStatic && slot.link.kind === "pco" && slot.link.matchBy === "position" && slot.link.positions.length > 0 && (
              <span
                className="text-fg-muted block leading-tight truncate mt-0.5"
                style={{ fontSize: "clamp(0.72rem, 8.5cqi, 1.75rem)" }}
              >
                {slot.link.positions.map((p) => p.name ?? "Any").join(" / ")}
              </span>
            )}
```

- [ ] **Step 3: Replace the position picker with the multi-select**

In `renderer/settings/sections/slots-section.tsx`, replace the whole block from line 290 (`{(slot.link as ...).matchBy === "position" ? (`) through line 379 (the closing of the notes-starts-with block) with:

```tsx
            {(slot.link as { kind: "pco"; matchBy: string }).matchBy === "position" ? (
              <PositionRangeEditor
                positions={(slot.link as { kind: "pco"; matchBy: "position"; positions: SlotPositionMatch[] }).positions}
                teamPositions={teamPositions}
                onChange={(positions) =>
                  onChange({ ...slot, link: { kind: "pco", matchBy: "position", positions } })
                }
              />
            ) : (
              <Input
                value={(slot.link as { kind: "pco"; matchBy: "person"; personId: string }).personId}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  onChange({ ...slot, link: { kind: "pco", matchBy: "person", personId: e.target.value } })
                }
                placeholder="PCO Person ID"
                className="flex-1 min-w-0"
              />
            )}
            <InfoHint className="self-center">
              How this slot fills from Planning Center. By position: tick every position this slot may
              accept — the first one with someone available fills it. Give a position a note to pin it to
              one person (e.g. &quot;1&quot; for the vocalist noted 1). Tick &quot;Any position&quot; to match on the
              note alone. By person ID: locks to one individual.
            </InfoHint>
```

- [ ] **Step 4: Add the editor component**

Add near the other local components in `slots-section.tsx`:

```tsx
/** Tick the positions a slot accepts; each ticked one gets its own optional note.
 *  One control replaces the old position dropdown + slot-level note field — the
 *  note has to be per-position so "Vocals note 4, or Acoustic with any note" is
 *  expressible. "Any position" is a nameless entry: the note is the only filter. */
function PositionRangeEditor({
  positions,
  teamPositions,
  onChange,
}: {
  positions: SlotPositionMatch[];
  teamPositions: string[];
  onChange: (next: SlotPositionMatch[]) => void;
}) {
  const entryFor = (name: string | undefined) =>
    positions.find((p) => (p.name ?? "") === (name ?? ""));

  function toggle(name: string | undefined) {
    const existing = entryFor(name);
    if (existing) onChange(positions.filter((p) => p !== existing));
    else onChange([...positions, name === undefined ? {} : { name }]);
  }

  function setNote(name: string | undefined, note: string) {
    onChange(
      positions.map((p) =>
        (p.name ?? "") === (name ?? "")
          ? { ...p, notesStartsWith: note.trim() ? note : undefined }
          : p,
      ),
    );
  }

  const rows: Array<{ key: string; name: string | undefined; label: string }> = [
    { key: "__any__", name: undefined, label: "Any position" },
    ...teamPositions.map((p) => ({ key: p, name: p as string | undefined, label: p })),
  ];

  return (
    <div className="flex flex-1 min-w-0 flex-col gap-1 rounded-lg border border-gray-5 bg-gray-2 p-1.5 max-h-56 overflow-y-auto">
      {rows.map((row) => {
        const entry = entryFor(row.name);
        const ticked = entry !== undefined;
        return (
          <div key={row.key} className="flex items-center gap-2">
            <label className="flex flex-1 min-w-0 items-center gap-2 text-caption1">
              <input
                type="checkbox"
                checked={ticked}
                onChange={() => toggle(row.name)}
                className="size-4 shrink-0 accent-accent"
              />
              <span className="truncate">{row.label}</span>
            </label>
            {ticked && (
              <Input
                value={entry?.notesStartsWith ?? ""}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setNote(row.name, e.target.value)}
                placeholder="note"
                className="w-20 shrink-0"
              />
            )}
          </div>
        );
      })}
      {teamPositions.length === 0 && (
        <p className="px-1 py-2 text-caption2 text-fg-muted">
          No team positions loaded yet — connect Planning Center and pick a service type.
        </p>
      )}
    </div>
  );
}
```

Add `SlotPositionMatch` to the type imports at the top of `slots-section.tsx`.

- [ ] **Step 5: Type-check and lint**

Run: `npm run type-check && npm run lint`
Expected: clean. Any remaining `teamPositionName` reference is a compile error — fix it by reading `positions`.

- [ ] **Step 6: Verify in the browser**

Run the dev server on this branch (port 8788). Open Settings → Slots. Confirm: ticking two positions shows two note boxes; unticking removes the entry; the slot cell caption reads "Vocals / Acoustic".

- [ ] **Step 7: Commit**

```bash
git add renderer/
git commit -m "feat(slots): multi-select position editor with per-position notes

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task A4: Competes-with hint and docs

**Files:**
- Modify: `renderer/settings/sections/slots-section.tsx`
- Modify: `docs/` — the slots/mic-board page

- [ ] **Step 1: Surface the sharp edge in the editor**

The spec calls this out explicitly: adding one position silently changes whether a slot competes with its neighbours. In the slot list component that renders each `SlotRow`, compute signatures once and pass a hint down:

```tsx
// Slots with an identical positions set share people — the first one in board
// order claims, the next takes whoever is left. Surfaced here because it is
// otherwise invisible: ticking one more position silently changes the grouping.
const signatureOf = (s: Slot): string | null => {
  if (s.link.kind !== "pco" || s.link.matchBy !== "position" || s.link.positions.length === 0) return null;
  return JSON.stringify(
    s.link.positions
      .map((p) => [(p.name ?? "").trim().toLowerCase(), (p.notesStartsWith ?? "").trim().toLowerCase()] as const)
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))),
  );
};
const sigCounts = new Map<string, number>();
for (const s of slots) {
  const sig = signatureOf(s);
  if (sig) sigCounts.set(sig, (sigCounts.get(sig) ?? 0) + 1);
}
```

Pass `sharesWith={sig ? (sigCounts.get(sig) ?? 1) - 1 : 0}` into each row, and render inside the row when non-zero:

```tsx
{sharesWith > 0 && (
  <p className="text-caption2 text-fg-muted">
    Shares people with {sharesWith} other slot{sharesWith === 1 ? "" : "s"} configured the same way —
    each fills with a different person, in board order.
  </p>
)}
```

- [ ] **Step 2: Verify it appears**

In the browser, configure two slots with the same single position. Both should show the hint. Change one slot's note; the hint should disappear from both.

- [ ] **Step 3: Update the docs**

In the slots/mic-board doc under `docs/`, document: ticking multiple positions, per-position notes, "Any position", and the identical-set sharing rule. Keep it to a short section — concise and intentional.

- [ ] **Step 4: Commit and open the PR**

```bash
git add renderer/ docs/
git commit -m "feat(slots): flag slots that share people, document position ranges

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
gh pr create --base beta --title "feat(slots): match a range of PCO positions" --body "$(cat <<'EOF'
A slot can now accept several PCO positions, each with its own optional note, instead of exactly one position plus one note.

- `SlotLink.teamPositionName` + `notesStartsWith` become `positions: SlotPositionMatch[]`, migrated on load.
- Slots with an identical positions set compete for distinct people, in board order; slots that differ resolve independently, so a player with two devices still appears in both their slots.
- Fixes preset recall across service types as a side effect — presets were applying, but per-service-type position names meant every slot silently no-matched.

Spec: `docs/superpowers/specs/2026-07-28-slot-matching-labels-ross-history-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
EOF
)"
```

---

# Phase B — Labels on the cell

### Task B1: The strip-vs-pill decision, extracted and tested

**Files:**
- Create: `renderer/components/slot-strip-mode.ts`
- Create: `renderer/components/slot-strip-mode.test.ts`
- Modify: `renderer/components/slot-panel.tsx:209-223`

**Interfaces:**
- Produces: `slotStripMode(device: SlotDevice, hideRf?: boolean): "strip" | "pill" | "none"`.

Today `slot-panel.tsx:218` reads `slot.device.label === null && (...)`, so setting a label on a **live** device suppresses the whole status strip — losing RF bars and battery. That is the actual bug behind "show a label instead of the frequency".

- [ ] **Step 1: Write the failing test**

Create `renderer/components/slot-strip-mode.test.ts`:

```ts
// Which of the two pills a slot shows. Pulled out of slot-panel so the rule is
// testable without a DOM. The regression this guards: a label on a LIVE device
// used to suppress the whole strip, taking RF bars and battery with it.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { slotStripMode } from "./slot-strip-mode.js";
import type { SlotDevice } from "../../main/types/stage.js";

function device(over: Partial<SlotDevice> = {}): SlotDevice {
  return {
    status: "ok", rf: 4, battery: 80, freq: "574.000 MHz",
    audioLevel: null, charge: 80, iemCharge: null, label: null, iemLabel: null,
    ...over,
  };
}

describe("slotStripMode", () => {
  test("a live device shows the telemetry strip", () => {
    assert.equal(slotStripMode(device()), "strip");
  });

  test("a live device with a label STILL shows the strip", () => {
    // The regression. The label replaces the frequency inside the strip; it must
    // not replace the strip.
    assert.equal(slotStripMode(device({ label: "VOX 3" })), "strip");
  });

  test("a live device with both labels still shows the strip", () => {
    assert.equal(slotStripMode(device({ label: "VOX 3", iemLabel: "IEM 2" })), "strip");
  });

  test("an offline device with a label shows the offline pill", () => {
    assert.equal(slotStripMode(device({ status: "error", rf: null, battery: null, charge: null, label: "VOX 3" })), "pill");
  });

  test("an offline device with only an IEM label shows the pill", () => {
    assert.equal(slotStripMode(device({ status: "error", rf: null, battery: null, charge: null, iemLabel: "IEM 2" })), "pill");
  });

  test("a warn-state device is still live", () => {
    assert.equal(slotStripMode(device({ status: "warn", battery: 15, charge: 15 })), "strip");
  });

  test("no device and no labels shows nothing", () => {
    assert.equal(slotStripMode(device({ status: "none", rf: null, battery: null, freq: null, charge: null })), "none");
  });

  test("hideRf still shows the strip when there is a charge level", () => {
    assert.equal(slotStripMode(device(), true), "strip");
  });

  test("hideRf with nothing else to show renders nothing", () => {
    assert.equal(slotStripMode(device({ status: "none", rf: null, battery: null, freq: null, charge: null }), true), "none");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test renderer/components/slot-strip-mode.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

Create `renderer/components/slot-strip-mode.ts`:

```ts
/** Which pill a slot cell shows.
 *
 *  "strip" — live telemetry (RF bars, charge, battery). A manual label rides
 *            INSIDE this, in place of the frequency; it never suppresses it.
 *  "pill"  — a manually-assigned (offline) device: labels only, no telemetry.
 *  "none"  — nothing bound and nothing labelled. */
export function slotStripMode(
  device: { status: string; charge: number | null; iemCharge: number | null; label: string | null; iemLabel: string | null },
  hideRf?: boolean,
): "strip" | "pill" | "none" {
  const live = device.status === "ok" || device.status === "warn";
  if (live) {
    const hasTelemetry = !hideRf || device.charge !== null || device.iemCharge !== null;
    return hasTelemetry ? "strip" : "none";
  }
  if (device.label !== null || device.iemLabel !== null) return "pill";
  return "none";
}
```

- [ ] **Step 4: Run it — should pass**

Run: `npx tsx --test renderer/components/slot-strip-mode.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Prove it isn't vacuous**

Change `const live = ...` to `const live = false`. Re-run.
Expected: the three "live" tests FAIL. Revert.

- [ ] **Step 6: Use it in slot-panel**

Replace `renderer/components/slot-panel.tsx` lines 209-223 with:

```tsx
          {/* One of two pills. A live device shows the telemetry strip (with any
              manual label standing in for the frequency); an offline, manually
              assigned device shows the label-only pill in the same spot. */}
          {(() => {
            const mode = slotStripMode(slot.device, slot.hideRf);
            if (mode === "pill") return <OfflinePill micLabel={slot.device.label} iemLabel={slot.device.iemLabel} />;
            if (mode === "strip") return <StatusStrip device={slot.device} hideRf={slot.hideRf} />;
            return null;
          })()}
```

Add the import: `import { slotStripMode } from "./slot-strip-mode";`

- [ ] **Step 7: Commit**

```bash
git add renderer/components/slot-strip-mode.ts renderer/components/slot-strip-mode.test.ts renderer/components/slot-panel.tsx
git commit -m "fix(slots): a label no longer suppresses live RF and battery

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task B2: Label in place of the frequency, IEM on a second line

**Files:**
- Modify: `renderer/components/status-strip.tsx:154-168`

- [ ] **Step 1: Replace the frequency segment**

Replace lines 154-168 of `status-strip.tsx` with:

```tsx
      {/* ── Label / frequency segment — only with the RF bars (it's RF info).
          A manual label takes the frequency's place; the label's presence IS the
          toggle, so an empty label leaves the frequency showing. An IEM label sits
          on a second line, present only when set. ── */}
      {showFreq && (
        <>
          <Divider />
          <div className="flex flex-col justify-center flex-1 min-w-0" style={{ gap: "calc(var(--rf) * 0.12)" }}>
            {device.label ? (
              <span className={cn("font-bold truncate leading-none", statusColor)} style={valueTextStyle}>
                {device.label}
              </span>
            ) : device.freq !== null ? (
              <span className={cn("font-mono font-bold tabular-nums truncate leading-none", statusColor)} style={valueTextStyle}>
                {device.freq}
              </span>
            ) : (
              <span className="font-bold text-fg-faint leading-none" style={valueTextStyle}>—</span>
            )}
            {device.iemLabel && (
              <span
                className="text-fg-muted truncate leading-none"
                style={{ fontSize: "calc(var(--rf) * 0.78)" }}
              >
                {device.iemLabel}
              </span>
            )}
          </div>
        </>
      )}
```

- [ ] **Step 2: Verify in the browser**

On the dev server, set a slot's `deviceLabel` to `VOX 3` and `iemLabel` to `IEM 2` while its device is online. Confirm: RF bars still render, `VOX 3` sits where the frequency was, `IEM 2` on a second line, battery unchanged. Clear the label; the frequency returns.

- [ ] **Step 3: Check the narrow case**

Shrink the slot column in the layout editor to its minimum width. Confirm the label truncates rather than wrapping or pushing the battery out.

- [ ] **Step 4: Commit**

```bash
git add renderer/components/status-strip.tsx
git commit -m "feat(slots): show a custom label in place of the frequency

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task B3: "Use receiver name" action

**Files:**
- Modify: `renderer/settings/sections/slots-section.tsx`
- Modify: `docs/` — the slots/mic-board page

The receiver's channel name is already parsed into `DeviceStatus.name` by every Shure provider (`shure-ulxd.ts:66`, `shure-axient.ts`, `shure-psm.ts`) via the `GET 0 ALL` init. It must never display automatically — receivers in production already have names programmed, so an automatic override would strip frequencies from every cell on upgrade.

- [ ] **Step 1: Confirm the renderer can see the name**

Run: `grep -rn "name" main/types/devices.ts` and check the channel list the slot editor already renders for its device-binding dropdown. If `DeviceStatus.name` is not already in that payload, add it to whatever DTO the editor consumes — do not add a new IPC call.

- [ ] **Step 2: Add the action beside the label input**

Next to the existing device-label `Input` in the slot editor, add:

```tsx
{boundChannelName && (
  <Button
    variant="ghost"
    size="small"
    onClick={() => onChange({ ...slot, deviceLabel: boundChannelName })}
    tooltip={`Fill the label with the receiver's own channel name (${boundChannelName})`}
  >
    Use receiver name
  </Button>
)}
```

where `boundChannelName` is the bound channel's `name`, or `null` when nothing is bound or the receiver reports no name.

- [ ] **Step 3: Verify**

With a named receiver bound, the button appears and fills the label; the cell then shows that name in place of the frequency. With no bound device, the button is absent.

- [ ] **Step 4: Document and open the PR**

Add a short note to the slots doc: labels replace the frequency on the cell, the IEM label renders beneath, and the receiver's own name can be pulled in with one click but is never applied automatically.

```bash
git add renderer/ docs/
git commit -m "feat(slots): pull the receiver's channel name into the label

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
gh pr create --base beta --title "feat(slots): custom and RX-name labels on the cell" --body "$(cat <<'EOF'
A manual label now takes the frequency's place on a live slot cell, with the IEM label on a second line.

- Fixes a real bug: setting a label on a live device used to suppress the entire status strip, taking RF bars and battery with it.
- The label's presence is the toggle — no checkbox. Empty label keeps the frequency.
- The receiver's channel name (already parsed from `CHAN_NAME`) is offered as a one-click fill, never applied automatically, so upgrading never silently strips frequencies off a board.

Spec: `docs/superpowers/specs/2026-07-28-slot-matching-labels-ross-history-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
EOF
)"
```

---

# Phase C — One Ross card

### Task C1: Pair the two Ross integrations into one card

**Files:**
- Modify: `renderer/components/integrations-panel.tsx:1038-1075`
- Modify: `docs/integrations/` — the Ross pages

Both ids stay. `rosstalk` and `ross-tsl` keep their own descriptor, enable flag, config blob and connection state; only the presentation is paired. Collapsing to one id would mean migrating `integrationEnabled`/`integrationConfigs` and rewriting every layout button and automation action that references them.

- [ ] **Step 1: Add the pairing**

Above the `groups` construction (line 1038), add:

```tsx
// Two integrations, one card. RossTalk (commands, TCP 7788) and Ross MultiViewer
// (TSL UMD) are different protocols that usually address the same Carbonite, so
// they read as one thing to an operator. Ids, enable flags and connection state
// stay separate underneath — see the spec for why merging them is not worth it.
const ROSS_PAIR = ["rosstalk", "ross-tsl"] as const;
```

- [ ] **Step 2: Render the pair as one row**

In the `groups.map(...)` body, before mapping items, pull the Ross pair out and render it through a new `IntegrationPairRow`. Add the component beside `IntegrationRow`:

```tsx
/** One card holding two related integrations as labelled sections. Each section
 *  keeps its own enable toggle and status — this is a presentation grouping, not
 *  a merged integration. */
function IntegrationPairRow({
  title,
  entries,
  onStateChange,
  bodyFor,
}: {
  title: string;
  entries: Array<{ descriptor: IntegrationDescriptor; state: IntegrationState }>;
  onStateChange: (id: string, next: IntegrationState) => void;
  bodyFor: (d: IntegrationDescriptor, s: IntegrationState) => ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-gray-5 bg-gray-2 p-3">
      <span className="text-caption1 font-semibold">{title}</span>
      {entries.map(({ descriptor, state }) => (
        <div key={descriptor.id} className="flex flex-col gap-2 rounded-lg border border-gray-5 p-2.5">
          <IntegrationRow
            descriptor={descriptor}
            state={state}
            onStateChange={onStateChange}
            body={bodyFor(descriptor, state)}
          />
        </div>
      ))}
    </div>
  );
}
```

In the group render, replace the flat `g.items.map(...)` with a version that renders the pair once, in the position of whichever Ross id comes first, and skips the second:

```tsx
{g.items.map((descriptor) => {
  const state = stateMap.get(descriptor.id);
  if (!state) return null;
  if (descriptor.id === ROSS_PAIR[1]) return null; // rendered inside the pair card
  if (descriptor.id === ROSS_PAIR[0]) {
    const entries = ROSS_PAIR
      .map((id) => ({ descriptor: byId.get(id), state: stateMap.get(id) }))
      .filter((e): e is { descriptor: IntegrationDescriptor; state: IntegrationState } => !!e.descriptor && !!e.state);
    return <IntegrationPairRow key="ross" title="Ross" entries={entries} onStateChange={handleStateChange} bodyFor={bodyFor} />;
  }
  return (
    <IntegrationRow
      key={descriptor.id}
      descriptor={descriptor}
      state={state}
      onStateChange={handleStateChange}
      body={bodyFor(descriptor, state)}
    />
  );
})}
```

- [ ] **Step 3: Handle the dormant case**

If only one of the two is in use, the other is filtered into `dormant` and `byId.get(id)` still resolves but `stateMap` may not — the `.filter` above already drops it, so the card renders with one section. Verify by disabling `ross-tsl` and confirming the Ross card still shows RossTalk alone, and that the dormant list does not also list it.

- [ ] **Step 4: Verify in the browser**

Settings → Integrations. Confirm one "Ross" card with two labelled sections, each with a working enable toggle and its own status badge; the MultiViewer feeds panel still renders inside its section; no duplicate Ross entries elsewhere on the page.

- [ ] **Step 5: Type-check and lint**

Run: `npm run type-check && npm run lint`
Expected: clean. Import `ReactNode` from `react` if it is not already imported.

- [ ] **Step 6: Document, commit and open the PR**

Note in `docs/integrations/` that RossTalk and Ross MultiViewer share one card but remain independently configured and enabled.

```bash
git add renderer/components/integrations-panel.tsx docs/
git commit -m "feat(integrations): group RossTalk and Ross MultiViewer in one card

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
gh pr create --base beta --title "feat(integrations): one Ross card" --body "$(cat <<'EOF'
RossTalk and Ross MultiViewer (TSL UMD) now present as a single "Ross" card with two labelled sections.

Presentation only — both keep their own descriptor id, enable flag, config and connection state, so layout buttons and automation actions that reference `rosstalk` are untouched.

Spec: `docs/superpowers/specs/2026-07-28-slot-matching-labels-ross-history-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
EOF
)"
```

---

# Phase D — Live Overview

### Task D1: Include the running service in the trend, keep the average finished-only

**Files:**
- Modify: `renderer/settings/sections/service-history-section.tsx:441-512`
- Create: `renderer/settings/sections/overview-scope.test.ts`

**Root cause (already diagnosed, do not re-investigate):** `service-history-section.tsx:448` reads
`ended != null && ...`, which drops the currently-recording service before the Overview trend or
stats ever see it. Line 334 documents the intent: *"(The Overview stays finished-only.)"* Everything
upstream already works — the recorder broadcasts every 5s, SSE delivers, and line 312 folds the live
record into `attList`.

**Decision (confirmed):** the trend chart gets the running service as a distinct live point; the
average is computed over finished services only, with today's number shown beside it rather than
folded in. Folding a still-climbing peak into a cross-service average makes the headline stat read
as broken for the first half of the morning.

- [ ] **Step 1: Write the failing test**

Create `renderer/settings/sections/overview-scope.test.ts`:

```ts
// The Overview's two scopes. These diverged deliberately: the trend chart shows the
// service that is recording right now, but the cross-service average does not fold
// in a peak that is still climbing — that would make the headline number read as
// broken at 9am and "recover" by noon.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { inTrendScope, inAverageScope } from "./overview-scope.js";

const rec = (over: { endedAt?: string | null; serviceTypeId?: string | null; serviceDate?: string } = {}) => ({
  endedAt: over.endedAt === undefined ? "2026-07-26T11:00:00Z" : over.endedAt,
  serviceTypeId: over.serviceTypeId === undefined ? "st1" : over.serviceTypeId,
  serviceDate: over.serviceDate ?? "2026-07-26",
});

describe("trend scope", () => {
  test("includes a finished service", () => {
    assert.equal(inTrendScope(rec(), null, null), true);
  });

  test("includes the service recording right now", () => {
    // The whole point of the change.
    assert.equal(inTrendScope(rec({ endedAt: null }), null, null), true);
  });

  test("still honours the service-type filter", () => {
    assert.equal(inTrendScope(rec({ serviceTypeId: "st2" }), "st1", null), false);
    assert.equal(inTrendScope(rec({ serviceTypeId: "st1" }), "st1", null), true);
  });

  test("still honours the as-of cutoff", () => {
    assert.equal(inTrendScope(rec({ serviceDate: "2026-08-02" }), null, "2026-07-26"), false);
    assert.equal(inTrendScope(rec({ serviceDate: "2026-07-19" }), null, "2026-07-26"), true);
  });

  test("a running service outside the type filter is still excluded", () => {
    assert.equal(inTrendScope(rec({ endedAt: null, serviceTypeId: "st2" }), "st1", null), false);
  });
});

describe("average scope", () => {
  test("includes a finished service", () => {
    assert.equal(inAverageScope(rec(), null, null), true);
  });

  test("EXCLUDES the service recording right now", () => {
    assert.equal(inAverageScope(rec({ endedAt: null }), null, null), false);
  });

  test("applies the same type and date filters as the trend", () => {
    assert.equal(inAverageScope(rec({ serviceTypeId: "st2" }), "st1", null), false);
    assert.equal(inAverageScope(rec({ serviceDate: "2026-08-02" }), null, "2026-07-26"), false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test renderer/settings/sections/overview-scope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Extract the two predicates**

Create `renderer/settings/sections/overview-scope.ts`:

```ts
/** The Overview's scope filters, split because the trend and the average want
 *  different answers about the service that is recording right now.
 *
 *  The trend SHOWS it — that is the point: the dot climbs through the morning.
 *  The average EXCLUDES it — a peak that is still climbing would drag a
 *  cross-service mean down and read as a broken number until about noon. */
type Scoped = { endedAt: string | null; serviceTypeId: string | null; serviceDate: string };

function matchesFilters(r: Scoped, activeType: string | null, asOf: string | null): boolean {
  return (!activeType || r.serviceTypeId === activeType) && (!asOf || r.serviceDate <= asOf);
}

export function inTrendScope(r: Scoped, activeType: string | null, asOf: string | null): boolean {
  return matchesFilters(r, activeType, asOf);
}

export function inAverageScope(r: Scoped, activeType: string | null, asOf: string | null): boolean {
  return r.endedAt != null && matchesFilters(r, activeType, asOf);
}
```

- [ ] **Step 4: Run the test — should pass**

Run: `npx tsx --test renderer/settings/sections/overview-scope.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove it isn't vacuous**

Add `r.endedAt != null &&` to `inTrendScope`. Re-run.
Expected: "includes the service recording right now" FAILS. Revert.

- [ ] **Step 6: Use them in the Overview memo**

In `service-history-section.tsx`, replace the `inScope` definition at line 448-451 with:

```ts
    const tl = (list ?? []).filter((t) => inTrendScope(t, activeType, asOf));
    const att = attList.filter((a) => inTrendScope(a, activeType, asOf));
    // The cross-service average excludes the service still recording — see overview-scope.ts.
    const attFinished = attList.filter((a) => inAverageScope(a, activeType, asOf));
```

Add the import. Then find every consumer of `att` that feeds an **average** (the `mean(...)` calls and
`occ` where it drives the avg stat rather than the chart) and switch those to `attFinished`. The
weekend-grouping that builds the chart points keeps using `att`.

- [ ] **Step 7: Mark the live point distinctly**

Where the chart points are built from the weekend grouping, tag any point whose services include one
with `endedAt == null`:

```ts
const live = group.some((a) => a.endedAt == null);
```

Render a live point with a hollow/outlined marker and append " (recording)" to its tooltip, so a
climbing partial is never mistaken for a settled weekend total.

- [ ] **Step 8: Update the stale comment**

Line 334 currently reads *"(The Overview stays finished-only.)"* — no longer true. Replace with:
*"(The Overview trend includes the recording service; its average does not.)"*

- [ ] **Step 9: Verify without a live service**

The predicates are pure and covered by tests. For an end-to-end check without waiting for Sunday,
temporarily clear `endedAt` on one record via the history-edit path on a dev copy of the data
directory — never against production data — and confirm the point appears on the trend, marked live,
while the average is unchanged. Restore the record afterwards.

- [ ] **Step 10: Full suite, then commit and open the PR**

Run: `npm test && npm run lint && npm run type-check`

```bash
git add renderer/settings/sections/ docs/
git commit -m "fix(history): Overview trend includes the recording service

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
gh pr create --base beta --title "fix(history): live Overview during a service" --body "$(cat <<'EOF'
The History Overview trend now includes the service that is recording, instead of only appearing once the service ends.

Root cause was a single guard — `ended != null` in the Overview scope filter — not missing plumbing. The recorder already broadcasts the open record every 5s, and the day list already showed it as "recording…".

The trend chart shows the running service as a distinct live point; the cross-service average stays over finished services, so a still-climbing peak does not drag the headline number down mid-morning.

Spec: `docs/superpowers/specs/2026-07-28-slot-matching-labels-ross-history-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
EOF
)"
```

---

## Self-review notes

**Spec coverage.** A: type A1, resolver A2, editor A3, sharp-edge hint A4 — all covered, including the "empty positions = unconfigured" and "entry with neither name nor note never matches" rules. B: strip suppression B1, label-for-frequency and IEM line B2, RX-name action B3. C: C1. D: D1, with the confirmed average decision.

**Deviation from the spec, deliberate.** The spec's B section says only the render path is missing. That understated it — `slot-panel.tsx:218` actively suppresses the strip when a label is set, so B1 is a bug fix, not just rendering. The plan reflects the code, not the spec.

**Not covered by tests.** The editor components (A3, A4, B3, C1) are verified in the browser rather than unit-tested; the repo has no React testing harness and adding one is out of scope. The pure logic behind each — matching, claiming, strip mode, scope — is unit-tested.
