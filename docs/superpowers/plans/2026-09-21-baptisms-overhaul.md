# Baptisms Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Baptisms tab match the History design language, give it an append-only raw layer it can be rebuilt from, expose the running timer to Companion and to custom layouts, and fix two defects that corrupt or misreport a live session.

**Architecture:** The baptism timer service keeps its shape and gains an `armed` state plus raw-layer writes. A fourth append-only CSV source joins `spl`/`attendance`/`events` in the existing archive, with a pure replay function mirroring `rebuildTimelineRecord`. The tab is rebuilt as a configuration of the shipped `history-chart` module (`HistoryChart`, `StatStrip`, `CustomizePopover`, `prefs`) rather than new charting code. Advance/back become entries in `AUTOMATION_ACTIONS`, which is the single route both custom-layout buttons and Companion drive through.

**Tech Stack:** TypeScript, Node's built-in test runner (`node:test` + `node:assert/strict`), React 19, Vite, Tailwind with the app's `--color-*` semantic tokens, SSE over `GET /api/events`, Companion module SDK v2.

**Spec:** [docs/superpowers/specs/2026-09-21-baptisms-overhaul-design.md](../specs/2026-09-21-baptisms-overhaul-design.md)

## Global Constraints

- **Branch per PR off `beta`. Never push to `beta`, `main` or any default branch. Every change is a PR.** Do not merge; the maintainer presses every button.
- **No emoji anywhere. No `Co-Authored-By` trailer, no "Generated with" footer** in commits, PR bodies or comments.
- Commit subject line alone by default: `<type>: <what changed>`, types `feat|fix|perf|refactor|docs|test|chore|style`.
- **`Beta-only: true` as the LAST paragraph of the commit body** on any `fix:`/`perf:` to something that does not exist on `main`. Everything in this plan except the two defects in Task 1 and Task 2 is new in this cycle.
- **Every guard ships proven red.** Delete the guard or reintroduce the bug, watch the test fail in the same session, and say so in the commit. A test that passes on the defect it was written for is not a guard.
- **Exact-count guards are sorted lists, one entry per line — never a bare number.** Two branches adding different entries must merge cleanly.
- **A new `catch` either rethrows or returns the failure.** A `catch` that only logs is forbidden.
- **Do not delete an operator's data to tidy up.** Log it or offer an explicit action.
- Verification gate, run and read in-session before any PR: `npm run type-check && npm run lint && npm test`.
- Dev server on port **8799** with an **always-empty** data dir. Never copy production data — a copy dials Shure, PCO and Vea and logs production out of Vea. Kill the server **by port**, never `pkill -f` on an env-var prefix.
- Time zone: anything asking "what day is it" goes through `main/services/app-timezone.ts`, never the host clock.
- Numeric fields in the UI use the themed `NumberInput`, never a raw number input.
- No purple. Dark surfaces are strictly R=G=B.

---

## Pre-Sunday operator checklist (not code)

`DEFAULT_SETTINGS.baptismAutoStart` is `{ enabled: false, testimonyKeyword: "baptism stories" }`. Auto-start does nothing until it is switched on. Before the 27th, on the production box:

1. Enable baptism auto-start in Settings and confirm the keyword matches the real plan item title.
2. Bind the per-plan baptism trigger to the first song the dunks happen during.
3. Confirm the workflow toggle reads **Grouped**.

---

## File Structure

**PR 1 — correctness and the raw layer**

| File | Responsibility |
|---|---|
| `main/services/baptism-store.ts` (modify) | `addSession` replaces by id instead of prepending a duplicate |
| `main/services/baptism-store.test.ts` (modify) | Guard: finish → undo → finish leaves one session |
| `main/services/baptism-timer-service.ts` (modify) | `armed` state, `advance()`, raw-layer writes, live-item tracking, honest auto-start reporting |
| `main/types/baptism.ts` (modify) | `armed` on `BaptismState`; `BaptismRawFields`, `BaptismRawEvent` |
| `main/services/settings-store.ts` (modify) | `baptismDefaultMode`, defaulting to `grouped` |
| `main/services/archive/sample-archive.ts` (modify) | `recordBaptism`, `baptism` in `SOURCES` |
| `main/services/archive/rebuild-baptism.ts` (create) | Pure replay of baptism rows into sessions |
| `main/services/archive/rebuild-baptism.test.ts` (create) | Replay guard, including across an undo |
| `main/services/archive/archive-sources.test.ts` (create) | Sorted exact-list guard on `SOURCES` |
| `main/services/baptism-armed.test.ts` (create) | Armed guard |
| `main/services/baptism-autostart-silent.test.ts` (create) | Silent-failure guard |
| `docs/features/scriptview-and-baptisms.md`, `docs/data-archive.md` (modify) | Ship with the code |

**PR 2 — the tab.** `renderer/main/baptism-operator.tsx` splits; new `renderer/settings/sections/baptisms/` holds `header.tsx`, `session-chart.tsx`, `people-table.tsx`, `past-sessions.tsx`, `trends.tsx`, `figures.ts`.

**PR 3 — History integration.** `renderer/settings/sections/service-history-section.tsx`, `renderer/lib/link-baptisms.ts`, `main/services/history-export.ts`, `main/services/history-edit.ts`.

**PR 4 — actions, objects, Companion.** `main/services/automation-actions.ts`, `main/types/views.ts`, `renderer/main/layout-renderer.tsx`, then the module repo's `src/{sse,state,variables,actions,feedbacks,presets,api}.ts`.

---

# PR 1 — Correctness and the raw layer

Branch: `fix/baptism-session-integrity`. **This is the only PR that must land before the 27th.**

## Task 1: `addSession` stops writing duplicate sessions

