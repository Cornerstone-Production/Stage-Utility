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

Branch: `feat/baptisms-tab`. Depends on PR 1's `armed` field.

## Task 9: split the operator panel and add the header

**Files:**
- Create: `renderer/settings/sections/baptisms/figures.ts`, `header.tsx`
- Modify: `renderer/main/baptism-operator.tsx` (extract the timer block, keep the panel)

**Interfaces:**
- Produces: `baptismFigures(state: BaptismState | null, sessions: BaptismSession[], now: number): StatFigure[]`; `<BaptismsHeader state figures onCopy onExport onRebuild />`.

- [ ] **Step 1: Write the failing test** — `renderer/settings/sections/baptisms/figures.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baptismFigures } from "./figures.js";

describe("baptismFigures", () => {
  it("keeps wall clock and timed apart", () => {
    // Grouped here means a long uncounted transition between the testimonies and
    // the songs. Folding the two into one "total" would be a number that means
    // neither thing.
    const started = Date.UTC(2026, 8, 27, 11, 0, 0);
    const state = {
      mode: "grouped", phase: "idle", armed: false,
      sessionStartedAt: new Date(started).toISOString(),
      finishedAt: new Date(started + 29 * 60_000).toISOString(),
      people: [{ testimonyMs: 108_000, baptizeMs: 42_000 }],
      personNumber: 1, baptismIndex: 0, segmentStartedAt: null,
      pendingTestimonyMs: null, serviceTitle: null, serviceTypeId: null, planId: null,
    } as never;

    const f = baptismFigures(state, [], started + 29 * 60_000);
    const by = (k: string) => f.find((x) => x.key === k)?.value;

    assert.equal(by("timed"), "2:30", "the sum of banked segments");
    assert.equal(by("wall"), "29:00", "start to finish");
    assert.equal(by("gap"), "26:30", "the difference, named as not counted");
  });
});
```

- [ ] **Step 2: Run it, watch it fail** (module not found).
- [ ] **Step 3: Implement** `figures.ts` returning `StatFigure[]` with keys `count`, `timed`, `wall`, `gap`, `avgTestimony`, `avgBaptism`, using `fmtClock` from `use-baptism-state` and `segmentElapsedMs` from `@main/services/baptism-elapsed`. Then `header.tsx` composing `StatStrip` from `../history-chart`, the `RecordingPill` from `../history-service-header`, the action group, and the section nav.
- [ ] **Step 4: Run it, watch it pass.**
- [ ] **Step 5: Commit** — `feat: the Baptisms tab gets the History header and stat strip`

## Task 10: the two-lane session chart

**Files:**
- Create: `renderer/settings/sections/baptisms/session-lane.ts`, `session-chart.tsx`, `session-lane.test.ts`

**Interfaces:**
- Consumes: `laneSegments`, `laneLabel`, `segmentAt`, `type LaneItem` from `../history-chart`.
- Produces: `baptismLaneSegments(state, sessions, window): LaneSegment[]`; `gapSegments(segs: LaneSegment[]): LaneSegment[]`.

- [ ] **Step 1: Write the failing test** — the spec's guard: *the lane's gap segments cover exactly the stretches no person was timed for*.

```ts
describe("gapSegments", () => {
  it("covers exactly the stretches nobody was timed for", () => {
    const segs = [
      { from: 0,     to: 108_000, kind: "testimony", person: 1 },
      { from: 420_000, to: 462_000, kind: "baptism",  person: 1 },
    ] as never[];
    const gaps = gapSegments(segs);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].from, 108_000);
    assert.equal(gaps[0].to, 420_000);
  });

  it("finds no gap in a continuous run", () => {
    const segs = [
      { from: 0, to: 100, kind: "testimony", person: 1 },
      { from: 100, to: 200, kind: "baptism", person: 1 },
    ] as never[];
    assert.deepEqual(gapSegments(segs), []);
  });
});
```

- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Implement.** The chart renders two lanes on one x axis: *timer* (testimony `--color-accent`, baptism `--color-live-9`, gaps hatched in `--color-line`, person number by the existing `laneLabel` fit rule) and *plan* (the service timeline's items, outlined). Hover puts `StripHover` on the strip. Live growth appends off `baptism:state` without rebuilding the path, honouring `prefers-reduced-motion`. All colour through tokens; no literals.
- [ ] **Step 4: Run it, watch it pass.**
- [ ] **Step 5: Commit** — `feat: the baptism session draws as a timer lane over the plan lane`

## Task 11: people table, past sessions, trends

**Files:** `renderer/settings/sections/baptisms/{people-table,past-sessions,trends}.tsx` + `trends.test.ts`

- [ ] **Step 1: Failing test** for the trends derivation: eight most recent baptism services, average, and change against the eight before; a partial set must not compare against a full one.
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Implement.** People table on the rundown's scale (10px uppercase headers, 13px rows, mono tabular) with a per-person split bar. Past sessions as History-shaped list rows linking to the service page. Trends: four sparkline tiles (Baptized per service, Avg testimony, Avg baptism, Whole segment).
- [ ] **Step 4: Run it, watch it pass.**
- [ ] **Step 5: Commit** — `feat: the Baptisms tab gets per-person splits, past sessions and trends`

## Task 12: PR 2 docs, gate and PR

- [ ] Docs: `docs/features/scriptview-and-baptisms.md` describes the tab.
- [ ] `npm run type-check && npm run lint && npm test`, read in-session.
- [ ] **Drive the real UI at 1280 and 600 wide, light and dark.** A control that renders is not a control that does anything — press every button and watch the lane, the strip and the table respond.
- [ ] Three review passes, then open the PR with both standing questions answered.

---

# PR 3 — History integration

Branch: `feat/baptisms-in-history`.

## Task 13: the Baptisms card, cross-links and rebuild

**Files:** `renderer/settings/sections/service-history-section.tsx`, `renderer/lib/link-baptisms.ts`, `main/services/history-edit.ts`, `main/services/history-export.ts`

- [ ] **Step 1: Failing test** — rebuilding a service's baptisms from raw replaces the stored sessions for that `serviceKey` and leaves every other service's untouched.
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Implement.** The card gets the stat strip, the read-only two-lane chart and the splits inline. The dead-end sentence is replaced by a link to the Baptisms tab, and the tab's rows link back. `rebuildServiceRecords` gains baptisms via `readBaptismRows` + `rebuildBaptismSessions`. The `baptisms` export sheet picks up the new fields.
- [ ] **Step 4: Run it, watch it pass.**
- [ ] **Step 5: Commit** — `feat: a service's History page shows its baptisms in full`

## Task 13b: a service in the All-services list says it had baptisms

**Files:** `renderer/settings/sections/service-history-section.tsx`, `renderer/settings/sections/history-list-rows.test.tsx`

**Interfaces:**
- Consumes: `linkBaptisms(all, timeline)`, `baptismStats(sessions)` from `renderer/lib/link-baptisms.ts`.

**Not a new column.** `ROW_COLUMNS` is a fixed track list, and the row renderer
deliberately prints a dash under a heading a row has nothing for rather than
closing the gap and sliding the rest left. A `Baptized` column would therefore
put a dash on every ordinary Sunday, which is nearly all of them, to serve the
two or three a year that have one. The count goes where the row already carries
optional facts instead.

**Not on the calendar either.** The History calendar is shaded by service count
with no dots and no counts, by an explicit earlier decision. A baptism dot would
reopen it.

- [ ] **Step 1: Write the failing test**

Append to `renderer/settings/sections/history-list-rows.test.tsx`:

```tsx
describe("a row for a service with baptisms", () => {
  it("says how many were baptized, in the line that already carries the series", () => {
    // The subtitle is "<series> · <n> items". A baptism is the rarest and most
    // notable thing a Sunday can carry, and the row is where someone scanning
    // the month would look for it.
    const row = renderRow({ serviceKey: "st1:p1:t1", baptized: 7 });
    assert.match(row.subtitle, /7 baptized/);
  });

  it("says nothing at all on a service that had none", () => {
    const row = renderRow({ serviceKey: "st1:p2:t1", baptized: 0 });
    assert.doesNotMatch(row.subtitle, /baptized/);
    assert.doesNotMatch(row.subtitle, /—/, "an ordinary Sunday gains no empty marker");
  });
});
```

Match the file's existing render helper rather than inventing `renderRow` — read
the neighbouring tests and reuse their harness.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- --test-name-pattern="a row for a service with baptisms"`
Expected: FAIL — the subtitle is `<series> · <n> items` with no baptism count.

- [ ] **Step 3: Implement**

Compute per row from the sessions already loaded for the list, and extend the
existing `under` line:

```tsx
            const bapCount = baptismStats(linkBaptisms(baptisms, s)).people;
            // Appended to the line that already carries the series and the item
            // count, NOT given a column: see ROW_COLUMNS, where a row with
            // nothing for a column prints a dash. Most Sundays have no baptisms,
            // and a column of dashes to serve three services a year is a worse
            // row for everyone.
            const under = [s.seriesTitle, itemCount, bapCount ? `${bapCount} baptized` : null]
              .filter(Boolean)
              .join(" · ");
```

Add a droplet badge beside the title on rows where `bapCount > 0`, using the
`DropletIcon` the operator panel already uses and `--color-accent`, so the row
reads at a glance without the reader parsing the subtitle.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- --test-name-pattern="a row for a service"` → PASS
Prove the guard: make the count unconditional and watch the second test fail.

- [ ] **Step 5: Commit**

```bash
git add renderer/settings/sections/service-history-section.tsx renderer/settings/sections/history-list-rows.test.tsx
git commit -m "feat: a History list row says how many were baptized"
```

- [ ] Docs `docs/features/attendance-and-history.md`; gate; drive it; three passes; PR.

---

# PR 4 — Actions, objects and Companion

Branch: `feat/baptism-actions` (this repo), then `feat/baptism-variables` in the module repo.

## Task 14: `baptism.*` automation actions

**Files:** `main/services/automation-actions.ts`, `main/services/automation-coverage.test.ts`

**Interfaces:**
- Consumes: `baptismTimerService.advance()` from Task 4.
- Produces: `baptism.start`, `baptism.advance`, `baptism.back`, `baptism.pause`, `baptism.finish` in `AUTOMATION_ACTIONS`.

- [ ] **Step 1: Failing test** — the action ids are a **sorted list, one per line**, not a count; and `baptism.advance` from `idle` starts a session.
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Implement.** `baptism.back` maps to `undo()`, `baptism.pause` toggles pause/resume. Each follows the shape of the twelve existing entries.
- [ ] **Step 4: Run it, watch it pass.**
- [ ] **Step 5: Commit** — `feat: advance and back are baptism automation actions`

## Task 15: `baptism-timer` object fields

**Files:** `main/types/views.ts`, `renderer/main/layout-renderer.tsx` (the `BaptismTimer` component), `renderer/editor/inspector.tsx`

- [ ] **Step 1: Failing test** — each new field (`testimony`, `session`, `phase`, `person`) renders its value, and `person` reads `3 of 7` in grouped mode once the testimony pass has run.
- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Implement**, adding the four fields to the config union and the inspector's picker.
- [ ] **Step 4: Run it, watch it pass.**
- [ ] **Step 5: Commit** — `feat: the baptism timer object reads testimony, session, phase and person`

## Task 16: the Companion module

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

**Coverage.** Two bugs → Tasks 1, 2. Grouped default → Task 3. Armed → Task 4. Raw source → Task 5. Emit calls → Task 6. Rebuild → Task 7. Tab header/figures → Task 9. Two-lane chart → Task 10. People/past/trends → Task 11. History card, cross-links, rebuild, export → Task 13; the list row's baptism count → Task 13b. Automation actions → Task 14. Object fields → Task 15. Companion → Task 16. Logging lands in Tasks 2 and 6. Docs land per PR in Tasks 8, 12, 13, 16.

**Named but deliberately deferred.** Person identity stays numeric, per the spec's closing section.

**Type consistency.** `advance()` is the one name used by Task 4 (service), Task 4 Step 5 (route + `renderer/lib/api.ts`), Task 14 (`baptism.advance`) and Task 16 (Companion). `rebuildBaptismSessions(rows, identity)` is pure in Task 7 and consumed that way in Task 13. `ARCHIVE_SOURCES` is the exported name in Tasks 5 and 7. `BaptismRawFields` is defined in Task 5 and consumed in Task 6.

**One open verification, flagged for the implementer.** Task 6 Step 2 derives `serviceDate` by splitting the service key as a fallback. Confirm `serviceTimelineRecorder.getCurrent()?.serviceDate` first and prefer it — the other recorders read the field rather than parsing the key, and this plan should not be the one place that parses.
