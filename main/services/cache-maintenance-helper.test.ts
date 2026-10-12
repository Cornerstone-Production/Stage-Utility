// The periodic cache maintenance prunes the Mac output helper's cache too, so an
// update's old zips go at startup even when nobody asks for the helper again.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { captureConsole } from "./fixtures/capture-console.js";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "su-maint-"));
process.env.STAGE_UTILITY_DATA = dataDir;
// After the data directory is set: the modules read it.
const { cacheMaintenance } = await import("./cache-maintenance.js");
const { pkgVersion } = await import("./updater.js");

describe("cache maintenance", () => {
  it("removes the output helper's old versions shortly after startup, and keeps the running one", async (t) => {
    captureConsole(t, "log", "warn", "error");
    const root = path.join(dataDir, "cache", "output-helper");
    await fs.mkdir(path.join(root, pkgVersion()), { recursive: true });
    await fs.writeFile(path.join(root, pkgVersion(), "keep"), "x");
    await fs.mkdir(path.join(root, "0.0.1"), { recursive: true });
    await fs.writeFile(path.join(root, "0.0.1", "StageUtilityOutput-arm64.zip"), "old");

    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    cacheMaintenance.start();
    t.mock.timers.tick(30_000);
    try {
      // runOnce is not awaited by the timer; wait for its effect.
      for (let i = 0; i < 200 && (await fs.readdir(root)).length > 1; i++) await new Promise((r) => setImmediate(r));
      assert.deepEqual(await fs.readdir(root), [pkgVersion()]);
      assert.deepEqual(await fs.readdir(path.join(root, pkgVersion())), ["keep"]);
    } finally {
      cacheMaintenance.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
