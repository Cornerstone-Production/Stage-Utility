// The fixture's tick order and the real poller's must be one list. Nothing here
// reads live-poller.ts as text: it runs the poller's own act() against spies on
// the four consumers, then runs feedLiveTick against the same spies.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import { feedLiveTick, LIVE_TICK_ORDER, makeLive } from "./live-dto.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-live-dto-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { livePoller } = await import("../live-poller.js");
const { stageController } = await import("../stage-controller.js");
const { splRecorder } = await import("../spl-recorder.js");
const { attendanceRecorder } = await import("../attendance-recorder.js");
const { serviceTimelineRecorder } = await import("../service-timeline-recorder.js");
const { baptismTimerService } = await import("../baptism-timer-service.js");

after(() => fs.rm(TMP, { recursive: true, force: true }));

/** Spy on the four consumers; the returned list fills in call order. */
function spyOnConsumers(t: TestContext): string[] {
  const seen: string[] = [];
  const spy = (name: string, target: { onLiveTick(l: unknown): Promise<void> }): void => {
    t.mock.method(target, "onLiveTick", async () => {
      seen.push(name);
    });
  };
  spy("spl-recorder", splRecorder);
  spy("attendance-recorder", attendanceRecorder);
  spy("service-timeline-recorder", serviceTimelineRecorder);
  spy("baptism-timer", baptismTimerService);
  t.mock.method(stageController, "maybeAutoAdvance", async () => {});
  return seen;
}

describe("live-dto fixture", () => {
  it("feeds the consumers in the order the real poller does", async (t) => {
    const seen = spyOnConsumers(t);
    (livePoller as unknown as { act(live: unknown): void }).act(makeLive({ mode: "item", currentItemId: "x" }));
    const real = [...seen];
    seen.length = 0;
    await feedLiveTick(makeLive());
    assert.deepEqual(real, [...LIVE_TICK_ORDER], "live-poller.ts act() feeds a different list than LIVE_TICK_ORDER");
    assert.deepEqual(seen, real, "feedLiveTick feeds a different order than the real poller");
  });

  it("makeLive takes a partial override and keeps the rest", () => {
    const live = makeLive({ nextItemTitle: "Doors" });
    assert.equal(live.nextItemTitle, "Doors");
    assert.equal(live.mode, "none");
  });
});
