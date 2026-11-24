// A restore's hold on the screen bindings is taken back when the hold cannot be taken.
//
// pauseBindingWrites counts the hold, then waits for any write in flight. If that wait
// fails, the restore is refused and resumes nothing it did not get back, so a hold left
// counted would refuse every claim, release and probe write until the next restart.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "su-bindings-pause-"));
process.env.STAGE_UTILITY_DATA = dataDir;
process.env.HOME = path.join(dataDir, "home");

const { kioskDevicesStore, pauseBindingWrites, bindingWritesHeld } = await import("./kiosk-devices-store.js");

after(() => fs.rm(dataDir, { recursive: true, force: true }));

describe("pauseBindingWrites", () => {
  it("takes its hold back when waiting for the write in flight fails", async () => {
    const store = kioskDevicesStore as unknown as { update: unknown };
    const realUpdate = store.update;
    store.update = async () => {
      throw new Error("disk full");
    };
    try {
      await assert.rejects(pauseBindingWrites(), /disk full/);
    } finally {
      store.update = realUpdate;
    }
    assert.equal(bindingWritesHeld(), false, "a pause that failed left the bindings held");
  });

  it("holds, and releases once", async () => {
    const release = await pauseBindingWrites();
    assert.equal(bindingWritesHeld(), true);
    release();
    release();
    assert.equal(bindingWritesHeld(), false);
  });
});
