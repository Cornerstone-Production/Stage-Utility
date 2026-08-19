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

describe("what an update leaves behind for the operator", () => {
  test("the notice survives being written and read back from disk", async () => {
    // The whole point: it is written before the process restarts, and read by a
    // DIFFERENT process afterwards. "It looked saved until the next restart" is
    // a failure this repository has already had, so this reads through the file
    // rather than trusting an in-memory value.
    const { updateNoticesStore } = await import("./update-notices-store.js");
    await updateNoticesStore.update((cur) => ({
      ...cur,
      justUpdated: {
        version: "v1.12.0",
        fromVersion: "1.11.0",
        notes: [{ section: "Breaking", lines: ["displays without a slug redirect"] }],
        lines: [],
        at: "2026-08-18T00:00:00.000Z",
      },
    }));

    await updateNoticesStore.reload();
    const after = await updateNoticesStore.load();
    assert.equal(after.justUpdated?.version, "v1.12.0");
    assert.equal(after.justUpdated?.fromVersion, "1.11.0");
    assert.deepEqual(after.justUpdated?.notes, [
      { section: "Breaking", lines: ["displays without a slug redirect"] },
    ]);
  });

  test("dismissing clears it, and that survives a reload too", async () => {
    const { updateNoticesStore } = await import("./update-notices-store.js");
    await updateNoticesStore.update((cur) => ({ ...cur, justUpdated: null }));
    await updateNoticesStore.reload();
    assert.equal((await updateNoticesStore.load()).justUpdated, null);
  });

  test("an announced tag is independent of the just-updated notice", async () => {
    // Dismissing the release dialog must not un-announce a pending version, and
    // announcing must not clear a dialog waiting to be read.
    const { updateNoticesStore } = await import("./update-notices-store.js");
    await updateNoticesStore.update((cur) => ({ ...cur, announcedTag: "v1.13.0" }));
    await updateNoticesStore.update((cur) => ({
      ...cur,
      justUpdated: { version: "v1.12.0", fromVersion: null, notes: [], lines: [], at: "x" },
    }));
    const s = await updateNoticesStore.load();
    assert.equal(s.announcedTag, "v1.13.0");
    assert.equal(s.justUpdated?.version, "v1.12.0");
  });
});
