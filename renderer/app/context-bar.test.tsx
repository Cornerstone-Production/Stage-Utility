import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM must exist before the component modules are evaluated - a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { contextBarState, renderBarItem, integrationHealth } = await import("./context-bar.js");
const { BAR_ITEMS } = await import("./bar-items.js");

after(() => {
  teardown();
});

// The timer maths itself is covered by pco-timer's own tests. What is new here
// is the bar's own decisions: when to claim a service is live, and that it does
// not invent its own formatting or ignore clock skew.
const LIVE_ITEM: PcoLiveDTO = {
  mode: "item",
  currentItemId: "i1",
  label: "Message",
  lengthSec: 1200,
  liveStartAt: "2026-08-14T14:00:00.000Z",
  targetAt: null,
  serverNow: "2026-08-14T14:05:00.000Z",
  currentItemTitle: "Message",
  nextItemTitle: "Closing",
  serviceTimeId: "st1",
  serviceTimeStartsAt: "2026-08-14T13:30:00.000Z",
} as PcoLiveDTO;

describe("context bar state", () => {
  test("reports not-live when there is no live payload at all", () => {
    const s = contextBarState(null, Date.parse("2026-08-14T14:05:00.000Z"), 0);
    assert.equal(s.isLive, false);
    assert.equal(s.timerText, null);
  });

  test("reports not-live in mode none, even though a payload exists", () => {
    // A pco:live broadcast with mode "none" is the server saying the service
    // ENDED. Treating any payload as live leaves a Live pill lit all week.
    const s = contextBarState({ ...LIVE_ITEM, mode: "none" }, Date.now(), 0);
    assert.equal(s.isLive, false);
    assert.equal(s.timerText, null);
  });

  test("reports live with the current item and a formatted timer", () => {
    const s = contextBarState(LIVE_ITEM, Date.parse("2026-08-14T14:05:00.000Z"), 0);
    assert.equal(s.isLive, true);
    assert.equal(s.itemTitle, "Message");
    // 1200s planned, 300s elapsed -> 900s remaining, via fmtDuration.
    assert.equal(s.timerText, "15:00");
  });

  test("applies clock skew, so a drifted browser matches the server", () => {
    // The browser clock is 60s BEHIND the server. Without applying skew the
    // timer reads a minute long for the whole service, disagreeing with the
    // countdown on the wall.
    const browserNow = Date.parse("2026-08-14T14:04:00.000Z");
    const s = contextBarState(LIVE_ITEM, browserNow, 60_000);
    assert.equal(s.timerText, "15:00");
  });

  test("shows an overrun as negative rather than clamping it", () => {
    // PCO counts past zero when an item runs long, and so must this - an
    // operator needs to see HOW far over, not a frozen 0:00.
    const s = contextBarState(LIVE_ITEM, Date.parse("2026-08-14T14:25:00.000Z"), 0);
    assert.equal(s.isLive, true);
    assert.equal(s.isOver, true);
    assert.ok(s.timerText?.startsWith("−"), `expected a negative timer, got ${s.timerText}`);
  });

  const preservice = (targetAt: string) =>
    ({
      ...LIVE_ITEM,
      mode: "preservice",
      label: "Service starts",
      liveStartAt: null,
      targetAt,
    }) as PcoLiveDTO;

  test("counts a pre-service countdown down to the service start", () => {
    const s = contextBarState(preservice("2026-08-14T14:30:00.000Z"), Date.parse("2026-08-14T14:25:00.000Z"), 0);
    assert.equal(s.timerText, "5:00");
  });

  test("a pre-service countdown is NOT live", () => {
    // THE guard, and this test used to assert the opposite. isLive was true for
    // any timer at all, so a service two days out — which produces a perfectly
    // good countdown — lit the green LIVE badge above every page. The bar said
    // "starts in 2d 0h" and "LIVE" at the same time.
    const s = contextBarState(preservice("2026-08-14T14:30:00.000Z"), Date.parse("2026-08-14T14:25:00.000Z"), 0);
    assert.equal(s.isLive, false, "a countdown to a future service reported itself live");
  });

  test("still not live when the service is days away", () => {
    // The case actually reported. Five minutes out and two days out are the same
    // state, and neither is live.
    const s = contextBarState(preservice("2026-08-16T14:30:00.000Z"), Date.parse("2026-08-14T14:30:00.000Z"), 0);
    assert.equal(s.isLive, false);
    assert.equal(s.timerText, "2d 0h");
  });

  test("still not live once the start time has PASSED", () => {
    // The subtle one. PCO stays in preservice until an item is actually started,
    // so the countdown goes negative while nothing is running — and "we are past
    // the start time" is the moment a false LIVE is most believable and most
    // wrong, because nobody has begun anything yet.
    const s = contextBarState(preservice("2026-08-14T14:30:00.000Z"), Date.parse("2026-08-14T14:35:00.000Z"), 0);
    assert.equal(s.isLive, false, "an overdue start reported itself live");
    assert.equal(s.isOver, true);
  });

  test("a running ITEM is live", () => {
    // The other half: the badge has to still appear when it should, or this is
    // just a different bug.
    const s = contextBarState(LIVE_ITEM, Date.parse("2026-08-14T14:05:00.000Z"), 0);
    assert.equal(s.isLive, true);
  });
});

