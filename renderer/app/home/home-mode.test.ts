import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { homeMode, PRESERVICE_LIVE_WINDOW_SEC } from "./home-mode.js";

describe("home mode", () => {
  test("no live payload at all is idle", () => {
    assert.equal(homeMode(null), "idle");
  });

  test('mode "none" is idle, even though a payload exists', () => {
    // The server sends mode "none" to say the service ENDED. Treating any
    // payload as live leaves Home in service mode all week - the same mistake
    // the context bar guards against one layer down.
    assert.equal(homeMode({ mode: "none" } as PcoLiveDTO), "idle");
  });

  test("a live item is live", () => {
    assert.equal(homeMode({ mode: "item" } as PcoLiveDTO), "live");
  });

  test("pre-service close to the start is live", () => {
    // The half hour before a service is exactly when an operator is watching
    // this screen. Counting down is participating; showing the Thursday view
    // is not.
    assert.equal(homeMode({ mode: "preservice" } as PcoLiveDTO, 20 * 60), "live");
  });

  test("pre-service DAYS out is idle", () => {
    // This is the bug a real install showed: PCO reports "preservice" from
    // whenever it knows about the next service, so Home read
    // "Service starts 1d 15h" on a Thursday and hid the readiness list -
    // exactly when that list is the point of the page.
    assert.equal(homeMode({ mode: "preservice" } as PcoLiveDTO, 39 * 60 * 60), "idle");
  });

  test("the boundary is inclusive, and just past it is idle", () => {
    const live = { mode: "preservice" } as PcoLiveDTO;
    assert.equal(homeMode(live, PRESERVICE_LIVE_WINDOW_SEC), "live");
    assert.equal(homeMode(live, PRESERVICE_LIVE_WINDOW_SEC + 1), "idle");
  });

  test("an unknown time to start is idle, not a guess", () => {
    // Guessing "live" puts a countdown in front of someone all week; guessing
    // "idle" at worst shows the readiness list during a service, which is
    // wrong but not misleading.
    assert.equal(homeMode({ mode: "preservice" } as PcoLiveDTO, null), "idle");
  });

  test("a running item is live regardless of any countdown", () => {
    // Once an item is live the service IS happening; the pre-service window
    // has nothing to say about it.
    assert.equal(homeMode({ mode: "item" } as PcoLiveDTO, 99 * 60 * 60), "live");
  });
});
