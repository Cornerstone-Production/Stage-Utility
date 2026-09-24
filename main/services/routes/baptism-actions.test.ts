// The `/api/baptism/` action switch in history-routes.ts — every action
// driven through the REAL route against the REAL timer, asserting the state
// the timer actually reaches. Replaces a guard that read the switch's SOURCE
// TEXT for its case labels: that guard stayed green when a route was
// replaced with a comment naming it
// (`// case "dismiss-save-error": not wired`), because a comment satisfies a
// `case "x":` regex exactly as well as real code does, and nothing sent a POST
// through the route to notice nothing answered. Pinning labels also cannot
// catch a route wired to the WRONG method — same set of case labels, same
// guard, different (broken) behavior.
//
// Preconditions are chosen so a two-way swap between any pair of actions is
// detectable from at least one side. "advance" in particular is driven from
// an ARMED state — the one branch no OTHER action's handler can reach — because
// advance() itself DELEGATES to start()/next()/baptized() at every other
// phase: tested from idle or from a running testimony, an advance<->start or
// advance<->next swap would produce the identical result and this guard would
// not notice. Both red proofs below (a handler swap, the same comment
// substitution above) confirm the design actually catches what
// it is meant to.
//
// A THIRD gap survived the first version of this file: ACTIONS/EXPECTED_ACTIONS
// were checked against each other, never against the real switch. Adding
// `case "scratch-new-untested-action":` to history-routes.ts left this
// whole file, plus route-coverage.test.ts, green — the deleted
// text-scanning guard would have caught that shape (a new `case` label), and
// the replacement lost it by only ever reading its OWN table. Closed with the
// type system, per CLAUDE.md's stated preference over a text scan: the switch
// in history-routes.ts is now over `action as BaptismAction`, exhaustive
// against the exported BAPTISM_ACTIONS array, so a `case` not in that array
// fails `tsc` at its own line and an array member with no `case` fails `tsc`
// at `default:`. This file checks the one direction `tsc` cannot: an array
// member nobody wrote a test row for.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-actions-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import type { BaptismState } from "../../types/stage.js";

const { historyRoutes, BAPTISM_ACTIONS } = await import("./history-routes.js");
const { callRoute } = await import("./route-harness.js");
const { baptismTimerService: timer } = await import("../baptism-timer-service.js");
const { baptismStore } = await import("../baptism-store.js");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type AddSession = typeof baptismStore.addSession;
/** Replace addSession for exactly the "dismiss-save-error" precondition, which
 *  needs a REAL failed save to have something to dismiss. Restored in a
 *  finally — the same pattern baptism-save-error.test.ts uses. */
function stubAddSession(impl: AddSession): () => void {
  const store = baptismStore as unknown as { addSession: AddSession };
  const original = store.addSession;
  store.addSession = impl;
  return () => {
    store.addSession = original;
  };
}

interface ActionCase {
  action: string;
  /** Bring the REAL timer to the exact state this action needs to do
   *  something observable — real service calls, never a hand-built state
   *  object, the same reason baptism-lane-route.test.ts drives real presses
   *  rather than constructing a BaptismState by hand. */
  setup: () => Promise<void> | void;
  /** Sent as the POST body, for the one action that reads one. */
  body?: Record<string, unknown>;
  /** Expected response status. Defaults to 200 — every action here reaches a
   *  handler that succeeds against the precondition `setup` built. "rebuild"
   *  is the one exception: it does not touch this timer at all (it merges a
   *  SERVICE's stored baptisms, keyed by serviceKey, not this in-memory
   *  session), so its row proves the route wiring the cheap way — a missing
   *  serviceKey, refused before rebuildServiceBaptisms ever runs — rather
   *  than standing up a real archive here on top of the extensive coverage
   *  rebuild-baptism-merge.test.ts and baptism-rebuild-route.test.ts already
   *  give the merge itself. */
  status?: number;
  /** What must be true of the TIMER'S OWN state afterward — checked against
   *  getState(), not just the response JSON, though the handlers return the
   *  same object either way; asserting against the service directly is what
   *  "asserts the service state it produces" means here. */
  check: (state: BaptismState) => void;
}

