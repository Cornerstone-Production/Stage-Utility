# PCO Live Auto-Advance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An automation rule that advances PCO Services Live to a chosen plan item when that item is due.

**Architecture:** One new trigger (`pco.item-due`) and one new action (`pco.live.advance`) added to the existing automation registries, plus a `plan-items` options source so the item can be picked from a dropdown. Conditions are reused unchanged.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node built-in test runner via `tsx --test`.

## Global Constraints

- Node >= 24, TypeScript strict, ESM with `.js` import specifiers even for `.ts` sources.
- No new runtime dependencies; `node:` builtins only.
- Never use emojis in code, UI, comments, or commit messages.
- PCO offers **no jump action**. `go_to_next_item` and `go_to_previous_item` are the only actions that move the plan. Never build a stepping loop.
- Never call `toggle_control`. These actions are permission-gated, not possession-gated, and taking control would seize it from whoever is driving.
- Match items by **title**, never by item id. Ids are new objects every plan.
- Every outcome writes to the Activity log, including skips. Silence is this feature's worst failure mode.
- Run `npm run type-check && npm run lint && npm test` before every commit. One pre-existing lint warning in `renderer/settings/sections/patch-import.tsx` is not yours.
- Conventional Commits. No AI attribution, no session links.
- Branch `feat/pco-auto-advance`, off `beta`.

---

### Task 1: Item title matching

**Files:**
- Create: `main/services/automation-pco-items.ts`
- Test: `main/services/automation-pco-items.test.ts`

**Interfaces:**
- Produces: `type PlanItem = { id: string; title: string }` and
  `function findItemByTitle(items: PlanItem[], title: string): PlanItem | null`

Pulled out on its own because both the trigger and the action match titles, and they
must agree exactly — a trigger that fires on an item the action then fails to
recognise is the worst possible split.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findItemByTitle } from "./automation-pco-items.js";

const items = [
  { id: "1", title: "Pre-Service" },
  { id: "2", title: "Doors Open" },
  { id: "3", title: "Welcome" },
];

