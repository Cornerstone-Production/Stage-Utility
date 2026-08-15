# Companion Signals Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An automation rule publishes a named value that a Companion Trigger acts
on, so the PCO roster can drive a Dante crosspoint without the app touching Dante.

**Architecture:** A new trigger fires N minutes before any plan time. A new action
reads the scheduled roster, finds the person whose PCO note carries a marker,
parses the slot number out of that note, maps it through an operator-typed table,
and writes a signal. Signals persist and broadcast on the SSE stream the Companion
module already consumes; the module exposes them as variables and feedbacks.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node built-in test
runner via `npx tsx --test`. Module work is a second repo
(`companion-module-cornerstone-stageutility`).

## Global Constraints

- Node >= 24, TypeScript strict, ESM with `.js` specifiers even for `.ts` sources.
- No new runtime dependencies.
- Never use emojis in code, UI, comments, or commit messages.
- **`didFire` MUST return false when `prev` is null.** Asserted registry-wide by
  `automation-triggers.test.ts`; a new trigger is covered automatically.
- **A trigger must never throw.** The malformed-payload sweep iterates the whole
  registry.
- Fire on the EDGE, never the level.
- **The app never contacts Dante, and never presses a Companion button.** It
  publishes state only.
- **Never blank a signal.** Every failure holds the previous value.
- Numeric form fields use the themed `NumberInput`, never a raw `<input type="number">`.
- A new persisted store must appear in `CONFIG_FILES` or `RUNTIME_FILES` in the
  same change, or the config-snapshot drift test fails.
- Run `npm run type-check && npm run lint && npm test` before every commit. One
  pre-existing lint warning in `renderer/settings/sections/patch-import.tsx` is not
  yours.
- Conventional Commits. No AI attribution, no session links.
- Branch `feat/companion-signals`, off `beta`. PR, do not push to beta directly.

## Decisions already made

- **The marker lives on the PERSON's PCO note.** Slots are not consulted at all —
  no `slot-resolver`, no `slots.json`. The slot number is parsed from the note.
- **`rows` is an operator-typed lookup table**, not a template. Dante names may
  carry numeric prefixes (`31.Vox 3`) or be renamed at will.
- **The Companion action is absolute**, so re-firing is a no-op. Companion
  re-fires its Trigger on module reconnect, which is accepted and desirable: an app
  restart re-asserts the routing.
- Failure is always "do nothing and hold".

---

## File structure

| File | Responsibility |
|---|---|
| `main/types/stage.ts` (modify) | `planTimes` on `PcoLiveDTO`; `SignalState`. |
| `main/services/pco-service.ts` (modify) | Populate `planTimes` from the cached plan times. |
| `main/services/automation-plan-times.ts` (create) | Pure: which plan time is due in a window. |
| `main/services/automation-plan-times.test.ts` (create) | Window edges, restart guard, type filter. |
| `main/services/automation-triggers.ts` (modify) | `pco.before-plan-time`. |
| `main/services/automation-roster-match.ts` (create) | Pure: notes -> marker match + slot number. |
| `main/services/automation-roster-match.test.ts` (create) | The parsing rules and every failure case. |
| `main/services/signal-store.ts` (create) | Persist + broadcast signals. |
| `main/services/automation-actions.ts` (modify) | `companion.signal-from-roster`. |
| `main/types/automation.ts` (modify) | `key-value` ParamDef type. |
| `renderer/settings/sections/automation-section.tsx` (modify) | Render a key-value param. |
| `main/services/config-snapshot.ts` (modify) | `signals.json` -> `RUNTIME_FILES`. |
| `main/services/remote-server.ts` (modify) | Hello-burst `companion:signals`. |
| `docs/automation.md`, `docs/integrations/companion.md` (modify) | Document it. |

---

### Task 1: Plan times on the live payload

**Files:** `main/types/stage.ts`, `main/services/pco-service.ts`

**Interfaces:** Produces `PcoLiveDTO.planTimes`.

- [ ] **Step 1: Add the field**

```ts
/** Every rehearsal + service time on the active plan, for time-relative triggers.
 *  Sourced from the already-cached plan times, so it costs no extra request. */
planTimes?: { id: string; name: string | null; timeType: string; startsAt: string }[];
```

- [ ] **Step 2: Populate it in `getLive`**

`planTimes` is already fetched above the item-mode branch. Map it once and include
it in all three returns (`item`, `preservice`, `none`) — a trigger that only works
while a service is live would never fire an hour before rehearsal.

