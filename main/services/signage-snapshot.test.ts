// What a backup carries for signage, and what it admits it left behind.
//
// A media library is the one config store that can reach gigabytes. Carrying all
// of it would produce a snapshot that chokes the download, the upload and the SD
// card it lands on; carrying none of it would silently lose every graphic an
// operator made. The rule is a per-file size cap, and — the part that matters —
// whatever is skipped is NAMED, so a restore can say what did not come back
// rather than leaving it to be discovered when a screen goes blank.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  SIGNAGE_SNAPSHOT_MAX_FILE_BYTES,
  configFiles,
  runtimeFiles,
  shouldSnapshotMedia,
} from "./config-snapshot.js";

describe("what a backup carries for signage", () => {
  test("all four config stores, by name", () => {
    const f = configFiles();
    for (const n of [
      "signage-media.json",
      "signage-playlists.json",
      "signage-groups.json",
      "signage-schedules.json",
    ]) {
      assert.ok(f.includes(n), `${n} is missing from every backup`);
    }
  });

  test("NOT the overrides", () => {
    // Persisted so a restart cannot drop an announcement, but restoring a
    // fortnight-old snapshot must never put a forgotten one back on a wall.
    assert.ok(!configFiles().includes("signage-overrides.json"));
    assert.ok(runtimeFiles().includes("signage-overrides.json"));
  });
});

describe("which media files ride along", () => {
  test("graphics do, video does not", () => {
    assert.equal(SIGNAGE_SNAPSHOT_MAX_FILE_BYTES, 12 * 1024 * 1024);
    assert.equal(shouldSnapshotMedia({ bytes: 2 * 1024 * 1024 }), true);
    assert.equal(shouldSnapshotMedia({ bytes: 168 * 1024 * 1024 }), false);
  });

  test("the rule is SIZE, not type — an oversized image is skipped too", () => {
    // Sizing on mime would drift from the upload caps and produce a backup that
    // silently excluded a graphic somebody was allowed to upload.
    assert.equal(shouldSnapshotMedia({ bytes: 13 * 1024 * 1024 }), false);
  });

  test("a file exactly at the cap is carried, not dropped off by one", () => {
    assert.equal(shouldSnapshotMedia({ bytes: SIGNAGE_SNAPSHOT_MAX_FILE_BYTES }), true);
  });

  test("the cap matches the image upload cap, so anything uploadable is backed up", () => {
    // These drifting apart is how an operator uploads a 12 MB graphic that the
    // next backup quietly refuses to carry.
    assert.equal(SIGNAGE_SNAPSHOT_MAX_FILE_BYTES, 12 * 1024 * 1024);
  });
});
