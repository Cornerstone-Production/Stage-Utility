import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const {
  markUpdatePending,
  pendingUpdate,
  clearUpdatePending,
  noteServerVersion,
  currentServerVersion,
  takeJustUpdated,
  finishUpdateAndReload,
  __resetForTests,
} = await import("./update-lifecycle.js");

after(() => teardown());

beforeEach(() => {
  __resetForTests();
  sessionStorage.clear();
});

describe("update lifecycle handshake", () => {
  test("records the version it started from, so a later hello can tell it finished", () => {
    noteServerVersion("abc1234");
    markUpdatePending();
    assert.deepEqual(pendingUpdate()?.fromVersion, "abc1234");
  });

  test("keeps the FIRST server version, not the latest", () => {
    // The post-restart hello carries the NEW version. Overwriting here would
    // make the comparison "new === new" and the update would never register as
    // finished - the page would sit on "Updating..." until the watchdog.
    noteServerVersion("before");
    noteServerVersion("after");
    assert.equal(currentServerVersion(), "before");
  });

  test("clearing the pending flag leaves nothing behind", () => {
    markUpdatePending();
    clearUpdatePending();
    assert.equal(pendingUpdate(), null);
  });

  test("the success banner is consumed exactly once", () => {
    // It must show after the reload and not on every navigation afterwards.
    sessionStorage.setItem("stageUtility.update.done", JSON.stringify({ version: "1.2.3" }));
    assert.deepEqual(takeJustUpdated(), { version: "1.2.3" });
    assert.equal(takeJustUpdated(), null);
  });

  test("a corrupted handshake entry does not throw", () => {
    // sessionStorage is shared with anything else on the origin, and a half
    // written value must not take down the settings surface on load.
    sessionStorage.setItem("stageUtility.update.done", "{not json");
    assert.equal(takeJustUpdated(), null);
    sessionStorage.setItem("stageUtility.update.pending", "{not json");
    assert.equal(pendingUpdate(), null);
  });

  test("finishing twice schedules only one reload", () => {
    // The two completion signals race. Two reloads would drop the banner the
    // first was meant to show.
    let reloads = 0;
    const realSetTimeout = globalThis.setTimeout;
    // @ts-expect-error test stub
    globalThis.setTimeout = (_fn: () => void) => { reloads += 1; return 0 as unknown as NodeJS.Timeout; };
    finishUpdateAndReload("1.2.3");
    finishUpdateAndReload("1.2.3");
    globalThis.setTimeout = realSetTimeout;
    assert.equal(reloads, 1);
  });
});
