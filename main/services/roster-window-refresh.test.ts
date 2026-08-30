// The roster re-pulls once a minute while a service window is open.
//
// The roster was the stalest thing the app showed: it moved only on the plan
// refresh, which an operator may have set to two hours, so a last-minute
// substitution could take two hours to reach a stage display. Everything else the
// app reads from PCO is cached in minutes, or — for the live timer — not at all.
//
// Both sides are tested. A test that only asserted the fast path would stay green
// if the serviceWindow check were deleted outright, which would put every install
// on a roster request a minute forever, including the ~95% of the week that is
// not a service.
//
// These drive the REAL controller and the REAL timer wiring, with pcoService's
// roster read stubbed to count calls. Asserting on the source text would be
// satisfied by a comment.

import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "roster-window-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController, ROSTER_WINDOW_INTERVAL_MS } = await import("./stage-controller.js");
const { pcoService } = await import("./pco-service.js");
const { serviceWindow, DEFAULT_RECONNECT_SCHEDULE } = await import("./service-window.js");

const MIN = 60_000;

type Internals = {
  state: Record<string, unknown>;
  pcoAppId: string | null;
  pcoSecret: string | null;
  teamMembers: unknown[];
  teamMembersKey: string | null;
  rosterRefreshTimer: unknown;
  rosterRefreshTick: () => Promise<void>;
  broadcast: () => void;
};

const ctl = stageController as unknown as Internals;

let calls = 0;
/** What the stubbed PCO roster read returns next. */
let roster: { id: string; name: string }[] = [];

const realList = pcoService.listTeamMembers.bind(pcoService);
const realBroadcast = ctl.broadcast;
let broadcasts = 0;

/** Put "now" inside a service window, or well outside every one. */
function inWindow(yes: boolean): void {
  const now = Date.now();
  serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
  serviceWindow.setWindows(
    yes
      ? [{ open: now - 30 * MIN, close: now + 240 * MIN }]
      : [{ open: now + 48 * 60 * MIN, close: now + 49 * 60 * MIN }],
  );
}