const ACTIONS: ActionCase[] = [
  {
    action: "start",
    setup: () => timer.reset(),
    check: (s) => {
      assert.equal(s.phase, "testimony");
      assert.equal(s.personNumber, 1);
    },
  },
  {
    action: "baptized",
    setup: () => {
      timer.reset();
      timer.setMode("per-person");
      timer.start();
    },
    check: (s) => assert.equal(s.phase, "baptism"),
  },
  {
    action: "start-baptisms",
    setup: () => {
      timer.reset();
      timer.setMode("grouped");
      timer.start();
    },
    check: (s) => {
      assert.equal(s.phase, "baptism");
      assert.equal(s.armed, true);
    },
  },
  {
    action: "next",
    setup: () => {
      timer.reset();
      timer.setMode("grouped");
      timer.start();
    },
    check: (s) => {
      assert.equal(s.personNumber, 2);
      assert.equal(s.people.length, 1);
    },
  },
  {
    action: "advance",
    // ARMED, not idle or testimony — see the module comment. This is the one
    // state where advance()'s own behavior (clear armed, start the clock,
    // WITHOUT touching people/baptismIndex) cannot be produced by delegating
    // to start(), next() or baptized(), all of which either no-op or do
    // something visibly different from this exact state.
    setup: () => {
      timer.reset();
      timer.setMode("grouped");
      timer.start();
      timer.startBaptisms();
    },
    check: (s) => {
      assert.equal(s.armed ?? false, false, "advance() must clear armed — the 'first person in' press");
      assert.notEqual(s.segmentStartedAt, null, "and start a real clock");
      assert.equal(s.phase, "baptism");
      assert.equal(s.baptismIndex, 0);
    },
  },
  {
    action: "undo",
    setup: () => {
      timer.reset();
      timer.setMode("per-person");
      timer.start();
      timer.baptized();
    },
    check: (s) => {
      assert.equal(s.phase, "testimony");
      assert.equal(s.pendingTestimonyMs, null);
    },
  },
  {
    action: "finish",
    setup: () => {
      timer.reset();
      timer.setMode("grouped");
      timer.start();
    },
    check: (s) => {
      assert.equal(s.phase, "idle");
      assert.ok(s.finishedAt);
      assert.equal(s.people.length, 1);
    },
  },
  {
    action: "pause",
    setup: () => {
      timer.reset();
      timer.setMode("grouped");
      timer.start();
    },
    check: (s) => {
      assert.equal(s.segmentStartedAt, null);
      assert.equal(s.phase, "testimony");
    },
  },
  {
    action: "resume",
    setup: () => {
      timer.reset();
      timer.setMode("grouped");
      timer.start();
      timer.pause();
    },
    check: (s) => assert.notEqual(s.segmentStartedAt, null),
  },
  {
    action: "reset",
    setup: () => {
      timer.reset();
      timer.setMode("grouped");
      timer.start();
    },
    check: (s) => {
      assert.equal(s.phase, "idle");
      assert.equal(s.sessionStartedAt, null);
    },
  },
  {
    action: "dismiss-save-error",
    setup: async () => {
      timer.reset();
      timer.setMode("grouped");
      timer.start();
      const restore = stubAddSession(async () => {
        throw new Error("scratch failure for the route guard's precondition");
      });
      timer.finish();
      try {
        for (let i = 0; i < 200 && !timer.getState().saveErrors?.length; i++) await sleep(5);
      } finally {
        restore();
      }
      assert.ok(timer.getState().saveErrors?.length, "sanity: the precondition failed to produce a failed save");
    },
    check: (s) => {
      assert.deepEqual(s.saveErrors ?? [], []);
    },
  },
  {
    action: "mode",
    // Forced to "grouped" first so the POST's switch to "per-person" is a real,
    // verifiable transition regardless of whatever mode an earlier row left.
    setup: () => {
      timer.reset();
      timer.setMode("grouped");
    },
    body: { mode: "per-person" },
    check: (s) => assert.equal(s.mode, "per-person"),
  },
  {
    action: "rebuild",
    // No body at all — see the ActionCase.status doc comment above for why
    // this row does not stand up a real archive to drive a genuine merge.
    setup: () => { timer.reset(); },
    status: 400,
    check: (s) => assert.equal(s.phase, "idle", "a rejected rebuild must not touch the live timer"),
  },
];

// EXACT, sorted, one entry per line — never a bare count: a count cannot tell
// an action added in one row and removed in another from no change. Checked
// against TWO things below, not one: this file's OWN table (so a row cannot
// go missing silently) AND history-routes.ts's real BAPTISM_ACTIONS export
// (so this list cannot drift from the switch it is meant to describe —
// adding a case neither this file nor route-coverage.test.ts noticed is
// exactly the gap that check exists for).
const EXPECTED_ACTIONS = [
  "advance",
  "baptized",
  "dismiss-save-error",
  "finish",
  "mode",
  "next",
  "pause",
  "rebuild",
  "reset",
  "resume",
  "start",
  "start-baptisms",
  "undo",
];

describe("POST /api/baptism/<action>", () => {
  it("drives exactly this sorted list of actions", () => {
    assert.deepEqual(ACTIONS.map((c) => c.action).sort(), EXPECTED_ACTIONS);
  });

  it("this sorted list is exactly history-routes.ts's own BAPTISM_ACTIONS", () => {
    // The `tsc` exhaustiveness check (case <-> array member, both
    // directions) lives in history-routes.ts itself. What ONLY a runtime
    // check can catch: an entry in that real array with no row in the table
    // above — reachable, wired, and untested. `tsc` cannot see a MISSING
    // test any more than the old text scan could.
    assert.deepEqual([...BAPTISM_ACTIONS].sort(), EXPECTED_ACTIONS);
  });

  for (const { action, setup, body, status = 200, check } of ACTIONS) {
    it(`/api/baptism/${action} reaches the real handler for it`, async () => {
      await setup();
      const out = await callRoute(historyRoutes, `/api/baptism/${action}`, { method: "POST", body });
      assert.equal(out.status, status, `expected ${status}, got ${out.status}: ${out.body}`);
      check(timer.getState());
      timer.reset();
    });
  }
});
