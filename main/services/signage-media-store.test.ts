// The media library: a manifest of records beside content-addressed files.
//
// Two things here are load-bearing and easy to regress.
//
// (1) Measurements come from the BROWSER (Image.naturalWidth,
//     HTMLVideoElement.duration) and are therefore untrusted input. They are
//     rejected out of range rather than defaulted: a zero duration makes a
//     playlist's cycle length unusable, and a silent default would hide that the
//     measurement failed instead of surfacing it at the door.
//
// (2) A file is named after its own bytes, so the same image uploaded twice is
//     the same content. Two records pointing at one file would let deleting
//     either one look like it freed the file, and would show the operator a
//     library with phantom duplicates in it.

import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

// Point the store at a scratch dir BEFORE importing it — getUserDataPath()
// memoises on first access. HOME is pinned too, because app-paths scans
// ~/.stage-display and ~/.stage-monitor for config to migrate forward and a real
// home dir would otherwise leak in.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-utility-signage-media-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
process.env.HOME = path.join(TMP, "home");

const { addMedia, listMedia, clampMeasured, deleteMedia, renameMedia, readMediaFile, statMediaFile } =
  await import("./signage-media-store.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("clamping what the browser measured", () => {
  test("keeps sane values", () => {
    assert.deepEqual(clampMeasured({ w: 1920, h: 1080, mime: "image/png" }), { w: 1920, h: 1080 });
  });

  test("rounds a fractional measurement rather than refusing it", () => {
    // devicePixelRatio maths hands back 1919.9998 often enough that refusing it
    // would reject ordinary uploads.
    assert.deepEqual(clampMeasured({ w: 1919.9998, h: 1080.4, mime: "image/png" }), { w: 1920, h: 1080 });
  });

  test("REJECTS a zero duration rather than defaulting it", () => {
    assert.throws(
      () => clampMeasured({ w: 1920, h: 1080, durationMs: 0, mime: "video/mp4" }),
      /duration/i,
    );
  });

  test("rejects a video whose duration was never measured", () => {
    assert.throws(() => clampMeasured({ w: 1920, h: 1080, mime: "video/mp4" }), /duration/i);
  });

  test("rejects an infinite duration", () => {
    // A live stream or a malformed container reports Infinity, and Math.round
    // leaves it Infinity — which would silently become an item that never ends.
    assert.throws(
      () => clampMeasured({ w: 1920, h: 1080, durationMs: Infinity, mime: "video/mp4" }),
      /duration/i,
    );
  });

  test("rejects an absurd dimension, and a zero one", () => {
    assert.throws(() => clampMeasured({ w: 999999, h: 1080, mime: "image/png" }), /dimension/i);
    assert.throws(() => clampMeasured({ w: 0, h: 1080, mime: "image/png" }), /dimension/i);
    assert.throws(() => clampMeasured({ w: 1920, h: -4, mime: "image/png" }), /dimension/i);
  });

  test("rejects a dimension that is not a number at all", () => {
    assert.throws(() => clampMeasured({ w: "1920", h: 1080, mime: "image/png" }), /dimension/i);
    assert.throws(() => clampMeasured({ w: NaN, h: 1080, mime: "image/png" }), /dimension/i);
  });

  test("an image is not asked for a duration", () => {
    const r = clampMeasured({ w: 8, h: 8, mime: "image/png" });
    assert.equal("durationMs" in r, false);
  });
});

describe("adding media", () => {
  test("stores a record and hands it back", async () => {
    const r = await addMedia({
      file: "0123456789abcdef.png",
      name: "welcome.png",
      mime: "image/png",
      bytes: 100,
      w: 1920,
      h: 1080,
    });
    assert.equal(r.deduped, false);
    assert.equal(r.media.name, "welcome.png");
    assert.ok(r.media.id);
    assert.ok(r.media.createdAt);
  });

  test("identical bytes collapse to ONE record, not two", async () => {
    const again = await addMedia({
      file: "0123456789abcdef.png",
      name: "welcome-copy.png",
      mime: "image/png",
      bytes: 100,
      w: 1920,
      h: 1080,
    });
    assert.equal(again.deduped, true, "a second upload of the same bytes made a duplicate record");
    assert.equal((await listMedia()).filter((m) => m.file === "0123456789abcdef.png").length, 1);
  });

  test("a dedupe keeps the name the operator gave it first", async () => {
    const all = await listMedia();
    assert.equal(all.find((m) => m.file === "0123456789abcdef.png")?.name, "welcome.png");
  });

  test("different bytes are a different record", async () => {
    const r = await addMedia({
      file: "fedcba9876543210.mp4",
      name: "tour.mp4",
      mime: "video/mp4",
      bytes: 900,
      w: 1920,
      h: 1080,
      durationMs: 42000,
    });
    assert.equal(r.deduped, false);
    assert.equal(r.media.durationMs, 42000);
  });
});

describe("renaming and deleting", () => {
  test("renames by id", async () => {
    const [first] = await listMedia();
    const r = await renameMedia(first.id, "Foyer welcome");
    assert.equal(r?.name, "Foyer welcome");
    assert.equal((await listMedia()).find((m) => m.id === first.id)?.name, "Foyer welcome");
  });

  test("renaming something that is gone returns null rather than throwing", async () => {
    assert.equal(await renameMedia("no-such-id", "x"), null);
  });

  test("deleting removes the record and returns what it removed", async () => {
    const before = await listMedia();
    const target = before[before.length - 1];
    const r = await deleteMedia(target.id);
    assert.equal(r?.id, target.id);
    assert.equal((await listMedia()).some((m) => m.id === target.id), false);
  });

  test("deleting something that is gone returns null", async () => {
    assert.equal(await deleteMedia("no-such-id"), null);
  });
});

describe("reading a file back", () => {
  test("refuses a name we did not write", async () => {
    // Traversal, and anything that is not our content-addressed shape. The
    // manifest is not consulted here — the NAME is the whole check, because this
    // runs before any lookup.
    for (const bad of [
      "../settings.json",
      "../../etc/passwd",
      "welcome.png",
      "0123456789abcdef.svg",
      "0123456789ABCDEF.png",
      "0123456789abcde.png",
      "",
    ]) {
      assert.equal(await readMediaFile(bad), null, `${bad} was accepted`);
      // statMediaFile is what the SERVING route calls. A guard that covered
      // only the reader would leave the function actually exposed to the LAN
      // unchecked — which is the half that matters.
      assert.equal(await statMediaFile(bad), null, `${bad} was accepted by statMediaFile`);
    }
  });

  test("returns null for a well-formed name with no file behind it", async () => {
    assert.equal(await readMediaFile("aaaaaaaaaaaaaaaa.png"), null);
    assert.equal(await statMediaFile("aaaaaaaaaaaaaaaa.png"), null);
  });
});