describe("nothing appears or disappears", () => {
  // Items used to return null when they had nothing to say, so the bar reflowed
  // as the state changed: integration health arrived only once something broke,
  // and between services the right-hand group was absent entirely. An operator
  // cannot learn where to look on a strip that rearranges itself.
  //
  // This walks the REAL renderer over every registered id, so an idle branch
  // deleted from any one of them fails here by name.
  const NOW = Date.parse("2026-08-14T14:05:00.000Z");
  const ALL = Object.keys(BAR_ITEMS) as (keyof typeof BAR_ITEMS)[];

  /** The deadest state the app has: no service, no recorder, no integrations. */
  const idle = {
    state: null,
    bar: contextBarState(null, NOW, 0),
    now: NOW,
    obs: null,
    reaper: null,
    integrations: { states: [], labels: {} },
    resi: null,
    youtube: null,
  };

  test("every item renders with no service, no recorder and no integrations", () => {
    for (const id of ALL) {
      assert.notEqual(renderBarItem(id, idle), null, `${id} vanishes when there is nothing to report`);
    }
  });

  test("every item still renders mid-service", () => {
    // The other half. An item that only renders when idle is the same bug.
    const live = { ...idle, bar: contextBarState(LIVE_ITEM, NOW, 0) };
    for (const id of ALL) {
      assert.notEqual(renderBarItem(id, live), null, `${id} vanishes during a live service`);
    }
  });

  test("every item renders while a recorder is connected but stopped", () => {
    // The state the bar exists to surface, and the one that reaches the
    // branches an idle-only fixture never touches.
    const rolling = {
      ...idle,
      bar: contextBarState(LIVE_ITEM, NOW, 0),
      obs: { connected: true, recording: false, recordTimecode: null },
      integrations: {
        states: [{ id: "obs", enabled: true, configured: true, connection: "disconnected" }],
        labels: { obs: "OBS" },
      },
    };
    for (const id of ALL) {
      assert.notEqual(renderBarItem(id, rolling as never), null, `${id} vanishes with a recorder stopped`);
    }
  });
});

describe("what counts as an integration being down", () => {
  // Both exclusions are things the bar used to complain about forever.
  const st = (over: Partial<IntegrationState>): IntegrationState =>
    ({ id: "x", enabled: true, configured: true, connection: "disconnected", message: null, config: {}, ...over }) as IntegrationState;

  test("a set-up integration that is disconnected is down", () => {
    const { down } = integrationHealth([st({ id: "obs" })]);
    assert.deepEqual(down.map((d) => d.id), ["obs"]);
  });

  test("one nobody set up is absent, not down", () => {
    const { setUp, down } = integrationHealth([st({ id: "resi", configured: false })]);
    assert.deepEqual(setUp, []);
    assert.deepEqual(down, []);
  });

  test("an INBOUND one is never down, however it reports itself", () => {
    // Companion's module dials us. With no Stream Deck plugged in it sits at
    // "disconnected" for weeks, and the bar was counting that as a fault.
    const { setUp, down } = integrationHealth([st({ id: "companion", inbound: true })]);
    assert.deepEqual(down, [], "an inbound integration was counted as down");
    assert.deepEqual(setUp, [], "an inbound integration was counted at all");
  });

  test("and it does not hide the ones that ARE down beside it", () => {
    const { down } = integrationHealth([st({ id: "companion", inbound: true }), st({ id: "obs" })]);
    assert.deepEqual(down.map((d) => d.id), ["obs"]);
  });
});