```ts
const planTimesDto = planTimes
  .filter((t) => t.timeType === "service" || t.timeType === "rehearsal")
  .map((t) => ({ id: t.id, name: t.name, timeType: t.timeType, startsAt: t.startsAt }));
```

- [ ] **Step 3: Keep it out of the broadcast signature churn**

`liveSignature` in `live-poller.ts` already lists what clients react to. Add
`l.planTimes` — it changes only when the plan or its times change, so it will not
increase broadcast volume, and omitting it would let a stale copy arm the trigger
against last week's times.

- [ ] **Step 4: Verify**

`npm run type-check && npm test`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(pco): carry the plan's rehearsal and service times on the live payload"
```

---

### Task 2: The `pco.before-plan-time` trigger

**Files:** `main/services/automation-plan-times.ts` (create), its test,
`main/services/automation-triggers.ts`

**Interfaces:** Produces `planTimeDueIn(times, fromMs, toMs, leadMinutes, types)`
and the trigger `pco.before-plan-time`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planTimeDueIn } from "./automation-plan-times.js";

const T = (startsAt: string, timeType = "service") => ({ id: startsAt, name: null, timeType, startsAt });
const at = (iso: string) => Date.parse(iso);

describe("planTimeDueIn", () => {
  const times = [T("2026-08-09T14:30:00Z"), T("2026-08-08T23:00:00Z", "rehearsal")];

  it("fires in the window containing lead-time-before the plan time", () => {
    // 60 min before 14:30 is 13:30.
    const hit = planTimeDueIn(times, at("2026-08-09T13:29:55Z"), at("2026-08-09T13:30:05Z"), 60, ["service"]);
    assert.equal(hit?.startsAt, "2026-08-09T14:30:00Z");
  });

  it("does not fire in the window before, or the window after", () => {
    assert.equal(planTimeDueIn(times, at("2026-08-09T13:29:00Z"), at("2026-08-09T13:29:50Z"), 60, ["service"]), null);
    assert.equal(planTimeDueIn(times, at("2026-08-09T13:30:10Z"), at("2026-08-09T13:31:00Z"), 60, ["service"]), null);
  });

  it("is half-open so two adjacent windows cannot both fire", () => {
    const boundary = at("2026-08-09T13:30:00Z");
    const a = planTimeDueIn(times, boundary - 1000, boundary, 60, ["service"]);
    const b = planTimeDueIn(times, boundary, boundary + 1000, 60, ["service"]);
    assert.ok((a === null) !== (b === null), "exactly one of the adjacent windows fires");
  });

  it("honours the time-type filter", () => {
    assert.equal(planTimeDueIn(times, at("2026-08-08T21:59:55Z"), at("2026-08-08T22:00:05Z"), 60, ["service"]), null);
    assert.ok(planTimeDueIn(times, at("2026-08-08T21:59:55Z"), at("2026-08-08T22:00:05Z"), 60, ["rehearsal"]));
  });

  it("fires for each time on the plan, not just the first", () => {
    assert.ok(planTimeDueIn(times, at("2026-08-08T21:59:55Z"), at("2026-08-08T22:00:05Z"), 60, ["rehearsal", "service"]));
    assert.ok(planTimeDueIn(times, at("2026-08-09T13:29:55Z"), at("2026-08-09T13:30:05Z"), 60, ["rehearsal", "service"]));
  });

  it("ignores unparseable or absent times rather than throwing", () => {
    assert.equal(planTimeDueIn([T("nonsense")], 0, 1, 60, ["service"]), null);
    assert.equal(planTimeDueIn([], 0, 1, 60, ["service"]), null);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

`npx tsx --test main/services/automation-plan-times.test.ts`

- [ ] **Step 3: Implement**

```ts
// automation-plan-times.ts — which plan time falls due in a tick's window.
//
// PURE. The live poller's serverNow values form contiguous, non-overlapping
// windows, so a half-open (from, to] test fires exactly once per plan time with no
// stored state — the same technique pco.item-due uses.

export interface PlanTimeLike {
  id: string;
  name: string | null;
  timeType: string;
  startsAt: string;
}

