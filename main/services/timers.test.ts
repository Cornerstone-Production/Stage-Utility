import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { trailing } from "./timers.js";

describe("trailing", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  test("a burst is one flush, at the end of the wait", () => {
    let flushed = 0;
    const t = trailing(250, () => (flushed += 1));
    assert.equal(t.schedule(), true, "the first call starts the wait");
    assert.equal(t.schedule(), false);
    assert.equal(t.schedule(), false);
    mock.timers.tick(249);
    assert.equal(flushed, 0);
    mock.timers.tick(1);
    assert.equal(flushed, 1);
  });

  test("nothing flushes with nothing scheduled, and a later call starts a new wait", () => {
    let flushed = 0;
    const t = trailing(100, () => (flushed += 1));
    mock.timers.tick(1000);
    assert.equal(flushed, 0);
    t.schedule();
    mock.timers.tick(100);
    assert.equal(t.schedule(), true);
    mock.timers.tick(100);
    assert.equal(flushed, 2);
  });

  test("cancel drops the wait and the pending work", () => {
    let flushed = 0;
    const t = trailing(100, () => (flushed += 1));
    t.schedule();
    t.cancel();
    mock.timers.tick(500);
    assert.equal(flushed, 0, "a cancelled wait must not flush");
    assert.equal(t.schedule(), true, "and the next call starts a fresh one");
  });

  test("a schedule made inside the flush starts the next wait", () => {
    let flushed = 0;
    const t: ReturnType<typeof trailing> = trailing(100, () => {
      flushed += 1;
      if (flushed === 1) t.schedule();
    });
    t.schedule();
    mock.timers.tick(100);
    mock.timers.tick(100);
    assert.equal(flushed, 2);
  });
});