**Files:**
- Modify: `main/services/baptism-store.ts:45-47`
- Test: `main/services/baptism-store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `baptismStore.addSession(session: BaptismSession): Promise<void>` — unchanged signature, now idempotent by `id`.

- [ ] **Step 1: Write the failing test**

Append to `main/services/baptism-store.test.ts`:

```ts
describe("addSession is idempotent by id", () => {
  it("replaces a session carrying an id already stored", async () => {
    // finish -> undo -> finish re-finalizes the SAME session: `id` is derived
    // from sessionStartedAt, which undo does not change. Prepending a second
    // row makes linkBaptisms count that service's people twice in History.
    const first = { ...session(1), people: [{ testimonyMs: 1000, baptizeMs: 500 }] } as BaptismSession;
    const corrected = { ...session(1), people: [{ testimonyMs: 9000, baptizeMs: 500 }] } as BaptismSession;

    await baptismStore.addSession(first);
    await baptismStore.addSession(corrected);

    const all = await baptismStore.listSessions();
    const mine = all.filter((s) => s.id === first.id);
    assert.equal(mine.length, 1, "the re-finished session must replace, not duplicate");
    assert.equal(mine[0].people[0].testimonyMs, 9000, "the later write wins");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="replaces a session carrying an id"`

Expected: FAIL — `mine.length` is `2`. **This failure is the proof the guard is real. Record the output in the commit body.**

- [ ] **Step 3: Implement**

Replace `main/services/baptism-store.ts:45-47`:

```ts
  /**
   * Append a finished session, or replace one already carrying this id.
   *
   * Not a plain prepend. `finalize()` derives the id from `sessionStartedAt`,
   * and `undo()` from the finished state clears `finishedAt` and re-enters the
   * baptism phase without touching that stamp — so finish -> undo -> finish
   * re-finalizes the SAME session. Prepended, that left two rows sharing an id,
   * and `linkBaptisms` counted the service's people twice.
   *
   * The replacement keeps its position rather than jumping to the head: the list
   * is read newest-first by `startedAt`, and a corrected session did not start
   * again.
   */
  async addSession(session: BaptismSession): Promise<void> {
    await this.store.update((file) => {
      const at = file.sessions.findIndex((s) => s.id === session.id);
      if (at >= 0) {
        const sessions = file.sessions.slice();
        sessions[at] = session;
        return { ...file, sessions };
      }
      return { ...file, sessions: [session, ...file.sessions].slice(0, MAX_SESSIONS) };
    });
  }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- --test-name-pattern="replaces a session carrying an id"` → PASS
Then the whole file: `npm test -- --test-name-pattern="baptism"` → PASS

- [ ] **Step 5: Commit**

```bash
git add main/services/baptism-store.ts main/services/baptism-store.test.ts
git commit -m "fix: a re-finished baptism session replaces its row instead of duplicating it"
```

Body must state the red run and that the defect predates this cycle, so **no** `Beta-only` trailer here — `addSession` ships on `main`.

---

## Task 2: auto-start stops reporting a transition that did not happen

**Files:**
- Modify: `main/services/baptism-timer-service.ts` (`onLiveTick`)
- Test: `main/services/baptism-autostart-silent.test.ts` (create)

**Interfaces:**
- Consumes: `autoStartAction(input: AutoStartInput): AutoAction` from `baptism-autostart.js` — unchanged.
- Produces: `onLiveTick` only sets `autoStartedFrom` when `phase` actually moved.

- [ ] **Step 1: Write the failing test**

Create `main/services/baptism-autostart-silent.test.ts`:

```ts
// Auto-start used to claim a transition it had not made.
//
// autoStartAction returns "start-baptisms" whenever the bound item goes live and
// the phase is testimony -- in EITHER mode. startBaptisms() returns early unless
// the mode is grouped. onLiveTick ignored the return value and set
// autoStartedFrom regardless, so in per-person mode the song going live painted
// "Started automatically from <song>" on the panel while the timer did nothing.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-auto-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { baptismTimerService } = await import("./baptism-timer-service.js");
const { baptismTriggersStore } = await import("./baptism-triggers-store.js");

describe("auto-start in per-person mode", () => {
  beforeEach(() => {
    baptismTimerService.reset();
    baptismTimerService.setMode("per-person");
  });

  it("does not claim it started the baptisms when it could not", async () => {
    await baptismTriggersStore.set(null, { testimonyItemId: null, baptismItemId: "song-1" });
    baptismTimerService.start(); // phase: testimony, per-person

    await baptismTimerService.onLiveTick({
      mode: "item",
      currentItemId: "song-1",
      label: "Great Are You Lord",
    } as never);

    const s = baptismTimerService.getState();
    assert.equal(s.phase, "testimony", "per-person has no grouped baptism section to enter");
    assert.equal(
      s.autoStartedFrom ?? null,
      null,
      "the panel must not say it started from an item when nothing moved",
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="does not claim it started the baptisms"`

Expected: FAIL — `autoStartedFrom` is `"Great Are You Lord"`. **Record this in the commit.**

- [ ] **Step 3: Implement**

In `main/services/baptism-timer-service.ts`, replace the `if (action === …)` block at the end of `onLiveTick`:

```ts
    if (action === null) return;

    // Compare the phase the action was supposed to produce against the phase we
    // actually got. startBaptisms() returns early unless the mode is grouped,
    // and the old code set autoStartedFrom regardless -- so the panel reported a
    // transition that never happened and the operator had no reason to look.
    const before = this.state.phase;
    if (action === "start-testimonies") this.start();
    else this.startBaptisms();

    if (this.state.phase === before) {
      console.warn(
        `[baptism] auto-start: "${live.label ?? live.currentItemId}" is bound to the ` +
          `${action === "start-baptisms" ? "baptisms" : "testimonies"} but the timer is in ` +
          `${this.state.mode} mode and stayed in "${before}" — ignored`,
      );
      return;
    }

    console.info(`[baptism] auto-start: started ${this.state.phase} from "${live.label ?? ""}"`);
    this.state = { ...this.state, autoStartedFrom: live.label ?? null };
    this.commit();
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- --test-name-pattern="auto-start"` → PASS

- [ ] **Step 5: Commit**

```bash
git add main/services/baptism-timer-service.ts main/services/baptism-autostart-silent.test.ts
git commit -m "fix: auto-start only reports a phase change that actually happened"
```

No `Beta-only` trailer — `onLiveTick` ships on `main`.

---

## Task 3: grouped becomes the default workflow

**Files:**
- Modify: `main/services/settings-store.ts` (`SettingsData`, `DEFAULT_SETTINGS`)
- Modify: `main/services/baptism-timer-service.ts` (`init`)
- Test: `main/services/baptism-armed.test.ts` (created here, extended in Task 4)

**Interfaces:**
- Produces: `SettingsData.baptismDefaultMode?: BaptismMode`, default `"grouped"`.

- [ ] **Step 1: Write the failing test**

Create `main/services/baptism-armed.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-armed-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { baptismTimerService } = await import("./baptism-timer-service.js");

describe("default workflow", () => {
  it("starts grouped, because that is how a baptism is run here", async () => {
    await baptismTimerService.init();
    assert.equal(baptismTimerService.getState().mode, "grouped");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="starts grouped"` → FAIL, mode is `per-person`.

- [ ] **Step 3: Implement**

In `main/services/settings-store.ts`, add to the `SettingsData` interface beside `baptismAutoStart`:

```ts
  /** Workflow the baptism timer opens in. Grouped is how a baptism actually
   *  runs here: every testimony inside one plan item, then the baptisms spread
   *  across the song set. Per-person is the minority case. */
  baptismDefaultMode?: BaptismMode;
```

Add to `DEFAULT_SETTINGS`:

```ts
  baptismDefaultMode: "grouped",
```

In `baptism-timer-service.ts`, replace `init()`:

```ts
  async init(): Promise<void> {
    const [saved, settings] = await Promise.all([baptismStore.loadCurrent(), settingsStore.get()]);
    const fallback = settings.baptismDefaultMode === "per-person" ? "per-person" : "grouped";
    this.state = saved ? { ...idleState(fallback), ...saved } : idleState(fallback);
  }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- --test-name-pattern="starts grouped"` → PASS

- [ ] **Step 5: Commit**

```bash
git add main/services/settings-store.ts main/services/baptism-timer-service.ts main/services/baptism-armed.test.ts
git commit -m "feat: the baptism timer opens in grouped, the workflow this church uses"
```

---

## Task 4: the armed state

**Files:**
- Modify: `main/types/baptism.ts` (`BaptismState`)
- Modify: `main/services/baptism-timer-service.ts` (`startBaptisms`, `next`, `pause`, `reset`, new `advance`)
- Test: `main/services/baptism-armed.test.ts`

**Interfaces:**
- Produces:
  - `BaptismState.armed?: boolean`
  - `baptismTimerService.advance(): BaptismState` — phase-aware primary; Task 13 and the Companion module both call it.

- [ ] **Step 1: Write the failing test**

Append to `main/services/baptism-armed.test.ts`:

```ts
describe("grouped baptisms begin armed", () => {
  it("runs no clock until the first person steps in", async () => {
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    baptismTimerService.start();          // testimony, person 1
    baptismTimerService.next();           // bank person 1's testimony
    const armedAt = baptismTimerService.startBaptisms();

    assert.equal(armedAt.phase, "baptism");
    assert.equal(armedAt.armed, true, "the song going live must not start person 1's clock");
    assert.equal(armedAt.segmentStartedAt, null, "no clock may be running while armed");
    assert.equal(armedAt.segmentAccumMs ?? 0, 0);

    const running = baptismTimerService.advance();  // "First person in"
    assert.equal(running.armed ?? false, false, "the first press clears armed");
    assert.notEqual(running.segmentStartedAt, null, "and starts person 1");
  });

  it("does not bank the armed stretch onto person 1", async () => {
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    baptismTimerService.start();
    baptismTimerService.next();
    baptismTimerService.startBaptisms();
    // Whatever elapses while armed belongs to nobody.
    const before = Date.now();
    baptismTimerService.advance();
    const startedMs = Date.parse(baptismTimerService.getState().segmentStartedAt as string);
    assert.ok(startedMs >= before, "person 1's clock starts at the press, not at the arming");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="grouped baptisms begin armed"`
Expected: FAIL — `armed` is `undefined` and `advance` is not a function.

- [ ] **Step 3: Implement**

In `main/types/baptism.ts`, add to `BaptismState`:

```ts
  /**
   * Grouped only: the baptism phase has begun but nobody's clock runs yet.
   *
   * The baptisms happen across the song set, and the phase starts when the first
   * song goes live -- which is not when the first person steps into the water.
   * Without this, person 1 absorbs however much intro the band plays, every
   * week. Armed, every person's span runs from their own press to the next
   * person's, so they all carry the same kind of boundary.
   *
   * Distinct from paused: a paused segment has banked time to resume from, an
   * armed one has not started.
   */
  armed?: boolean;
```

In `baptism-timer-service.ts`, replace `startBaptisms()`:

```ts
  /** GROUPED: end the testimony section and ARM the baptisms. The currently-timing
   *  testimony is finalized as the last person; no baptism clock starts until the
   *  first press. See BaptismState.armed. */
  startBaptisms(): BaptismState {
    if (this.state.mode !== "grouped" || this.state.phase !== "testimony") return this.state;
    const people = [...this.state.people, { testimonyMs: this.elapsedMs(), baptizeMs: 0 }];
    this.state = {
      ...this.state,
      phase: "baptism",
      people,
      baptismIndex: 0,
      armed: true,
      segmentStartedAt: null,
      segmentAccumMs: 0,
    };
    return this.commit();
  }

  /**
   * The phase-aware primary press — whatever the operator panel's main button
   * does right now. ONE entry point, so a Companion key, a layout button and the
   * panel cannot disagree about which action is legal in which phase.
   */
  advance(): BaptismState {
    if (this.state.phase === "idle") return this.start();
    if (this.state.armed) {
      // "First person in": begin person 1 without banking the armed stretch.
      this.state = { ...this.state, armed: false, segmentStartedAt: new Date().toISOString(), segmentAccumMs: 0 };
      return this.commit();
    }
    if (this.state.phase === "testimony") {
      return this.state.mode === "grouped" ? this.next() : this.baptized();
    }
    return this.next();
  }
```

Guard the two places an armed clock must not be touched. In `pause()`, add after the existing early return:

```ts
    if (this.state.armed) return this.state; // nothing is running to bank
```

In `idleState()`, add `armed: false,` to the returned object so a reset clears it.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- --test-name-pattern="armed"` → PASS
Then: `npm test -- --test-name-pattern="baptism"` → PASS

- [ ] **Step 5: Wire the route and commit**

Add to the `switch (action)` in `main/services/routes/history-routes.ts`:

```ts
        case "advance": json(res, baptismTimerService.advance()); return;
```

Add to the `switch` in `renderer/lib/api.ts` beside `baptism:next`:

```ts
    case "baptism:advance":
      return post("/api/baptism/advance");
```

(Match the surrounding cases' exact helper — copy the neighbouring line's form.)

```bash
git add main/types/baptism.ts main/services/baptism-timer-service.ts main/services/baptism-armed.test.ts main/services/routes/history-routes.ts renderer/lib/api.ts
git commit -m "feat: grouped baptisms arm on the song and start on the first press"
```

---

## Task 5: the `baptism` raw source

**Files:**
- Modify: `main/services/archive/sample-archive.ts` (`SOURCES`, new `recordBaptism`)
- Modify: `main/types/baptism.ts` (`BaptismRawEvent`, `BaptismRawFields`)
- Test: `main/services/archive/archive-sources.test.ts` (create)

**Interfaces:**
- Produces:
  - `type BaptismRawEvent = "start" | "testimony-end" | "baptisms-armed" | "baptisms-start" | "person-complete" | "pause" | "resume" | "undo" | "finish" | "reset"`
  - `interface BaptismRawFields { event: BaptismRawEvent; mode: BaptismMode; phase: BaptismPhase; personNumber: number; baptismIndex: number; segmentMs: number; itemId: string | null; item: string | null; detail: string }`
  - `sampleArchive.recordBaptism(ctx: ServiceCtx, fields: BaptismRawFields): void`

- [ ] **Step 1: Write the failing test**

Create `main/services/archive/archive-sources.test.ts`:

```ts
// The raw sources this archive writes, as a SORTED LIST, one entry per line.
//
// Not a count. A count cannot tell an add plus a remove from no change, and a
// single-line assertion is a guaranteed merge conflict between two branches each
// adding a source. Every source must be here: mergeInto walks this list, so one
// left out is a source a history merge silently leaves behind.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ARCHIVE_SOURCES } from "./sample-archive.js";

const EXPECTED = [
  "attendance",
  "baptism",
  "events",
  "spl",
];

describe("archive sources", () => {
  it("are exactly this sorted list", () => {
    assert.deepEqual([...ARCHIVE_SOURCES].sort(), EXPECTED);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="are exactly this sorted list"`
Expected: FAIL — `ARCHIVE_SOURCES` is not exported, and once exported it lacks `baptism`.

- [ ] **Step 3: Implement**

In `main/types/baptism.ts`:

```ts
/** One operator action, as the raw layer records it. Never a derived total:
 *  the file is what happened, and the totals are replayed from it. */
export type BaptismRawEvent =
  | "start"
  | "testimony-end"
  | "baptisms-armed"
  | "baptisms-start"
  | "person-complete"
  | "pause"
  | "resume"
  | "undo"
  | "finish"
  | "reset";

/** One `baptism.csv` row. The column set is FIXED — see recordBaptism. */
export interface BaptismRawFields {
  event: BaptismRawEvent;
  mode: BaptismMode;
  phase: BaptismPhase;
  personNumber: number;
  baptismIndex: number;
  /** The segment's elapsed ms at this moment, or 0 where it means nothing. */
  segmentMs: number;
  /** The plan item live when this happened. Null when nothing is live. */
  itemId: string | null;
  item: string | null;
  detail: string;
}
```

In `main/services/archive/sample-archive.ts`, export the source list and add the writer:

```ts
/** Every source this archive writes. Merging has to move all of them, so the
 *  list is named once rather than inferred from whatever happens to be on disk.
 *  Exported for the guard in archive-sources.test.ts. */
export const ARCHIVE_SOURCES = ["spl", "attendance", "events", "baptism"] as const;
```

Replace the private `SOURCES` with `ARCHIVE_SOURCES` at its two uses (`mergeInto`, `rewriteManifest`).

Add the method beside `recordEvent`:

```ts
  /**
   * One row per operator action on the baptism timer.
   *
   * The column set is FIXED, for the reason recordEvent's own doc gives: two
   * header shapes in one source roll the file on every alternation, and
   * readArchiveRows concatenates rolled files in FILE order — so the rows a
   * rebuild walks would no longer be in time order.
   *
   * APPEND ONLY. An undo is a new `undo` row, never the removal of the row it
   * undoes, so the file is the full record of what the operator did and a replay
   * can reproduce any intermediate state.
   *
   * `item` names the plan item live at the time. Without it the file knows a
   * baptism happened at 11:31:40 but not that the room was singing O Praise The
   * Name, and the plan lane cannot be redrawn from raw.
   */
  recordBaptism(ctx: ServiceCtx, fields: BaptismRawFields): void {
    const e = this.entry(ctx);
    if (!e) return;
    void this.appender(e, "baptism").append(
      ["at", "event", "mode", "phase", "personNumber", "baptismIndex", "segmentMs", "itemId", "item", "detail"],
      [
        new Date().toISOString(),
        fields.event,
        fields.mode,
        fields.phase,
        fields.personNumber,
        fields.baptismIndex,
        Math.max(0, Math.round(fields.segmentMs)),
        fields.itemId ?? "",
        fields.item ?? "",
        fields.detail,
      ],
    );
  }
```

Import `BaptismRawFields` from `../../types/stage.js`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- --test-name-pattern="are exactly this sorted list"` → PASS
Prove the guard: temporarily drop `"baptism"` from `ARCHIVE_SOURCES`, rerun, watch it fail, restore.

- [ ] **Step 5: Commit**

```bash
git add main/types/baptism.ts main/services/archive/sample-archive.ts main/services/archive/archive-sources.test.ts
git commit -m "feat: the archive records baptisms as a fourth append-only source"
```

---

## Task 6: the timer writes every action to the raw layer

**Files:**
- Modify: `main/services/baptism-timer-service.ts`
- Test: `main/services/archive/rebuild-baptism.test.ts` (created in Task 7 — this task's proof is Task 7's replay)

**Interfaces:**
- Consumes: `sampleArchive.recordBaptism`, `currentServiceKey()` from `service-key.js`.
- Produces: every mutating method emits exactly one raw row.

- [ ] **Step 1: Track the live plan item**

Add to the class, beside `lastAutoItemId`:

```ts
  /** The plan item live right now, held from the last onLiveTick so a button
   *  press — which arrives nowhere near a live tick — can still say which song
   *  the room was on. */
  private liveItem: { id: string; title: string } | null = null;
```

Set it at the top of `onLiveTick`, before the change check:

```ts
    this.liveItem =
      live.mode === "item" && live.currentItemId
        ? { id: live.currentItemId, title: live.label ?? "" }
        : null;
```

- [ ] **Step 2: Add the emit helper**

```ts
  /**
   * Append this action to the raw layer. Gated on an open service, like every
   * other raw source — no key means no row, which is what keeps a Tuesday
   * afternoon out of the archive.
   *
   * Never throws and never blocks: the live path must survive a full disk.
   */
  private emitRaw(event: BaptismRawEvent, segmentMs: number, detail = ""): void {
    const serviceKey = currentServiceKey();
    if (!serviceKey) {
      if (!this.warnedNoService) {
        this.warnedNoService = true;
        console.warn("[baptism] raw: no service open, session not archived");
      }
      return;
    }
    sampleArchive.recordBaptism(
      { serviceKey, serviceDate: serviceKey.split(":").pop() ?? new Date().toISOString().slice(0, 10) },
      {
        event,
        mode: this.state.mode,
        phase: this.state.phase,
        personNumber: this.state.personNumber,
        baptismIndex: this.state.baptismIndex,
        segmentMs,
        itemId: this.liveItem?.id ?? null,
        item: this.liveItem?.title ?? null,
        detail,
      },
    );
  }
```

Add `private warnedNoService = false;` to the class, and reset it to `false` inside `start()`.

**Note on `serviceDate`:** derive it the way the other recorders do rather than splitting the key — read `serviceTimelineRecorder.getCurrent()?.serviceDate`. Use that if available; the split above is the fallback only. Confirm against `main/services/service-timeline-recorder.ts` before writing, and use the recorder's field.

- [ ] **Step 3: Call it from every mutating method**

Insert immediately before each `return this.commit()`:

| Method | Call |
|---|---|
| `start` | `this.emitRaw("start", 0, this.state.autoStartedFrom ? `auto: ${this.state.autoStartedFrom}` : "manual")` |
| `baptized` | `this.emitRaw("testimony-end", this.state.pendingTestimonyMs ?? 0)` |
| `startBaptisms` | `this.emitRaw("baptisms-armed", 0)` |
| `advance` (the armed branch) | `this.emitRaw("baptisms-start", 0)` |
| `next` (per-person) | `this.emitRaw("person-complete", person.baptizeMs, `t=${person.testimonyMs} b=${person.baptizeMs}`)` |
| `next` (grouped testimony) | `this.emitRaw("testimony-end", person.testimonyMs)` |
| `next` (grouped baptism) | `this.emitRaw("person-complete", people[this.state.baptismIndex].baptizeMs, `t=${…testimonyMs} b=${…baptizeMs}`)` |
| `pause` | `this.emitRaw("pause", this.state.segmentAccumMs ?? 0)` |
| `resume` | `this.emitRaw("resume", this.state.segmentAccumMs ?? 0)` |
| `undo` | `this.emitRaw("undo", 0, `from ${s.phase}`)` |
| `finalize` | `this.emitRaw("finish", 0, `people=${people.length}`)` |
| `reset` | `this.emitRaw("reset", 0)` |

Emit **after** `this.state` is reassigned, so the row carries the state the action produced.

- [ ] **Step 4: Verify nothing regressed**

Run: `npm test -- --test-name-pattern="baptism"` → PASS
Run: `npm run type-check` → clean

- [ ] **Step 5: Commit**

```bash
git add main/services/baptism-timer-service.ts
git commit -m "feat: every baptism timer action lands in the raw layer"
```

---

## Task 7: replay raw rows back into sessions

**Files:**
- Create: `main/services/archive/rebuild-baptism.ts`
- Create: `main/services/archive/rebuild-baptism.test.ts`

**Interfaces:**
- Produces:
  - `type BaptismRow = ArchiveRow`
  - `rebuildBaptismSessions(rows: BaptismRow[], identity: BaptismIdentity): BaptismSession[]` — **pure**, mirroring `rebuildTimelineRecord`: no disk, no store, so it can compare as well as replace.
  - `interface BaptismIdentity { serviceKey: string; title: string | null; serviceTypeId: string | null; planId: string | null }`
  - `readBaptismRows(serviceKey: string, serviceDate: string): Promise<BaptismRow[] | null>`

- [ ] **Step 1: Write the failing test**

Create `main/services/archive/rebuild-baptism.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rebuildBaptismSessions, type BaptismRow } from "./rebuild-baptism.js";

const ID = { serviceKey: "st1:p1:t1", title: "Sunday Gathering", serviceTypeId: "st1", planId: "p1" };

/** t is seconds after 11:00:00Z. */
const row = (t: number, over: Partial<BaptismRow>): BaptismRow => ({
  at: new Date(Date.UTC(2026, 8, 27, 11, 0, t)).toISOString(),
  event: "", mode: "grouped", phase: "", personNumber: "0", baptismIndex: "0",
  segmentMs: "0", itemId: "", item: "", detail: "",
  ...over,
});

describe("rebuildBaptismSessions", () => {
  it("replays a grouped session into the same people the presses produced", () => {
    const rows: BaptismRow[] = [
      row(0,   { event: "start", phase: "testimony", personNumber: "1", item: "Baptism Stories" }),
      row(108, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "108000", item: "Baptism Stories" }),
      row(204, { event: "testimony-end", phase: "testimony", personNumber: "2", segmentMs: "96000", item: "Baptism Stories" }),
      row(420, { event: "baptisms-armed", phase: "baptism", item: "Great Are You Lord" }),
      row(460, { event: "baptisms-start", phase: "baptism", item: "Great Are You Lord" }),
      row(502, { event: "person-complete", phase: "baptism", baptismIndex: "0", segmentMs: "42000", item: "Great Are You Lord" }),
      row(540, { event: "person-complete", phase: "baptism", baptismIndex: "1", segmentMs: "38000", item: "O Praise The Name" }),
      row(545, { event: "finish", phase: "idle", detail: "people=2" }),
    ];

    const [session] = rebuildBaptismSessions(rows, ID);

    assert.equal(session.people.length, 2);
    assert.deepEqual(session.people[0], { testimonyMs: 108000, baptizeMs: 42000 });
    assert.deepEqual(session.people[1], { testimonyMs: 96000, baptizeMs: 38000 });
    assert.equal(session.serviceKey, "st1:p1:t1");
    assert.equal(session.title, "Sunday Gathering");
  });

  it("honours an undo rather than counting the step it undid", () => {
    const rows: BaptismRow[] = [
      row(0,   { event: "start", phase: "testimony", personNumber: "1" }),
      row(60,  { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "60000" }),
      row(120, { event: "testimony-end", phase: "testimony", personNumber: "2", segmentMs: "60000" }),
      row(130, { event: "undo", phase: "testimony", detail: "from testimony" }),
      row(200, { event: "testimony-end", phase: "testimony", personNumber: "2", segmentMs: "80000" }),
      row(210, { event: "finish", phase: "idle", detail: "people=2" }),
    ];

    const [session] = rebuildBaptismSessions(rows, ID);

    assert.equal(session.people.length, 2, "the undone testimony must not leave a third person");
    assert.equal(session.people[1].testimonyMs, 80000, "the corrected time replaces the undone one");
  });

  it("returns nothing for rows that never started a session", () => {
    assert.deepEqual(rebuildBaptismSessions([], ID), []);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="rebuildBaptismSessions"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `main/services/archive/rebuild-baptism.ts`:

```ts
// rebuild-baptism.ts — recompute a service's baptism sessions from its raw rows.
//
// The derived store (baptism.json) is a rewritable array: a mis-press, a crash
// between the debounced persist and the next write, or a corrupted file and the
// session is gone. baptism.csv is append-only and holds every action the
// operator took, so the sessions can be re-derived instead of lost.
//
// PURE, like rebuildTimelineRecord: no disk, no store. That lets it be used to
// COMPARE a stored record against the rows as well as to replace one.

import type { BaptismPerson, BaptismSession } from "../../types/stage.js";
import type { ArchiveRow } from "./archive-rows.js";
import { readArchiveRows } from "./archive-rows.js";
import { serviceDirPath } from "./archive-paths.js";

/** One row of `baptism.csv`, as readArchiveRows hands it back. */
export type BaptismRow = ArchiveRow;

/** What the rows cannot say: which service this was and what it was called. */
export interface BaptismIdentity {
  serviceKey: string;
  title: string | null;
  serviceTypeId: string | null;
  planId: string | null;
}

/** Chronological, leaving an unparseable stamp beside its neighbours (the sort
 *  is stable, so returning 0 does not herd damaged rows to one end). */
function byTime(rows: BaptismRow[]): BaptismRow[] {
  return [...rows].sort((a, b) => {
    const ta = Date.parse(a.at ?? "");
    const tb = Date.parse(b.at ?? "");
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
    return ta - tb;
  });
}

function num(v: string | undefined): number {
  const n = Number(v ?? "");
  return Number.isFinite(n) ? n : 0;
}

/**
 * Replay rows into the sessions they describe.
 *
 * One session per `start`, closed by its `finish`. A `reset` abandons the
 * session underway without logging it, which is what reset means.
 *
 * An `undo` pops the last thing recorded rather than rewriting history: the rows
 * are append-only, so the undone step is still in the file and a replay that
 * ignored the undo would count it. Popping is the replay's whole job — it is why
 * an undo is recorded as its own row instead of the row it cancels being
 * removed.
 */
export function rebuildBaptismSessions(rows: BaptismRow[], identity: BaptismIdentity): BaptismSession[] {
  const out: BaptismSession[] = [];

  let startedAt: string | null = null;
  let people: BaptismPerson[] = [];
  let pendingTestimony: number | null = null;
  /** Testimonies banked in the grouped pass, awaiting their baptism times. */
  let groupedIndex = 0;

  for (const r of byTime(rows)) {
    const at = r.at ?? "";
    switch (r.event) {
      case "start":
        startedAt = at;
        people = [];
        pendingTestimony = null;
        groupedIndex = 0;
        break;

      case "testimony-end":
        if (startedAt === null) break;
        if (r.mode === "grouped") people.push({ testimonyMs: num(r.segmentMs), baptizeMs: 0 });
        else pendingTestimony = num(r.segmentMs);
        break;

      case "person-complete":
        if (startedAt === null) break;
        if (r.mode === "grouped") {
          const i = num(r.baptismIndex);
          if (people[i]) people[i].baptizeMs = num(r.segmentMs);
          groupedIndex = i + 1;
        } else {
          people.push({ testimonyMs: pendingTestimony ?? 0, baptizeMs: num(r.segmentMs) });
          pendingTestimony = null;
        }
        break;

      case "undo":
        if (startedAt === null) break;
        // Drop the most recent thing this replay recorded. In grouped baptisms
        // that is a baptism time (zeroed, the person stays); anywhere else it is
        // the last person appended.
        if (r.mode === "grouped" && groupedIndex > 0) {
          groupedIndex -= 1;
          if (people[groupedIndex]) people[groupedIndex].baptizeMs = 0;
        } else if (people.length > 0) {
          const last = people.pop() as BaptismPerson;
          pendingTestimony = r.mode === "per-person" ? last.testimonyMs : null;
        }
        break;

      case "finish":
        if (startedAt === null) break;
        if (people.length > 0) {
          out.push({
            id: `bap-${Date.parse(startedAt)}`,
            startedAt,
            finishedAt: at,
            people,
            title: identity.title,
            serviceTypeId: identity.serviceTypeId,
            planId: identity.planId,
            serviceKey: identity.serviceKey,
          });
        }
        startedAt = null;
        people = [];
        pendingTestimony = null;
        groupedIndex = 0;
        break;

      case "reset":
        // Deliberately logs nothing: reset means "this session did not happen".
        startedAt = null;
        people = [];
        pendingTestimony = null;
        groupedIndex = 0;
        break;

      default:
        // armed / baptisms-start / pause / resume carry no session content of
        // their own. They are in the file because the LANE is drawn from it.
        break;
    }
  }

  return out;
}

/** The rows for one service, or null when it has no baptism archive — the same
 *  "nothing to rebuild from" contract rebuildSplItems has. */
export async function readBaptismRows(serviceKey: string, serviceDate: string): Promise<BaptismRow[] | null> {
  return readArchiveRows(serviceDirPath(serviceKey, serviceDate), "baptism");
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- --test-name-pattern="rebuildBaptismSessions"` → PASS

Then prove Task 6 end to end: add a test that drives `baptismTimerService` through a grouped session against a temp data dir, calls `sampleArchive.flush()`, reads the rows back with `readBaptismRows` and asserts `rebuildBaptismSessions` reproduces `listSessions()`. **This is the guard that Task 6's emit calls are complete** — delete any one `emitRaw` call and it must fail.

- [ ] **Step 5: Commit**

```bash
git add main/services/archive/rebuild-baptism.ts main/services/archive/rebuild-baptism.test.ts
git commit -m "feat: baptism sessions replay from the raw rows"
```

---

## Task 8: PR 1 docs, gate and PR

- [ ] **Step 1: Docs**

`docs/features/scriptview-and-baptisms.md` — grouped as the default; the armed state and what a person's baptism time measures (press to press, not time submerged); the `advance` action.

`docs/data-archive.md` — `baptism.csv` as the fourth source, its fixed column list, the append-only rule, and that sessions replay from it.

Voice: concise reference for a stranger who found the repo on GitHub, describing what the thing does now. Never a before/after narrative.

- [ ] **Step 2: Full gate, read the output in-session**

```bash
npm run type-check && npm run lint && npm test
```

- [ ] **Step 3: Drive the real server**

```bash
STAGE_UTILITY_DATA=$(mktemp -d) PORT=8799 npm run server
```

Empty data dir, never a copy. Walk a grouped session end to end in the browser: start, two testimonies, start baptisms (confirm it reads **armed** at 0:00), first person in, next, finish. Then confirm `baptism.csv` exists under the archive dir and holds a row per press. Kill by port: `lsof -ti:8799 | xargs kill`.

- [ ] **Step 4: Three review passes before opening the PR** — correctness, simplification, whole-PR. Fix what they find.

- [ ] **Step 5: Open the PR**

Base `beta`. Body answers both standing questions explicitly: which docs changed, and what an operator debugging this at 9am on a Sunday would have to read (the four `[baptism]` lines). State that Tasks 1 and 2 carry no `Beta-only` trailer because both defects ship on `main`, and that every guard was watched red.

---

# PR 2 — The tab

Branch: `feat/baptisms-tab`, stacked on `fix/baptism-session-integrity` (#581). Opened with
`--base fix/baptism-session-integrity`; never by merging the unmerged sibling in.

**The mockup is the spec.** `.superpowers/sdd/2026-09-21-baptisms-overhaul/mockup-v3.html`
(published at https://claude.ai/artifact/CKsh8UMt2uASE2xxxE7Gc8, v3). Every UI task builds
what it shows, in the app's real tokens, and reads the mockup BEFORE this prose.

**Refreshed after PR 1.** This section was rewritten against the code as PR 1 left it. Three
gaps in the original plan, each confirmed against source:

1. **The session lane cannot be drawn from `BaptismState`.** `people` holds durations
   (`testimonyMs`, `baptizeMs`), not timestamps, and durations cannot show a gap — which is
   the lane's whole purpose (the armed stretch, the transition, a pause). The raw rows PR 1
   built carry an `at` on every press. The lane is derived from them (Task 9).
2. **History has no URL for a single service.** Its selection is `useState` at
   `service-history-section.tsx:335`. Every "open in History" link needs somewhere to go.
   Task 10 adds it; PR 3 reuses it.
3. **"Rebuild from raw" moves to PR 3.** The mockup's header shows it, but the replay has no
   production caller until PR 3 fixes the session-id skew (Ruling 31). A button that does
   nothing is the failure CLAUDE.md names. PR 2's header ships Copy report and Export CSV.

**Handoffs from PR 1 that bind this PR:**

- `summarizeBaptism().count` now counts people with a baptism time, not everyone who
  testified. Use it; do not re-derive.
- In grouped mode, `personNumber` is the TESTIMONY counter and freezes when the section
  arms. A baptism span's person is `baptismIndex + 1`. Keying on `personNumber` mis-attributes
  every grouped baptism.
- `person-complete` is NOT unique per person — an undo can re-baptize. Last wins.
- There are four `undo` row shapes: `(testimony, from testimony)` pops a completed testimony;
  `(testimony, from baptism)` pops the person `baptisms-armed` folded in; `(baptism, from
  baptism)` does not pop and re-times the baptism at the new index; `(baptism, from idle)`
  un-finishes. The `detail` text collides between modes — key on `mode` and `phase`.
  **Corrected since:** two grouped `baptism` undos RE-ARM rather than re-time, byte-identical to
  a re-timing row — "First person in" taken back (PR 1, `c7b6af4d`) writes exactly what a step
  back onto person 1 writes, and reopening a Finish pressed while armed (Task 14) writes a
  `(baptism, from idle)`. The lane tells them apart by what precedes the row: the latest span
  being person 1's own baptism, or the `finish` before it having closed an armed section.
- `emitRaw` queues the append and does NOT await it, and `commit()` broadcasts `baptism:state`
  synchronously. A reader that fetches rows on the push can beat the row to disk.
- Everything PR 1 hardened in `main/services/baptism-timer-service.ts` stays hardened. Task 14
  is the only task in this PR that edits it.

## Task 9: derive the session lane from the raw rows

**Files:**
- Create: `main/services/archive/baptism-lane.ts`, `main/services/archive/baptism-lane.test.ts`,
  `main/services/archive/baptism-lane-roundtrip.test.ts`
- Modify: `main/services/routes/history-routes.ts` (a GET route), `renderer/lib/api.ts`
  (a `baptism:lane` case)

**Interfaces:**
- Consumes: `readBaptismRows(serviceKey, serviceDate)`, `type BaptismRow` from
  `./rebuild-baptism.js`; `rowsByTime` from wherever PR 1's refactor put it
  (`c204eb94` extracted one shared helper — find it, do not write a second).
- Produces:
  - `interface BaptismSpan { kind: "testimony" | "baptism"; person: number; startedAt: string; endedAt: string | null }`
  - `baptismLaneSpans(rows: BaptismRow[]): BaptismSpan[]` — PURE, like `rebuildBaptismSessions`.
  - `GET /api/baptism/lane?serviceKey=<key>` → `{ spans: BaptismSpan[] }`, empty when the
    service has no `baptism.csv`.
  - `invoke("baptism:lane", { serviceKey })`.

**Rules the derivation must implement**, each from a real emitter behaviour. Corrected against
driven sessions when Task 9 was built; the three corrections are marked.

- A span opens on `start` (testimony, person 1), on `testimony-end` in grouped mode (the next
  testimony), on per-person `testimony-end` at `phase=baptism` (that person's baptism —
  `baptized()` writes it; at `phase=testimony` it is `finish()` and opens nothing), on
  `baptisms-start` (the first baptism, grouped), on `person-complete` (the next person), and
  on `resume`. Grouped `person-complete` opens the next baptism only while someone is left to
  baptize (Ruling 1's count).
- **Corrected — the press that ends a session opens nothing.** `finish()` writes its closing
  boundary (`testimony-end` or `person-complete`) and then `finish`, in one synchronous call,
  as does `next()`'s grouped auto-finish. A boundary immediately followed by `finish` opens
  nothing. Ruling 1's count alone misses this: a grouped session finished mid-baptism still
  has a next person, never baptized, and per-person `finish()` writes a `person-complete` that
  "always opens the next testimony" would turn into a person the session never had.
- A span closes on the next boundary, on `pause`, on `finish`, and on `reset`.
- **Corrected — a reset session draws nothing.** `reset()` logs no session, so the spans of a
  session reset before it finished are time no recorded session holds. A session's spans are
  what its last `finish` logged — the replay's rule.
- `baptisms-armed` closes the last testimony and opens NOTHING. The stretch until
  `baptisms-start` is a gap, drawn as not counted.
- A grouped baptism span's `person` is `baptismIndex + 1`, never `personNumber`.
- An `undo` takes back the most recent boundary. The span that press opened becomes a gap; the
  span it closed runs again from the undo row — resumed where the emitter resumes from banked
  time (a testimony), re-timed where it restarts at zero (a baptism), so a re-timed baptism's
  earlier pieces are dropped too. Handle all four shapes above.
- **Corrected — one transition writes no row.** `POST /api/baptism/next` while armed starts
  the next person's baptism clock without a row. The first row after it (`pause` or
  `person-complete`) carries that clock's whole run in `segmentMs`, so the span is placed at
  that row's time minus it. Task 14 makes the emitter write `baptisms-start` there; the inference
  stays for files written before that row existed.
- A still-running session ends with one span whose `endedAt` is null.

**The guard that matters — a round-trip invariant.** Drive real sessions through the real
`baptismTimerService` against a temp data dir, let the real `sampleArchive` write the real
rows, read them back with `readBaptismRows`, derive spans, and assert that **for every person,
the sum of their testimony spans equals their recorded `testimonyMs` and the sum of their
baptism spans equals their `baptizeMs`**, within a few milliseconds of rounding. This ties the
lane to the data: a lane that shows time the session did not record, or drops time it did, fails.
The sum alone passes a zero-length span for a person who is not there, so the guard also holds
that a person with no recorded time of a kind has no span of it, that every span names a person
the session has and lies inside a stored session, and that only one clock runs at a time.

Reuse the harness in `main/services/archive/rebuild-baptism-roundtrip.test.ts` (lifted into
`baptism-roundtrip-harness.ts`, shared by both round trips). Scenarios, at minimum: grouped run
to its natural end; grouped with a pause mid-testimony; per-person finished with `finish()`; an
undo that re-baptizes the same person; arm, undo, re-arm.

- [ ] **Step 1: Write the failing fixture tests**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baptismLaneSpans, type BaptismSpan } from "./baptism-lane.js";
import type { BaptismRow } from "./rebuild-baptism.js";

/** t is seconds after 11:00:00Z. */
const row = (t: number, over: Partial<BaptismRow>): BaptismRow => ({
  at: new Date(Date.UTC(2026, 8, 27, 11, 0, t)).toISOString(),
  event: "", mode: "grouped", phase: "", personNumber: "0", baptismIndex: "0",
  segmentMs: "0", itemId: "", item: "", detail: "",
  ...over,
});
const sec = (s: BaptismSpan) =>
  s.endedAt === null ? null : (Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000;

describe("baptismLaneSpans", () => {
  it("leaves the armed stretch as a gap, owned by nobody", () => {
    const spans = baptismLaneSpans([
      row(0,   { event: "start", phase: "testimony", personNumber: "1" }),
      row(100, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "100000" }),
      row(160, { event: "baptisms-start", phase: "baptism" }),
      row(200, { event: "person-complete", phase: "baptism", baptismIndex: "0", segmentMs: "40000" }),
      row(201, { event: "finish", phase: "idle" }),
    ]);
    assert.deepEqual(spans.map((s) => [s.kind, s.person, sec(s)]), [
      ["testimony", 1, 100],
      ["baptism", 1, 40],
    ]);
    // 100s..160s belongs to no span: the band's intro.
    assert.equal(Date.parse(spans[1].startedAt) - Date.parse(spans[0].endedAt as string), 60_000);
  });

  it("names a grouped baptism by baptismIndex, not the frozen personNumber", () => {
    const spans = baptismLaneSpans([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(10, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "10000" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "2", segmentMs: "10000" }),
      row(25, { event: "baptisms-start", phase: "baptism", personNumber: "2" }),
      row(30, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "0", segmentMs: "5000" }),
      row(40, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "1", segmentMs: "10000" }),
      row(41, { event: "finish", phase: "idle", personNumber: "2", baptismIndex: "1" }),
    ]);
    assert.deepEqual(spans.filter((s) => s.kind === "baptism").map((s) => s.person), [1, 2]);
  });

  it("splits a span at a pause and resumes it as the same person", () => {
    const spans = baptismLaneSpans([
      row(0,  { event: "start", mode: "per-person", phase: "testimony", personNumber: "1" }),
      row(30, { event: "pause", mode: "per-person", phase: "testimony", personNumber: "1", segmentMs: "30000" }),
      row(90, { event: "resume", mode: "per-person", phase: "testimony", personNumber: "1", segmentMs: "30000" }),
      row(110,{ event: "finish", mode: "per-person", phase: "idle", personNumber: "1" }),
    ]);
    assert.deepEqual(spans.map((s) => [s.kind, s.person, sec(s)]), [
      ["testimony", 1, 30],
      ["testimony", 1, 20],
    ]);
  });

  it("leaves the last span open while the session runs", () => {
    const spans = baptismLaneSpans([row(0, { event: "start", phase: "testimony", personNumber: "1" })]);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].endedAt, null);
  });
});
```

- [ ] **Step 2: Run them and watch them fail** —
  `node --import tsx --test main/services/archive/baptism-lane.test.ts` → module not found.
- [ ] **Step 3: Implement** `baptism-lane.ts` to the rules above. PURE: no disk, no store.
- [ ] **Step 4: Write the round-trip guard, prove it red.** Delete one boundary rule from your
  implementation (say, `resume` opening a span) and watch the invariant fail on the pause
  scenario. Restore.
- [ ] **Step 5: The route.** `GET /api/baptism/lane?serviceKey=` resolves the service's
  `serviceDate` from its timeline record (not by parsing the key — Ruling 1): the recorder's
  live record first, because the recorder persists on a 4s debounce and a service opened
  seconds ago is not in the store yet, then the timeline store. It calls
  `await sampleArchive.flush()` BEFORE reading so a push-triggered fetch cannot beat the row
  to disk — measured without it, every read made on the push came back a row short — then
  returns `{ spans }`, or a 500 when an archive exists and cannot be read (readArchiveRows
  answers null for that and for no file alike). Add `baptism:lane` to `renderer/lib/api.ts`
  in the form of its neighbours, in BOTH places: the `IpcChannel` union is a hand-written
  sorted list tied to the switch by the exhaustiveness check at `default:`, not derived from
  it, so a case without a union entry fails `tsc` and the entry has to be added by hand.
- [ ] **Step 6: Commit** — `feat: the baptism session lane derives from the raw rows`

## Task 10: History opens a named service from its URL

**Files:** `renderer/settings/sections/service-history-section.tsx`, the router/destination
definitions (`renderer/app/destinations.tsx` and whatever it composes), and a test beside
`renderer/settings/sections/history-service-page.test.tsx`.

**Interfaces:**
- Produces: `historyServiceHref(serviceKey: string): string` — one exported helper, so no
  caller builds the URL by hand.

Read how this app routes before choosing a mechanism: it uses TanStack Router, and
`destinations.tsx` defines the pages. Prefer a validated search param (for example
`?service=<key>`) over a path segment, because a service key contains colons. On load, a
present and known key selects that service exactly as clicking its row does. An unknown key
falls back to the list rather than an empty page, and says nothing alarming.

Selecting a service in the page should also write the param back, so a reload or a copied
URL lands on the same service and Back returns to the list. If the router makes that
invasive, reading on load is the floor; say which you delivered.

- [ ] **Step 1: Failing test** — rendering History with the param for a seeded service opens
  that service's page; an unknown key renders the list.
- [ ] **Step 2: Watch it fail.**
- [ ] **Step 3: Implement**, and export `historyServiceHref`.
- [ ] **Step 4: Watch it pass.**
- [ ] **Step 5: Commit** — `feat: History opens the service named in its URL`

## Task 11: the page shell — header, figures, section nav, timer card

**Files:**
- Create: `renderer/settings/sections/baptisms/figures.ts`, `figures.test.ts`,
  `renderer/settings/sections/baptisms/header.tsx`, `renderer/settings/sections/baptisms/timer-card.tsx`
- Modify: `renderer/main/baptism-operator.tsx` becomes the page composing the pieces. Both
  mounts — `renderer/settings/sections/baptisms-section.tsx` and the `/baptism` destination in
  `renderer/app/destinations.tsx` — keep rendering `<BaptismOperator/>`, so they stay one live
  session viewed twice.

**Build what the mockup shows**, from top to bottom: the title, the `recording` pill while a
session runs (reuse `RecordingPill` from `history-service-header.tsx`), the service sub-line,
the action group, the stat strip (reuse `StatStrip` from `../history-chart`), and the section
nav (Timer, Session, People, Past sessions, Trends) highlighting on scroll the way
`history-service-header.tsx` does. Then the Timer card.

**Figures** — keys and labels exactly as the mockup: `count` "Baptized"; `timed` "Timed"
(sub "testimony + baptism"); `wall` "Wall clock" (sub "start to finish"); `gap` "Not counted"
(sub "gap between phases"); `avgTestimony` "Avg testimony" in `--color-accent`; `avgBaptism`
"Avg baptism" in `--color-live-11`. Derive from `summarizeBaptism` — `count` there already
counts actual baptisms. Customize picks which show, through the existing `prefs` store.

**Actions** — Copy report (a plain-text summary via `copyText` from `renderer/lib/clipboard.ts`)
and Export CSV (the existing `GET /api/history/export` with the `baptisms` sheet). NOT
Rebuild from raw — see the section header.

**The Timer card keeps every PR 1 behaviour.** It moves, it does not change: the armed readout
(`Baptisms · armed` / `waiting for the first person to step in`), the button labels (`First
person in` → `Next person in` → `Last person out`), Pause hidden while armed, the typed
`primaryChannel`, the workflow toggle, and `BaptismTriggersPanel`. The readout stays large and
thumb-sized — it is what the operator touches during a service. PR 1's panel guards in
`renderer/main/baptism-operator-armed.test.tsx` must still pass unchanged; if one needs editing,
that is a sign behaviour moved.

- [ ] **Step 1: Failing tests** for the figures:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baptismFigures } from "./figures.js";

const started = Date.UTC(2026, 8, 27, 11, 0, 0);
const base = {
  mode: "grouped", phase: "idle", armed: false,
  sessionStartedAt: new Date(started).toISOString(),
  finishedAt: new Date(started + 29 * 60_000).toISOString(),
  personNumber: 1, baptismIndex: 0, segmentStartedAt: null, segmentAccumMs: 0,
  pendingTestimonyMs: null, serviceTitle: null, serviceTypeId: null, planId: null,
};
const by = (f: { key: string; value: string }[], k: string) => f.find((x) => x.key === k)?.value;

describe("baptismFigures", () => {
  it("keeps wall clock and timed apart, and names the difference", () => {
    const f = baptismFigures(
      { ...base, people: [{ testimonyMs: 108_000, baptizeMs: 42_000 }] } as never,
      started + 29 * 60_000,
    );
    assert.equal(by(f, "timed"), "2:30");
    assert.equal(by(f, "wall"), "29:00");
    assert.equal(by(f, "gap"), "26:30");
  });

  it("counts people baptized, not people who testified", () => {
    // Grouped: three testimonies banked, nobody in the water yet.
    const f = baptismFigures(
      { ...base, phase: "testimony", finishedAt: null,
        people: [{ testimonyMs: 60_000, baptizeMs: 0 }, { testimonyMs: 70_000, baptizeMs: 0 },
                 { testimonyMs: 80_000, baptizeMs: 0 }] } as never,
      started + 5 * 60_000,
    );
    assert.equal(by(f, "count"), "0");
  });
});
```

- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Implement** `figures.ts`, then `header.tsx` and `timer-card.tsx`, and recompose
  `baptism-operator.tsx`.
- [ ] **Step 4: Watch them pass**, and confirm every PR 1 panel guard still passes unedited.
- [ ] **Step 5: Commit** — `feat: the Baptisms tab gets the History header, stat strip and section nav`

## Task 12: the two-lane session chart

**Files:** `renderer/settings/sections/baptisms/session-chart.tsx`,
`renderer/settings/sections/baptisms/session-lane.ts`, `session-lane.test.ts`

**Interfaces:**
- Consumes: `invoke("baptism:lane", { serviceKey })` (Task 9); `laneSegments`, `laneLabel`,
  `segmentAt`, `type LaneItem`, `type LaneSegment` and the text measurer from `../history-chart`;
  the service timeline via `invoke("serviceTimeline:get", …)` or `serviceTimeline:getCurrent` for
  the live session.
  <br>**Corrected during Task 12's build:** the tick helper is `timeTicks`, not `dateTicks`.
  `dateTicks` is anchored to local-midnight WEEK boundaries for a Trends-scale (weeks-to-years)
  domain — see its own doc comment in `history-chart/geometry.ts` — and produces zero or one tick
  for a domain measured in minutes, which is what a baptism session is. `timeTicks` is the
  clock-anchored helper History's own Attendance and Sound charts use for one service's own
  x axis, which is the same shape this chart's domain has.
- Produces: `gapSpans(spans: BaptismSpan[], windowEndIso: string): { startedAt: string; endedAt: string }[]`.

**Build what the mockup's Session card shows.** Two lanes on one x axis: *timer* on top, *plan*
beneath. Timer spans in `--color-accent` (testimony) and `--color-live-9` (baptism), labelled
with the person number when the segment fits, by the existing `laneLabel` rule. Gaps between
spans read "not counted" when wide enough, drawn exactly as the mockup's own CSS has them
(`.seg-gap`): a flat `--color-fill` wash with a dashed `--color-line-strong` border — not a
diagonal hatch texture, whatever this section's own "hatched in `--color-line`" suggested. Plan
items outlined, labelled with the item title when it fits. The legend beneath. Hover a segment
and the strip shows the person, the phase, the duration and its boundary times, the way the
attendance and sound charts do.

**Do not use `HistoryChart`.** It requires a `series[]` and a `yScale`; this chart has no y axis.
Reuse the lane GEOMETRY — map each `BaptismSpan` onto a `LaneItem` and let `laneSegments`
position it — and render your own SVG. That keeps overlap stacking, clipping and the live edge
identical to History's.

**Live, change-driven, never polled.** Refetch `baptism:lane` on each `baptism:state` push —
pushes fire on presses, about twenty a service. Between pushes the open span grows client-side
from `state.segmentStartedAt` and the app's shared `now` tick, with no fetch. While armed there is
no open span. Honour `prefers-reduced-motion`. All colour through tokens; no literals.

**Empty states, each honest:** no service open → the lane draws from the service recording and
none is open; a session with no raw rows → no timing detail was recorded for it.

- [ ] **Step 1: Failing test** — `gapSpans` covers exactly the stretches no span covers,
  including the armed stretch and a pause, and returns nothing for a continuous run.
- [ ] **Step 2: Watch it fail.**
- [ ] **Step 3: Implement** the chart.
- [ ] **Step 4: Watch it pass**, then prove the refetch is change-driven: a test that emits two
  `baptism:state` pushes and advances fake time by a minute asserts exactly two lane fetches.
- [ ] **Step 5: Commit** — `feat: the baptism session draws as a timer lane over the plan lane`

## Task 13: people, past sessions, trends

**Files:** `renderer/settings/sections/baptisms/{people-table,past-sessions,trends}.tsx`,
`renderer/settings/sections/baptisms/trends.ts`, `trends.test.ts`

**Build what the mockup shows.**

- **People** — the rundown's scale: 10px uppercase headers, 13px rows, mono tabular figures; `#`,
  Person, Testimony, Baptism, Total, and a split bar per person in the two phase colours. In
  grouped mode a person not yet baptized shows a dash under Baptism, not `0:00`.
- **Past sessions** — History list-row shape: the service and date, then Baptized, Avg testimony,
  Avg baptism, Total; each row links with `historyServiceHref` (Task 10). Keep delete, behind the
  same confirm the old panel used.
- **Trends** — four tiles: Baptized per service, Avg testimony, Avg baptism, Whole segment. Reuse
  `Sparkline` from `../history-trends/sparkline` and `TREND_WINDOW` (8) from
  `../history-trends/trends`: the last eight baptism services, and the change against the eight
  before. Whole segment is wall clock, which is what a planner budgets.

The like-for-like rule already governs History's trends (`MIN_PRIOR_DAYS`,
`COMPARABLE_ABOVE`): a partial set is not compared against a full one. Apply the same rule
rather than inventing a second.

- [ ] **Step 1: Failing tests** for `trends.ts`: eight most recent against the eight before; with
  fewer than the comparable minimum, no change figure rather than a misleading one.
- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Watch them pass.**
- [ ] **Step 5: Commit** — `feat: the Baptisms tab gets per-person splits, past sessions and trends`

## Task 14: a failed session save reaches the operator

**Files:** `main/types/baptism.ts`, `main/services/baptism-timer-service.ts`,
`renderer/settings/sections/baptisms/timer-card.tsx`, a test beside `baptism-armed.test.ts`

Ruling 15 routed this here. `finalize()` calls `baptismStore.addSession(...).catch((err) =>
console.error(...))`, so a failed write reads to the operator as a clean finish — a direct
violation of the do-not-swallow rule, on the data this whole overhaul protects.

Add `saveError?: string | null` to `BaptismState` — optional, like every field added after the
shape first shipped (`armed`, `segmentAccumMs`, `serviceKey`), so typed fixtures that predate it
need no edit. `finalize()` sets it when `addSession` rejects and commits again so the push carries
it; a later successful save or a `reset()` clears it. `start()` and `setMode()` carry it: both
rebuild the state from `idleState()`, and a plan item going live calls `start()` with nobody at
the screen, which would erase the failure before anyone saw it. The Timer card shows it plainly:
the session did not save, and its raw rows still hold it if a service was open while it ran —
rows are only written while one is. Keep the existing `[baptism-timer] session save failed:` log
line, and add it to the doc's Logging list in the same commit.

**Corrected:** the card does NOT say the session can be rebuilt. Nothing in PR 2 replays a
baptism session — Task 17 wires Rebuild from raw in PR 3 — so that sentence would send an operator
looking for a button that does not exist, the shape Ruling 35's I2 already caught in the docs.
Task 17 adds the offer.

This is the one task in this PR that edits the timer service. Rulings 44 and 46 folded two more
fixes into it, below, each its own commit. Touch nothing else in it.

- [ ] **Step 1: Failing test** — stub `addSession` to reject, finish a session, assert
  `state.saveError` is set and survives into the next push; a following successful finish clears it.
- [ ] **Step 2: Watch it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Watch it pass.**
- [ ] **Step 5: Commit** — `fix: a failed baptism save says so instead of reading as finished`.
  NO `Beta-only` trailer: the swallowing `catch` ships on `main`.

**A clock that starts writes a row (Ruling 44).** Grouped `next()` while armed starts the next
person's clock through `startSegment()` and writes no row. Emit `baptisms-start` there exactly as
`advance()`'s armed branch does: after the state moves, so the row names the person whose clock it
is — index 1, the person after the one skipped. With one person, `next()` while armed
auto-finishes and starts no clock, so it writes none. The lane's inference of that span
(`startedSilently`) is then reached by nothing the emitter writes; it stays, for files written
before the row existed, and its round trip derives the lane from real sessions with the row
stripped so it stays tested. Commit `fix: a clock started by next() while armed writes its row`,
with `Beta-only: true`: `armed` and the raw layer have never shipped on `main`.

**Undo after an early Finish (Ruling 46).** The finished-session undo branches assumed where
Finish was pressed. Grouped reopened the last person's baptism: Finish on person 1 of 3 came back
on person 3, and Finish while armed came back baptizing person 2 with person 1 skipped. The same
assumption had two more instances, fixed with them: a grouped Finish during the testimonies came
back mid-baptism, and a per-person Finish during a testimony came back with that testimony frozen
under a running baptism clock. The state alone cannot say where Finish was pressed — `finalize()`
leaves `baptismIndex`, but armed and a Finish during the testimonies finalize identically — and
rows exist only while a service is open, so `finalize()` records `finishedFrom` (`"testimony" |
"baptism" | "armed"`) and Undo reopens that: the testimony resumed from its banked time, the
baptism at the index Finish left re-timed from zero, or the armed section with no clock. The
replay learns that a per-person testimony undo straight after `finish` pops the person `finish()`
pushed; the lane learns that an undo straight after a `finish` that closed an armed section
re-arms. Commit `fix: undo after an early Finish reopens where Finish was pressed`, no `Beta-only`
trailer: the grouped branch ships on `main` with this defect.

## Task 15: docs, the deferred corrections, drive, PR

- [ ] `docs/features/scriptview-and-baptisms.md` describes the tab. Correct two claims the final
  review flagged: `baptismDefaultMode` has no UI writer and decides only a fresh data dir, so do
  not describe it as configurable; and the Logging section omits `[baptism-timer] persist
  failed:`, one of the two lines an operator most needs. (The other, `[baptism-timer] session save
  failed:`, landed with Task 14, the change that made that failure reach the screen.)
- [ ] Correct two code comments the final review flagged as wrong: the "ONE entry point" claim on
  `advance()` (the panel routes through it only while armed) and its echo in
  `docs/reference/api.md`; and `rebuild-baptism.ts`'s MODE rule, which names `reset()` clearing
  the mode as the mechanism when `reset()` preserves it — the real cause is that `setMode()`
  emits no row.
- [ ] `npm run type-check && npm run lint && npm test`, read in-session.
- [ ] **Drive the real UI at 1280 and 600 wide, light and dark**, on `STAGE_UTILITY_PORT=8799`
  with an empty data dir. Press every button. Watch the lane, the strip, the table and the trends
  respond. Kill by port.
- [ ] Three review passes, then open the PR with `--base fix/baptism-session-integrity`, answering
  both standing questions.

---

# PR 3 — History integration

Branch: `feat/baptisms-in-history`, stacked on `feat/baptisms-tab`, opened with
`--base feat/baptisms-tab`.

**Handoffs:** the lane (Task 9) and chart (Task 12) are reused, never copied. `historyServiceHref`
(Task 10) is how every link is built. Ruling 31 is binding: a rebuild must NOT merge through
`baptismStore.addSessions`, which de-duplicates on id, until Task 16 makes the ids comparable.
A session split across a mid-session `serviceKey` roll (an overrunning 9am rolling into the 11am)
writes its `start` and its `finish` into different directories and cannot be rebuilt; the replay
already reports it, and nothing here should pretend otherwise.

## Task 16: rebuilt session ids match the stored ones

**Files:** `main/services/archive/sample-archive.ts`, `main/services/baptism-timer-service.ts`,
`main/services/archive/rebuild-baptism-roundtrip.test.ts`

Ruling 31, measured: across fifty driven sessions the row's `at` ran 0–1ms behind the timer's own
stamp, and 4% of rebuilt ids did not match. Give `recordBaptism` an optional trailing
`at = new Date().toISOString()` and thread it through `emitRaw`; `start()` passes its `now`,
`finalize()` passes `finishedAt`; the other call sites stay untouched. No column changes, so no
header roll. Do NOT carry the timestamp in the free-text `detail` column.

- [ ] **Step 1: Failing test** — the round-trip suite asserts rebuilt `id`, `startedAt` and
  `finishedAt` are EQUAL to the stored ones, across many driven sessions. Watch it fail on today's
  code at a rate you can see.
- [ ] **Step 2–4:** implement, watch it pass.
- [ ] **Step 5: Commit** — `fix: a rebuilt baptism session carries the id it was stored under`,
  with `Beta-only: true` as the last paragraph: the raw layer exists only on this branch.

## Task 17: Rebuild from raw gains baptisms

**Files:** `main/services/history-edit.ts` (`rebuildServiceRecords`), `main/services/baptism-store.ts`,
`renderer/settings/sections/baptisms/header.tsx`, `renderer/settings/sections/baptisms/timer-card.tsx`,
`docs/data-archive.md`

The Timer card's save-failure note (Task 14) gains the rebuild offer it leaves out until this
action exists.

`rebuildServiceRecords` rebuilds the SPL, timeline and attendance records from raw. It gains
baptisms: read the rows, `rebuildBaptismSessions`, and REPLACE that `serviceKey`'s stored sessions
— a new `baptismStore.replaceSessionsFor(serviceKey, sessions)` — leaving every other service's
untouched. The Baptisms tab's header gains the Rebuild from raw action the mockup shows, now real.
`docs/data-archive.md`'s Rebuild-from-raw table flips baptisms to available.

- [ ] **Step 1: Failing test** — rebuilding one service's baptisms replaces its sessions and leaves
  another service's byte-identical; rebuilding an intact store changes nothing.
- [ ] **Step 2–4:** implement, watch it pass.
- [ ] **Step 5: Commit** — `feat: Rebuild from raw rebuilds a service's baptisms`

## Task 18: the Baptisms card on a service's History page

**Files:** `renderer/settings/sections/service-history-section.tsx`,
`renderer/settings/sections/history-service-header.tsx` (`SERVICE_SECTIONS`)

The card keeps its place above Attendance and Sound and stops being six flat tiles. It gets the
stat strip, the two-lane chart read-only for that service (Task 12, fed Task 9's spans for that
`serviceKey`), and the per-person splits inline. The dead-end sentence "Per-person splits are in
the Baptisms tab" goes; an "Open in Baptisms" link replaces it. The section nav gains Baptisms
when the service has any.

- [ ] **Step 1: Failing test** — a service with a linked session renders the chart and the splits
  and no dead-end sentence; a service without one renders no Baptisms card and no nav entry.
- [ ] **Step 2–4:** implement, watch it pass.
- [ ] **Step 5: Commit** — `feat: a service's History page shows its baptisms in full`

## Task 19: a service in the All-services list says it had baptisms

Unchanged from the original Task 13b, including its reasoning: **not a new column** —
`ROW_COLUMNS` prints a dash under a heading a row has nothing for, so a Baptized column would dash
out every ordinary Sunday — and **not on the calendar**, which is shaded by service count with no
dots by an earlier decision. The count joins the subtitle (`<series> · <n> items · 7 baptized`),
with a droplet badge by the title, and a service with none gains nothing at all. Use
`baptismStats(...).people`, which PR 1 corrected to count actual baptisms.

- [ ] **Step 1: Failing tests** — a row with baptisms says how many in its subtitle; a row with
  none gains no marker and no dash. Reuse the file's existing render harness.
- [ ] **Step 2–4:** implement, watch it pass; prove the second test red by making the count
  unconditional.
- [ ] **Step 5: Commit** — `feat: a History list row says how many were baptized`

## Task 20: docs, gate, drive, PR

- [ ] `docs/features/attendance-and-history.md` — the Baptisms card, the list-row count, the
  service URL.
- [ ] `npm run type-check && npm run lint && npm test`, read in-session.
- [ ] Drive it: open a service from a Baptisms past-session link, confirm it lands; rebuild a
  service's baptisms from raw; watch the card and the list row.
- [ ] Three review passes, then open the PR with `--base feat/baptisms-tab`.

---

# PR 4 — Actions, objects and Companion

Branch: `feat/baptism-actions` (this repo), then `feat/baptism-variables` in the module repo.

## Task 21: `baptism.*` automation actions

**Files:** `main/services/automation-actions.ts`, `main/services/automation-coverage.test.ts`

**Interfaces:**
- Consumes: `baptismTimerService.advance()` from Task 4.
- Produces: `baptism.start`, `baptism.advance`, `baptism.back`, `baptism.pause`, `baptism.finish` in `AUTOMATION_ACTIONS`.

- [ ] **Step 1: Failing test** — the action ids are a **sorted list, one per line**, not a count; and `baptism.advance` from `idle` starts a session.
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Implement.** `baptism.back` maps to `undo()`, `baptism.pause` toggles pause/resume. Each follows the shape of the twelve existing entries.
- [ ] **Step 4: Run it, watch it pass.**
- [ ] **Step 5: Commit** — `feat: advance and back are baptism automation actions`

## Task 22: `baptism-timer` object fields

**Files:** `main/types/views.ts`, `renderer/main/layout-renderer.tsx` (the `BaptismTimer` component), `renderer/editor/inspector.tsx`

- [ ] **Step 1: Failing test** — each new field (`testimony`, `session`, `phase`, `person`) renders its value, and `person` reads `3 of 7` in grouped mode once the testimony pass has run.
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Implement**, adding the four fields to the config union and the inspector's picker.
- [ ] **Step 4: Run it, watch it pass.**
- [ ] **Step 5: Commit** — `feat: the baptism timer object reads testimony, session, phase and person`

## Task 23: the Companion module

**Repo:** `Cornerstone-Production/companion-module-cornerstone-stageutility`. Separate branch, separate PR.

**Files:** `src/sse.ts`, `src/state.ts`, `src/variables.ts`, `src/actions.ts`, `src/feedbacks.ts`, `src/presets.ts`, `src/api.ts`

- [ ] **Step 1: Failing test** — the spec's guard: a `baptism:state` frame whose `segmentStartedAt` is in the past yields a `baptism_segment` that advances on the ticker **without a further frame**. Model it on the existing `streamElapsedSeconds` tests.
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Implement.**
  - `sse.ts`: add `'baptism:state'` to `SSE_EVENTS`.
  - `state.ts`: hold the DTO; add `baptismSegmentSeconds()` and `baptismSessionSeconds()` deriving through `serverNowMs()`, the same delivery-compensated clock `countdownSeconds()` uses.
  - `variables.ts`: the ten variables from the spec, formatted with the existing `formatDuration`.
  - `api.ts`: one method per `POST /api/baptism/<action>` endpoint, which already exist server-side.
  - `actions.ts`: Start, Advance, Mark baptized, Start baptisms, Next, Pause/resume, Undo, Finish, Reset, Set workflow.
  - `feedbacks.ts`: phase colour, paused, running.
  - `presets.ts`: the eight keys from the mockup.
- [ ] **Step 4: Run it, watch it pass.** Then drive a real stream deck against the dev server on 8799.
- [ ] **Step 5: Commit and PR** — `feat(baptism): variables, actions and feedbacks for the baptism timer`. Docs: `docs/integrations/companion.md` in the app repo, `docs/automation.md` for the actions, `docs/reference/widgets.md` for the object fields.

---

## Self-review against the spec

**Coverage.** Two bugs → Tasks 1, 2. Grouped default → Task 3. Armed → Task 4. Raw source → Task 5.
Emit calls → Task 6. Replay → Task 7. The lane's data → Task 9. The service URL → Task 10. Tab
header, figures, section nav and timer card → Task 11. Two-lane chart → Task 12. People, past
sessions, trends → Task 13. A failed save reaching the operator → Task 14. Comparable rebuilt ids →
Task 16. Rebuild from raw for baptisms → Task 17. The History card → Task 18. The list-row count →
Task 19. Automation actions → Task 21. Object fields → Task 22. Companion → Task 23. Docs land per PR
in Tasks 8, 15, 20 and 23.

**Named but deliberately deferred.** Person identity stays numeric, per the spec's closing section.
The raw rows' `reset` and `undo` detail text under-describes what happened (PR 1 review minors M1,
M2); changing emitted row content would move the replay and the lane together, so it waits for a PR
that owns both.

**Type consistency.** `advance()` is the one name used by Task 4, Task 21 and Task 23.
`rebuildBaptismSessions(rows, identity)` is pure in Task 7 and consumed that way in Task 17.
`BaptismSpan` and `baptismLaneSpans` are defined in Task 9 and consumed in Tasks 12 and 18.
`historyServiceHref` is defined in Task 10 and consumed in Tasks 13, 18 and 20. `saveError` is
defined in Task 14 and read only by the Timer card.

**Refreshed after PR 1.** PR 2 and PR 3 were rewritten against the code PR 1 left. The original
sections assumed the lane could be drawn from `BaptismState` durations, assumed History had a URL
for one service, and put Rebuild from raw in PR 2's header while the replay had no safe caller. Each
was checked against source before the rewrite.
