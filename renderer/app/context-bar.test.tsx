import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM must exist before the component modules are evaluated - a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { contextBarState } = await import("./context-bar.js");

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
