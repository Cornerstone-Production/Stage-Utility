// The MEDIUM cache tier tightens inside a service window.
//
// Three minutes is the right hold for plan content most of the week and too long
// for the hours either side of a service, which is exactly when someone is
// editing the plan and a stage display is showing the result. Inside a
// serviceWindow the tier drops to 45s.
//
// Two properties are load-bearing and both are tested:
//
//  1. BOTH SIDES. A test that only pinned the fast path would stay green if the
//     window check were deleted outright and every install re-pulled plan content
//     every 45 seconds, forever, against a rate-limited API.
//
//  2. READ TIME, not write time. The TTL is resolved when an entry is read, so a
//     window opening AFTER the entry was written still shortens it. Stamping an
//     absolute expiry at write time instead would leave an entry written moments
//     before the window opened holding its full three minutes inside the window —
//     the tightening would only take effect once the entry it was meant to
//     shorten had already expired on its own.
//
// These drive the real cache through the real client with a stubbed fetch and a
// stubbed clock. getLive() is deliberately UNCACHED and is not touched here.

import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";

import { pcoService } from "./pco-service.js";
import { serviceWindow, DEFAULT_RECONNECT_SCHEDULE } from "./service-window.js";

const SEC = 1000;
const MIN = 60 * SEC;

/** A fixed instant to hang the fake clock off. Any value; nothing depends on it. */
const T0 = Date.parse("2026-03-01T14:00:00.000Z");

let now = T0;
let fetches = 0;
const realFetch = globalThis.fetch;
const realNow = Date.now;

/** Put "now" inside a service window, or well outside every one. */
function inWindow(yes: boolean): void {
  serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
  serviceWindow.setWindows(
    yes
      ? [{ open: now - 30 * MIN, close: now + 4 * 60 * MIN }]
      : [{ open: now + 48 * 60 * MIN, close: now + 49 * 60 * MIN }],
  );
}

describe("MEDIUM cache TTL inside a service window", () => {
  beforeEach(() => {
    now = T0;
    fetches = 0;
    Date.now = () => now;
    globalThis.fetch = (async () => {
      fetches++;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: async () => ({ data: [], included: [] }),
        text: async () => "{}",
      } as unknown as Response;
    }) as typeof fetch;
    pcoService.clearCache();
  });

  afterEach(() => {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    serviceWindow.setWindows([]);
    serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
    pcoService.clearCache();
  });

  // ── Inside the window ───────────────────────────────────────────────────

  test("inside a window a MEDIUM entry is still held at 30s", async () => {
    inWindow(true);
    await pcoService.listTeamMembers("app", "sec", "st", "plan");
    now += 30 * SEC;
    await pcoService.listTeamMembers("app", "sec", "st", "plan");
    assert.equal(fetches, 1, "30s is inside the 45s in-window TTL — should be a cache hit");
  });

  test("inside a window a MEDIUM entry expires by 60s", async () => {
    inWindow(true);
    await pcoService.listTeamMembers("app", "sec", "st", "plan");
    now += 60 * SEC;
    await pcoService.listTeamMembers("app", "sec", "st", "plan");
    assert.equal(
      fetches,
      2,
      "a plan edit must reach the display inside a minute during a service; " +
        "60s is past the 45s in-window TTL and should have re-pulled",
    );
  });

  // ── Outside the window — the half a fast-path-only test would miss ──────

  test("outside every window the MEDIUM tier is unchanged at 3 minutes", async () => {
    inWindow(false);
    await pcoService.listTeamMembers("app", "sec", "st", "plan");
    now += 60 * SEC;
    await pcoService.listTeamMembers("app", "sec", "st", "plan");
    assert.equal(
      fetches,
      1,
      "away from a service this must cost no more requests than before — 60s is " +
        "well inside the 3-minute MEDIUM TTL and should be a cache hit",
    );

    now += 2.5 * MIN; // 3.5 min total
    await pcoService.listTeamMembers("app", "sec", "st", "plan");
    assert.equal(fetches, 2, "past 3 minutes it should re-pull, as it always did");
  });

  test("with no windows known at all the MEDIUM tier stays at 3 minutes", async () => {
    // No PCO schedule — no credentials, or the schedule fetch failed. The roster
    // and plan content then move at the operator's configured cadence, exactly as
    // before. Failing towards MORE requests here would hit every install that has
    // never had a window computed.
    serviceWindow.setWindows([]);
    await pcoService.listTeamMembers("app", "sec", "st", "plan");
    now += 60 * SEC;
    await pcoService.listTeamMembers("app", "sec", "st", "plan");
    assert.equal(fetches, 1);
  });

  // ── Read time, not write time ───────────────────────────────────────────

  test("a window opening AFTER the write shortens an entry already cached", async () => {
    inWindow(false);
    await pcoService.listTeamMembers("app", "sec", "st", "plan");
    assert.equal(fetches, 1);

    // 60s later a service window opens. Under a write-time TTL this entry was
    // stamped with a 3-minute expiry and would still be served; the tightening
    // would not bite until it had expired on its own.
    now += 60 * SEC;
    inWindow(true);
    await pcoService.listTeamMembers("app", "sec", "st", "plan");
    assert.equal(
      fetches,
      2,
      "the MEDIUM TTL must be resolved when the entry is READ, so a window that " +
        "opens after the write still shortens what is already in the cache",
    );
  });

  test("a window closing after the write relaxes the entry back to 3 minutes", async () => {
    inWindow(true);
    await pcoService.listTeamMembers("app", "sec", "st", "plan");

    // The window closes 30s in. The entry is 30s old and, off-window, has a
    // 3-minute life — so it stays valid rather than being dropped at 45s.
    now += 30 * SEC;
    inWindow(false);
    now += 30 * SEC; // 60s old
    await pcoService.listTeamMembers("app", "sec", "st", "plan");
    assert.equal(fetches, 1);
  });

  // ── The other tiers are untouched ───────────────────────────────────────

  test("the LONG tier keeps its 15 minutes inside a window", async () => {
    inWindow(true);
    await pcoService.listServiceTypes("app", "sec");
    now += 10 * MIN;
    await pcoService.listServiceTypes("app", "sec");
    assert.equal(fetches, 1, "service types are static day-of; the window must not shorten them");
  });
});
