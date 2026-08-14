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

  test("counts a pre-service countdown down to the service start", () => {
    const pre = {
      ...LIVE_ITEM,
      mode: "preservice",
      label: "Service starts",
      liveStartAt: null,
      targetAt: "2026-08-14T14:30:00.000Z",
    } as PcoLiveDTO;
    const s = contextBarState(pre, Date.parse("2026-08-14T14:25:00.000Z"), 0);
    assert.equal(s.isLive, true);
    assert.equal(s.timerText, "5:00");
  });
});