export function planTimeDueIn(
  times: PlanTimeLike[],
  fromMs: number,
  toMs: number,
  leadMinutes: number,
  timeTypes: string[],
): PlanTimeLike | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  const lead = Number(leadMinutes);
  if (!Number.isFinite(lead)) return null;
  const wanted = new Set(timeTypes.map((t) => t.trim().toLowerCase()).filter(Boolean));

  for (const t of times) {
    if (wanted.size > 0 && !wanted.has((t.timeType ?? "").toLowerCase())) continue;
    const start = Date.parse(t.startsAt ?? "");
    if (!Number.isFinite(start)) continue;
    const due = start - lead * 60_000;
    if (due > fromMs && due <= toMs) return t;
  }
  return null;
}
```

- [ ] **Step 4: Register the trigger**

In `automation-triggers.ts`:

```ts
  "pco.before-plan-time": def({
    id: "pco.before-plan-time",
    label: "Before a rehearsal or service",
    channel: "pco:live",
    params: [
      { key: "minutes", label: "Minutes before", type: "number", min: 1, max: 1440,
        help: "Keep this inside the reconnect lead time (Advanced) or the gear may still be off." },
      { key: "timeTypes", label: "Applies to", type: "multi-enum",
        options: [
          { value: "rehearsal", label: "Rehearsal" },
          { value: "service", label: "Service" },
        ] },
    ],
    help: "Fires before EVERY matching time on the plan, so a roster change after rehearsal still takes effect.",
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const from = Date.parse(asLive(prev).serverNow ?? "");
      const to = Date.parse(asLive(next).serverNow ?? "");
      const raw = String(params.timeTypes ?? "").trim();
      const types = raw ? raw.split(",").map((s) => s.trim()) : ["rehearsal", "service"];
      return planTimeDueIn(planTimesOf(next), from, to, Number(params.minutes), types) !== null;
    },
  }),
```

with

```ts
function planTimesOf(v: unknown): PlanTimeLike[] {
  const p = v && typeof v === "object" ? (v as { planTimes?: unknown }).planTimes : null;
  return Array.isArray(p) ? (p as PlanTimeLike[]) : [];
}
```

`asLive` already exists and already exposes `serverNow`.

- [ ] **Step 5: Run everything**

`npm test` — the registry-wide restart-guard and malformed-payload sweeps now
cover the new entry.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(automation): trigger a set time before a rehearsal or service"
```

---

### Task 3: Roster matching

**Files:** `main/services/automation-roster-match.ts` (create), its test

**Interfaces:** Produces `matchRoster(members, { marker, position })` returning
`{ ok: true; slot: number; member } | { ok: false; reason }`.

**No slot resolution.** The number comes from the person's own note. Parsing the
leading integer as a token also avoids the `startsWith` bug where `"1"` matches
`"10"`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchRoster } from "./automation-roster-match.js";

const m = (name: string, notes: string | null, teamPositionName = "Vocals") =>
  ({ id: name, name, personId: name, photoUrl: null, teamPositionName, teamName: "Band", status: "C", notes });