describe("roster refresh inside a service window", () => {
  beforeEach(() => {
    calls = 0;
    broadcasts = 0;
    roster = [{ id: "tm-1", name: "A. Person" }];

    // No service-type or plan id from any real organisation: made-up strings.
    ctl.state = { ...ctl.state, pcoConfigured: true, serviceTypeId: "st-test", planId: "plan-test" };
    ctl.pcoAppId = "app-id";
    ctl.pcoSecret = "secret";
    ctl.teamMembers = [];
    ctl.teamMembersKey = null;

    pcoService.listTeamMembers = (async () => {
      calls++;
      return roster.map((m) => ({
        ...m,
        personId: null,
        photoUrl: null,
        teamPositionName: null,
        teamName: null,
        status: "C",
        notes: null,
      }));
    }) as typeof pcoService.listTeamMembers;

    ctl.broadcast = () => {
      broadcasts++;
    };
  });

  afterEach(() => {
    pcoService.listTeamMembers = realList;
    ctl.broadcast = realBroadcast;
    stageController.stopAutoRefresh();
    serviceWindow.setWindows([]);
    serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
  });

  // ── Inside the window ───────────────────────────────────────────────────

  test("a tick inside a window re-pulls the roster", async () => {
    inWindow(true);
    await ctl.rosterRefreshTick();
    assert.equal(calls, 1, "a substitution during a service must not wait for the plan refresh");
    assert.equal(ctl.teamMembers.length, 1);
  });

  test("a changed roster is re-resolved and broadcast", async () => {
    inWindow(true);
    await ctl.rosterRefreshTick();
    assert.equal(broadcasts, 1, "displays must be told about the new name");
  });

  test("an unchanged roster does not wake every display", async () => {
    inWindow(true);
    await ctl.rosterRefreshTick();
    const after = broadcasts;
    await ctl.rosterRefreshTick();
    assert.equal(
      broadcasts,
      after,
      "this runs every minute for hours; an unchanged roster must not wake every display",
    );
  });

  test("a substitution replaces the roster the displays resolve against", async () => {
    inWindow(true);
    await ctl.rosterRefreshTick();
    roster = [{ id: "tm-2", name: "B. Stand-In" }];
    await ctl.rosterRefreshTick();
    assert.deepEqual(
      ctl.teamMembers.map((m) => (m as { id: string }).id),
      ["tm-2"],
      "the whole point: the new name replaces the old one without a full refresh. " +
        "this.teamMembers is what recomputeResolved feeds every slot from",
    );
    assert.equal(broadcasts, 2, "and the displays are told");
  });

  // ── Outside the window — the half a fast-path-only test would miss ──────

  test("a tick outside every window makes no request at all", async () => {
    inWindow(false);
    await ctl.rosterRefreshTick();
    assert.equal(
      calls,
      0,
      "away from a service the roster moves on the operator's configured interval, " +
        "exactly as it did before; this tick must cost nothing",
    );
    assert.equal(broadcasts, 0);
  });

  test("with no windows known at all it makes no request", async () => {
    // No credentials, or the schedule fetch failed. Failing towards MORE requests
    // here would hit every install that has never had a window computed.
    serviceWindow.setWindows([]);
    await ctl.rosterRefreshTick();
    assert.equal(calls, 0);
  });

  test("a window that has already closed does not re-pull", async () => {
    const now = Date.now();
    serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
    serviceWindow.setWindows([{ open: now - 300 * MIN, close: now - 60 * MIN }]);
    await ctl.rosterRefreshTick();
    assert.equal(calls, 0);
  });

  // ── Preconditions ───────────────────────────────────────────────────────

  test("no plan selected means no request, window or not", async () => {
    inWindow(true);
    ctl.state = { ...ctl.state, planId: null };
    await ctl.rosterRefreshTick();
    assert.equal(calls, 0);
  });

  test("PCO not configured means no request", async () => {
    inWindow(true);
    ctl.state = { ...ctl.state, pcoConfigured: false };
    await ctl.rosterRefreshTick();
    assert.equal(calls, 0);
  });

  // ── The tick's cadence is its own, not the cache's ──────────────────────

  test("back-to-back ticks each reach PCO rather than being served from cache", async () => {
    // The real listTeamMembers with a stubbed network, so the CACHE is in play.
    // Without an explicit invalidation the tick's cadence would silently become
    // whatever the MEDIUM TTL happens to be that release — two ticks inside 45s
    // would collapse to one read, and a bump to that TTL would quietly stop the
    // roster moving.
    pcoService.listTeamMembers = realList;
    pcoService.clearCache();
    const realFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: async () => ({ data: [], included: [] }),
        text: async () => "{}",
      } as unknown as Response;
    }) as typeof fetch;

    try {
      inWindow(true);
      await ctl.rosterRefreshTick();
      await ctl.rosterRefreshTick();
      assert.equal(requests, 2, "the second tick was served a cached roster");
    } finally {
      globalThis.fetch = realFetch;
      pcoService.clearCache();
    }
  });

  // ── Racing the plan itself ──────────────────────────────────────────────

  test("a roster that resolves after the plan moved on is discarded", async () => {
    // Auto plan-mode rolls from the 9am plan to the 11am one, and inside a window
    // the roster tick is firing every minute — so the two overlap by design. A
    // roster that lands late must not put the previous service's names on every
    // stage display.
    inWindow(true);
    ctl.teamMembers = [{ id: "tm-11am", name: "Current Plan Person" }];
    ctl.teamMembersKey = "st-test:plan-later";

    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    pcoService.listTeamMembers = (async () => {
      calls++;
      await held; // still in flight while the plan changes underneath us
      return [
        {
          id: "tm-9am",
          name: "Previous Plan Person",
          personId: null,
          photoUrl: null,
          teamPositionName: null,
          teamName: null,
          status: "C",
          notes: null,
        },
      ];
    }) as typeof pcoService.listTeamMembers;

    const tick = ctl.rosterRefreshTick();
    // The plan rolls over while the request is out.
    ctl.state = { ...ctl.state, planId: "plan-later" };
    release();
    await tick;

    assert.deepEqual(
      ctl.teamMembers.map((m) => (m as { id: string }).id),
      ["tm-11am"],
      "a roster for a plan that is no longer selected must be discarded, not applied",
    );
    assert.equal(ctl.teamMembersKey, "st-test:plan-later");
  });

  test("a slow tick does not overlap the next one", async () => {
    inWindow(true);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    pcoService.listTeamMembers = (async () => {
      calls++;
      await held;
      return [];
    }) as typeof pcoService.listTeamMembers;

    const first = ctl.rosterRefreshTick();
    // listTeamMembers paginates and backs off on a 429, so a slow window can
    // outlast the 60s cadence and the timer fires again underneath it.
    //
    // Deliberately NOT awaited. A second tick that wrongly proceeds would block on
    // the same held promise, and awaiting it here would turn this guard's failure
    // into a hang — which reads as a stuck suite rather than as a caught bug. It
    // is awaited below, after the assertion and after the release.
    const second = ctl.rosterRefreshTick();
    await Promise.resolve(); // let a wrongly-proceeding second tick reach the call
    assert.equal(calls, 1, "the second tick must stand down while the first is in flight");

    release();
    await Promise.all([first, second]);
  });

  // ── Timer wiring ────────────────────────────────────────────────────────

  test("the cadence is one minute — fast enough for a human edit, cheap enough to keep", () => {
    assert.equal(ROSTER_WINDOW_INTERVAL_MS, 60_000);
  });

  test("startAutoRefresh arms the roster timer and stopAutoRefresh clears it", () => {
    stageController.stopAutoRefresh();
    assert.equal(ctl.rosterRefreshTimer, null, "precondition: nothing armed");

    stageController.startAutoRefresh(2 * 60 * MIN);
    assert.notEqual(
      ctl.rosterRefreshTimer,
      null,
      "the tick is useless if nothing ever calls it",
    );

    stageController.stopAutoRefresh();
    assert.equal(
      ctl.rosterRefreshTimer,
      null,
      "a config restore pauses background work; a roster timer left running would " +
        "write over the snapshot being laid down",
    );
  });
});
