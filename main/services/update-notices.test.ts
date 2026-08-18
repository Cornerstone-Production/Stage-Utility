import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

process.env.STAGE_UTILITY_DATA = await fs.mkdtemp(path.join(os.tmpdir(), "su-notices-"));

// Importing the barrel is what puts every store in the registry — a store module
// nobody imports is silently absent from it.
await import("./stores.js");
const { configFilenames, storesOfClass } = await import("./store-registry.js");
const { isUpdateAvailable, availableCount } = await import("./update/availability.js");
import type { UpdateStatus } from "../types/state.js";

const status = (over: Partial<UpdateStatus>): UpdateStatus => over as UpdateStatus;

describe("where the notices live", () => {
  test("update-notices.json is RUNTIME, not config", () => {
    // An observation, not the operator's work. In a config snapshot, restoring
    // last month's backup would re-announce a version already installed, or
    // suppress one that is not.
    const runtime = storesOfClass("runtime").map((s) => s.filename);
    assert.ok(runtime.includes("update-notices.json"), "not registered as runtime");
    assert.ok(!configFilenames().includes("update-notices.json"), "it would ride into backups");
  });
});

describe("what counts as available", () => {
  test("a tag-based box counts RELEASES, not commits", () => {
    // A release is the unit an operator acts on; the commits behind it are
    // detail, and a box can be many commits into one release.
    assert.equal(availableCount(status({ tagBased: true, releasesBehind: 2, behindUserFacing: 40 })), 2);
  });

  test("a box that is not tag-based falls back to the commit count", () => {
    assert.equal(availableCount(status({ tagBased: false, releasesBehind: 0, behindUserFacing: 3 })), 3);
  });

  test("up to date is not available, however many commits are behind", () => {
    // The case that decides whether a dot is a nuisance: a tag-based box sitting
    // on the newest release is current, even mid-cycle.
    assert.equal(isUpdateAvailable(status({ tagBased: true, releasesBehind: 0, behindUserFacing: 9 })), false);
  });

  test("no status at all is not available, rather than a throw", () => {
    // The rail renders before the first status arrives.
    assert.equal(isUpdateAvailable(null), false);
    assert.equal(availableCount(undefined), 0);
  });

  test("missing counts are treated as zero", () => {
    assert.equal(isUpdateAvailable(status({ tagBased: true })), false);
    assert.equal(isUpdateAvailable(status({ tagBased: false })), false);
  });
});