describe("matchRoster", () => {
  const opts = { marker: "TB", position: "Vocals" };

  it("matches the one person whose note carries the marker", () => {
    const r = matchRoster([m("A", "1"), m("B", "4 TB"), m("C", "2")], opts);
    assert.deepEqual(r.ok && { slot: r.slot, who: r.member.name }, { slot: 4, who: "B" });
  });

  it("is case-insensitive and tolerates where the marker sits", () => {
    for (const note of ["4 tb", "tb 4", "4 - TB", "4TB"]) {
      const r = matchRoster([m("B", note)], opts);
      assert.ok(r.ok, `should match ${note}`);
      assert.equal(r.slot, 4);
    }
  });

  it("does not treat TBD as the TB marker", () => {
    // Whole-word matching. "TBD" in a note is a scheduling comment, not talkback.
    assert.equal(matchRoster([m("B", "4 TBD")], opts).ok, false);
  });

  it("reads 10 as ten, not as one", () => {
    const r = matchRoster([m("B", "10 TB")], opts);
    assert.ok(r.ok);
    assert.equal(r.slot, 10);
  });

  it("refuses when two people carry the marker", () => {
    const r = matchRoster([m("A", "1 TB"), m("B", "4 TB")], opts);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /two|multiple/i);
  });

  it("refuses when nobody carries it", () => {
    assert.equal(matchRoster([m("A", "1"), m("B", "2")], opts).ok, false);
  });

  it("refuses when the marked note has no number", () => {
    assert.equal(matchRoster([m("B", "TB")], opts).ok, false);
  });

  it("applies the position filter, and skips it when blank", () => {
    const roster = [m("B", "4 TB", "Guitar")];
    assert.equal(matchRoster(roster, { marker: "TB", position: "Vocals" }).ok, false);
    assert.ok(matchRoster(roster, { marker: "TB", position: "" }).ok);
  });

  it("ignores people with no notes rather than throwing", () => {
    assert.equal(matchRoster([m("A", null)], opts).ok, false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

```ts
// automation-roster-match.ts — find the one scheduled person carrying a marker.
//
// PURE. Reads ONLY the PCO note on each scheduled member: no slots, no
// slot-resolver, no slots.json. The number an operator types in the note IS the
// slot, and parsing it as a whole token means "10 TB" reads as ten rather than as
// one — the prefix ambiguity slot-resolver still has.
//
// Refuses on anything ambiguous. The caller holds the previous value on refusal,
// because a scheduling mistake must not take a live route away.

import type { TeamMemberDTO } from "../types/stage.js";

export type RosterMatch =
  | { ok: true; slot: number; member: TeamMemberDTO }
  | { ok: false; reason: string };

/** Whole-word, case-insensitive. "TB" must not match "TBD". */
function hasMarker(notes: string, marker: string): boolean {
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(notes);
}

/** The first standalone integer in the note. */
function slotOf(notes: string): number | null {
  const m = /(^|[^0-9])(\d{1,2})([^0-9]|$)/.exec(notes);
  const n = m ? Number(m[2]) : NaN;
  return Number.isInteger(n) ? n : null;
}

export function matchRoster(
  members: TeamMemberDTO[],
  opts: { marker: string; position?: string },
): RosterMatch {
  const marker = (opts.marker ?? "").trim();
  if (!marker) return { ok: false, reason: "no marker configured" };
  const position = (opts.position ?? "").trim().toLowerCase();

  const hits = (members ?? []).filter((mem) => {
    const notes = (mem?.notes ?? "").trim();
    if (!notes || !hasMarker(notes, marker)) return false;
    if (position && (mem.teamPositionName ?? "").trim().toLowerCase() !== position) return false;
    return true;
  });

  if (hits.length === 0) return { ok: false, reason: `nobody scheduled is marked "${marker}"` };
  if (hits.length > 1) {
    const who = hits.map((h) => h.name).join(", ");
    return { ok: false, reason: `two or more people are marked "${marker}": ${who}` };
  }

  const slot = slotOf((hits[0].notes ?? "").trim());
  if (slot === null) return { ok: false, reason: `${hits[0].name} is marked "${marker}" but their note has no number` };
  return { ok: true, slot, member: hits[0] };
}
```

- [ ] **Step 4: Run and commit**

```bash
npm test
git commit -m "feat(automation): match the scheduled person carrying a note marker"
```

---

### Task 4: The signal store

**Files:** `main/services/signal-store.ts` (create), `main/types/stage.ts`,
`main/services/config-snapshot.ts`, `main/services/remote-server.ts`

**Interfaces:** Produces `signalStore.set(name, value, meta)`,
`signalStore.fail(name, reason)`, `signalStore.all()`.

- [ ] **Step 1: Add the type**

```ts
/** One published Companion signal. `error` is the last failed evaluation, kept
 *  alongside the value rather than replacing it — a failure never clears a route. */
export interface SignalState {
  value: string;
  at: string;
  ruleId: string | null;
  error: string | null;
}
```

- [ ] **Step 2: Implement the store**

Use `DataStore<Record<string, SignalState>>("signals.json", {})`, and broadcast
`companion:signals` with the whole map on every change (it is tiny).

`set` writes value + clears error. `fail` sets error and **leaves `value`
untouched**.

- [ ] **Step 3: Register it as runtime data**

Add `"signals.json"` to **`RUNTIME_FILES`** in `config-snapshot.ts` with a comment
saying why it is not config: it is derived from the roster, and restoring it onto
another machine would assert a routing that machine never computed. The drift test
fails if a store appears in neither list.

- [ ] **Step 4: Hydrate reconnecting clients**

In `remote-server.ts`'s hello burst, beside the other snapshots:

```ts
sseWrite(res, "companion:signals", signalStore.all());
```

Without this a module that reconnects has blank variables until the next
evaluation — hours, possibly days.

- [ ] **Step 5: Test**

Cover: `fail` does not clear a value; `set` clears a previous error; the store
round-trips through a restart.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(companion): persist and broadcast named signals"
```

---

### Task 5: The action

**Files:** `main/services/automation-actions.ts`, `main/types/automation.ts`

**Interfaces:** Produces action `companion.signal-from-roster`.

- [ ] **Step 1: Add the `key-value` param type**

`rows` is a table of slot number -> exact Dante name. `ParamDef.type` gains
`"key-value"`, with `keyLabel` / `valueLabel` for the column headings. Stored as a
JSON object string so the existing `Record<string, string | number>` param shape is
unchanged.

- [ ] **Step 2: Implement**

```ts
  "companion.signal-from-roster": {
    id: "companion.signal-from-roster",
    label: "Set a Companion signal from the roster",
    params: [
      { key: "signal", label: "Signal name", type: "string", help: 'Companion reads $(stage:signal_<name>)' },
      { key: "marker", label: "Marker in notes", type: "string", help: 'e.g. TB. Whole word, case-insensitive.' },
      { key: "position", label: "Only this position", type: "string", optional: true },
      { key: "rows", label: "Slot to send", type: "key-value", keyLabel: "Slot", valueLabel: "Send exactly" },
    ],
    help: "Publishes a value for Companion to act on. Never contacts Dante, and holds the previous value on any failure.",
    run: async (params, ctx) => {
      const signal = String(params.signal ?? "").trim();
      if (!signal) return { ok: false, detail: "no signal name configured" };

      const match = matchRoster(stageController.getTeamMembers(), {
        marker: String(params.marker ?? ""),
        position: String(params.position ?? ""),
      });
      if (!match.ok) {
        // Hold the previous value. A scheduling mistake must not drop a live route.
        if (!ctx.simulate) await signalStore.fail(signal, match.reason);
        return { ok: false, detail: match.reason };
      }

      const rows = parseRows(params.rows);
      const value = rows[String(match.slot)];
      if (!value) {
        const reason = `slot ${match.slot} has no entry in the table`;
        if (!ctx.simulate) await signalStore.fail(signal, reason);
        return { ok: false, detail: reason };
      }

      const detail = `${signal} = "${value}" (${match.member.name}, slot ${match.slot})`;
      if (ctx.simulate) return { ok: true, detail: `SIMULATED ${detail}` };
      await signalStore.set(signal, value, { ruleId: null });
      return { ok: true, detail };
    },
  },
```

`stageController` needs a `getTeamMembers()` accessor; the field exists privately.

- [ ] **Step 3: Test**

Cover: publishes on a clean match; holds on no-match; holds on multi-match; holds
on a missing row; respects simulate (writes nothing); never throws.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(automation): publish a Companion signal from the scheduled roster"
```

---

### Task 6: The key-value editor

**Files:** `renderer/settings/sections/automation-section.tsx`

- [ ] **Step 1: Render it**

Rows of `NumberInput` (slot) beside `Input` (exact text), with add/remove. Numeric
field must be the themed `NumberInput`.

- [ ] **Step 2: Manual check**

Build a rule end to end in the UI, save, reload, confirm the table survives.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(automation): edit key-value action parameters"
```

---

### Task 7: The Companion module (separate repo)

**Files:** `src/variables.ts`, `src/feedbacks.ts`, `src/sse.ts`, `src/state.ts`

- [ ] Consume `companion:signals`, keep the map in state.
- [ ] Publish `signal_<name>` variables, following the existing definitions shape.
- [ ] Feedback `signal_is` (name, value) — style when equal.
- [ ] Feedback `signal_error` (name) — style when the last evaluation failed. This
      is the only way an operator learns nobody was marked, or two people were.
- [ ] Bump the module version; note it is sideloaded, so rollback is manual.

---

### Task 8: Docs

**Files:** `docs/automation.md`, `docs/integrations/companion.md`

- [ ] Trigger and action rows in the `docs/automation.md` tables.
- [ ] A "Signals" section in `docs/integrations/companion.md` covering the flow,
      the worked `dante-tb` example with the Companion Trigger, and the two things
      that bite: a name typed wrong in the table fails silently at the crosspoint
      (test each row once), and the app never validates against Dante.
- [ ] State that a failure holds the previous value and never clears a route.

```bash
npm run type-check && npm run lint && npm test
git commit -m "docs(companion): document roster-driven signals"
```

---

## Self-review

**Spec coverage.** Marker on the person -> Task 3. No slot involvement -> Task 3
reads notes only. Trigger before rehearsal and service -> Tasks 1-2. Operator-typed
names -> Tasks 5-6. Hold on stale/multi/missing -> Tasks 4-5. Log everything ->
existing automation log plus `signal_error`. Refire on reconnect -> Task 4 step 4,
accepted deliberately.

**Type consistency.** `PlanTimeLike`, `RosterMatch`, `SignalState`, `matchRoster`,
`planTimeDueIn`, `signalStore` are defined in Tasks 1-4 and used under those names
after.

**Not built here.** Any Dante contact. Any button press. Validation that a name
exists in Dante. The `slot-resolver` `startsWith` fix (out of scope, would change
live slot assignment). Persisting `oncePerService` (real but separate).

**Risk.** The riskiest task is 7: it lands in a sideloaded repo where rollback is
manual. Land Tasks 1-6 first and confirm signals appear on the SSE stream before
touching the module.