describe("findItemByTitle", () => {
  it("matches a case-insensitive substring", () => {
    assert.equal(findItemByTitle(items, "doors")?.id, "2");
    assert.equal(findItemByTitle(items, "DOORS")?.id, "2");
  });

  it("returns the FIRST match when several could match", () => {
    const dupes = [{ id: "a", title: "Doors" }, { id: "b", title: "Doors Close" }];
    assert.equal(findItemByTitle(dupes, "doors")?.id, "a");
  });

  it("returns null when nothing matches, so the caller can log why", () => {
    assert.equal(findItemByTitle(items, "offering"), null);
  });

  it("returns null for an empty or whitespace title rather than matching everything", () => {
    assert.equal(findItemByTitle(items, ""), null);
    assert.equal(findItemByTitle(items, "   "), null);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/automation-pco-items.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
// automation-pco-items.ts — finding a plan item by what it is called.
//
// Title, not id. A plan's items are new objects every week, so an id chosen from
// a dropdown on Tuesday is dead by Sunday. The dropdown exists for convenience
// and stores the title, which is the same choice pco.item-reached already makes.

export type PlanItem = { id: string; title: string };

/** First item whose title contains `title`, case-insensitively. */
export function findItemByTitle(items: PlanItem[], title: string): PlanItem | null {
  const want = title.trim().toLowerCase();
  // An empty needle would otherwise match the first item and fire the wrong cue.
  if (!want) return null;
  return items.find((i) => i.title.toLowerCase().includes(want)) ?? null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test main/services/automation-pco-items.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add main/services/automation-pco-items.ts main/services/automation-pco-items.test.ts
git commit -m "feat(automation): match plan items by title"
```

---

### Task 2: Due-time computation

**Files:**
- Create: `main/services/automation-due-time.ts`
- Test: `main/services/automation-due-time.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type DueAnchor = "item" | "service-start"` and
  `function dueAt(o: { anchor: DueAnchor; itemTimeIso: string | null; serviceStartIso: string | null; offsetMinutes: number }): number | null`
  returning epoch ms, or null when the anchor's time is unknown.

Pure and dependency-free so both anchors are testable without a clock or a network.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dueAt } from "./automation-due-time.js";

const ITEM = "2026-08-09T14:30:00Z";
const START = "2026-08-09T14:00:00Z";

describe("dueAt", () => {
  it("uses the item's own time when anchored to the item", () => {
    const t = dueAt({ anchor: "item", itemTimeIso: ITEM, serviceStartIso: START, offsetMinutes: 0 });
    assert.equal(t, Date.parse(ITEM));
  });

  it("uses the service start when anchored to it", () => {
    const t = dueAt({ anchor: "service-start", itemTimeIso: ITEM, serviceStartIso: START, offsetMinutes: 0 });
    assert.equal(t, Date.parse(START));
  });

  it("applies a negative offset to fire early", () => {
    const t = dueAt({ anchor: "item", itemTimeIso: ITEM, serviceStartIso: null, offsetMinutes: -5 });
    assert.equal(t, Date.parse(ITEM) - 5 * 60_000);
  });

  it("returns null when the chosen anchor has no time, rather than guessing", () => {
    assert.equal(dueAt({ anchor: "item", itemTimeIso: null, serviceStartIso: START, offsetMinutes: 0 }), null);
    assert.equal(dueAt({ anchor: "service-start", itemTimeIso: ITEM, serviceStartIso: null, offsetMinutes: 0 }), null);
  });

  it("returns null for an unparseable timestamp", () => {
    assert.equal(dueAt({ anchor: "item", itemTimeIso: "not a date", serviceStartIso: null, offsetMinutes: 0 }), null);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/automation-due-time.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
// automation-due-time.ts — when a rule's chosen moment arrives.
//
// Two anchors because two things are worth keying off: the item's own scheduled
// time (which PCO publishes as current_item_time / next_item_time) and the
// service start. Item times come from PCO rather than being derived from
// durations here, so "when is Doors due" matches what everyone sees in Planning
// Center instead of drifting from it.

export type DueAnchor = "item" | "service-start";

export function dueAt(o: {
  anchor: DueAnchor;
  itemTimeIso: string | null;
  serviceStartIso: string | null;
  offsetMinutes: number;
}): number | null {
  const iso = o.anchor === "item" ? o.itemTimeIso : o.serviceStartIso;
  if (!iso) return null;
  const base = Date.parse(iso);
  // Null rather than NaN: the caller must be able to say "unknown" in the log,
  // and NaN would silently compare false against every clock check.
  if (Number.isNaN(base)) return null;
  return base + o.offsetMinutes * 60_000;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test main/services/automation-due-time.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add main/services/automation-due-time.ts main/services/automation-due-time.test.ts
git commit -m "feat(automation): compute when a rule's item is due"
```

---

### Task 3: The `pco.item-due` trigger

**Files:**
- Modify: `main/services/automation-triggers.ts`
- Test: `main/services/automation-triggers.test.ts` (extend)

**Interfaces:**
- Consumes: `findItemByTitle` (Task 1), `dueAt` (Task 2).
- Produces: a `pco.item-due` trigger registered alongside `pco.item-reached`, with params `title` (string), `offsetMinutes` (number), `anchor` (enum `item` | `service-start`).

Read the existing `pco.item-reached` definition first and follow its shape exactly — the `def()` helper, the `channel`, and the `didFire(prev, next, params)` signature.

Fires once per plan per rule: a rule that has fired for plan P must not fire again for P, so a restart mid-service cannot re-fire it.

- [ ] **Step 1: Write the failing test**

Add to the existing describe block, matching the file's established fixture style:

```ts
describe("pco.item-due", () => {
  it("does not fire before the due time", () => {
    // prev/next carry the live payload; assert didFire is false while now < due.
  });

  it("fires once when the due time passes", () => {
    // assert true on the transition, then false on a subsequent evaluation for
    // the SAME plan - re-firing would advance the plan twice.
  });

  it("does not fire when no item matches the title", () => {
    // and the reason must be reportable, not silent.
  });

  it("fires again for a different plan", () => {
    // the once-guard is per plan, not forever.
  });
});
```

Fill each body against the payload shape the neighbouring `pco.item-reached` tests use — do not invent a different fixture.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/automation-triggers.test.ts`
Expected: FAIL — `pco.item-due` is not a registered trigger.

- [ ] **Step 3: Implement the trigger**

Register `pco.item-due` on the `pco:live` channel. Resolve the item with
`findItemByTitle`, the moment with `dueAt`, and compare against the wall clock.
Track fired-for-plan state so it fires at most once per plan per rule.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test main/services/automation-triggers.test.ts`
Expected: PASS, including the four new cases.

- [ ] **Step 5: Commit**

```bash
git add main/services/automation-triggers.ts main/services/automation-triggers.test.ts
git commit -m "feat(automation): add a trigger for when a plan item is due"
```

---

### Task 4: The `pco.live.advance` action

**Files:**
- Modify: `main/services/automation-actions.ts`
- Modify: `main/services/pco-service.ts` (expose the next item's title)
- Test: `main/services/automation-actions.test.ts`

**Interfaces:**
- Consumes: `findItemByTitle` (Task 1).
- Produces: a `pco.live.advance` action with optional `guardTitle`.

**One step. Never a loop.** PCO has no jump, so stepping is all there is — but a
loop would fire every item in between. With `guardTitle` set and the next item not
matching, log why and do nothing.

**Never call `toggle_control`.** These actions are permission-gated, not
possession-gated; taking control would seize it from whoever is driving.

- [ ] **Step 1: Write the failing test**

```ts
describe("pco.live.advance", () => {
  it("advances when the next item matches the guard", async () => {
    // fake PCO reporting next item "Doors Open"; assert go_to_next_item was posted
  });

  it("does NOT advance when the next item does not match", async () => {
    // assert NO request was issued, and the skip reason was logged
  });

  it("advances unguarded when no guardTitle is given", async () => {
    // the guard is optional; without it the action is a plain single step
  });

  it("reports PCO's own wording when it refuses with 403", async () => {
    // the message must reach the log verbatim - a silent rule is the worst failure
  });

  it("never posts more than once per invocation", async () => {
    // the no-loop guarantee, asserted rather than assumed
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/automation-actions.test.ts`
Expected: FAIL — `pco.live.advance` is not a registered action.

- [ ] **Step 3: Implement**

Follow the shape of the existing `rosstalk.command` action. Read the next item's
title from the live payload, apply the guard, and call the existing `goLive("next")`
path — reusing it rather than issuing a new request, so there is one place that
talks to PCO Live.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test main/services/automation-actions.test.ts`
Expected: PASS, five new cases.

- [ ] **Step 5: Commit**

```bash
git add main/services/automation-actions.ts main/services/pco-service.ts main/services/automation-actions.test.ts
git commit -m "feat(automation): add a guarded PCO Live advance action"
```

---

### Task 5: The item dropdown

**Files:**
- Modify: `main/services/routes/automation-routes.ts` (or wherever `optionsFrom` resolves)
- Modify: `main/services/automation-triggers.ts` (mark `title` as `optionsFrom: "plan-items"`)

**Interfaces:**
- Produces: a `plan-items` options source returning `{ value, label }` for the current plan's items, where **value is the title**.

The existing sources are `service-types`, `rosstalk-targets`, `rosstalk-commands`
and `osc-targets` — follow whichever pattern resolves those, and add `plan-items`
beside them.

**The value must be the title, not the id.** The dropdown is a convenience for
picking; what gets stored has to survive next week's plan.

- [ ] **Step 1: Find how an existing source resolves**

Run: `grep -rn '"service-types"' main/services/`
Read that resolver before writing a new one.

- [ ] **Step 2: Add the `plan-items` source**

Return the current plan's items as `{ value: item.title, label: item.title }`.
When no plan is selected, return an empty list rather than erroring — the rule
editor must still open.

- [ ] **Step 3: Point the trigger's `title` param at it**

Add `optionsFrom: "plan-items"` to the `title` param. It stays a string param, so
a title can still be typed for an item that is not in the current plan.

- [ ] **Step 4: Verify in the UI**

Run the server, open Automation, add a rule, choose "Plan item is due", and confirm
the item dropdown lists the current plan's items and that a typed value is accepted.

- [ ] **Step 5: Commit**

```bash
git add main/services/routes/automation-routes.ts main/services/automation-triggers.ts
git commit -m "feat(automation): pick the plan item from a dropdown"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/integrations/planning-center.md`
- Modify: `docs/` automation documentation (locate with `grep -rln automation docs/`)

- [ ] **Step 1: Document the rule**

Cover: what it does, that it advances one step and never jumps because PCO has no
jump action, that it matches by title so renaming an item breaks it silently, that
it needs the connected account to be permitted to control Live for that service
type, and that it should be run in simulate mode for a weekend before being armed.

- [ ] **Step 2: Commit**

```bash
git add docs/
git commit -m "docs(automation): document the PCO Live auto-advance rule"
```

---

## Self-review

**Spec coverage.** No-jump constraint → Tasks 4's one-step guarantee. No
toggle_control → Task 4 and the Global Constraints. Title not id → Tasks 1 and 5.
Both anchors → Task 2. Fire-once-per-plan → Task 3. Guarded action → Task 4.
Dropdown → Task 5. Conditions → nothing to build, already exist. Logging every
outcome → Tasks 3 and 4. Docs → Task 6.

**Deliberately not built:** an "advance until reached" mode. It would fire every
item stepped over, and per-item rules make it unnecessary.

**Not automatable:** live firing against PCO. Verified in simulate mode over a real
weekend before arming, per the spec.

**Type consistency.** `PlanItem`, `findItemByTitle`, `DueAnchor` and `dueAt` are
defined in Tasks 1-2 and used unchanged in Tasks 3-5.
