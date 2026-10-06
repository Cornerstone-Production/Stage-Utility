// A stored image is served immutable under a name that is the hash of its bytes,
// so a truncated file under that name is the image, wrongly, from then on. Every
// writer of one goes through a temp file and a rename, and a write that fails
// halfway leaves nothing at the final name and nothing behind.
//
// The disk filling or the power going is simulated at the one seam, fs.writeFile,
// by writing part of the bytes and throwing.

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), "image-files-atomic-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { saveImage, restoreImage, listImages, readImage } = await import("./image-files.js");
const { saveLayoutImage, saveLayoutImageBytes } = await import("./layout-image-store.js");

after(() => fsp.rm(TMP, { recursive: true, force: true }));

// A real one-pixel PNG, so the magic-number check passes.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;
const HASH = crypto.createHash("sha256").update(PNG).digest("hex").slice(0, 16);

/** Run `body` with fs.writeFile tearing: it writes 3 bytes, then throws. */
async function tearing(body: () => Promise<void>): Promise<void> {
  const real = fsp.writeFile;
  fsp.writeFile = (async (file: Parameters<typeof real>[0], data: Buffer) => {
    await real(file, data.subarray(0, 3));
    throw new Error("ENOSPC: no space left on device");
  }) as unknown as typeof real;
  syncBuiltinESMExports();
  try {
    await body();
  } finally {
    fsp.writeFile = real;
    syncBuiltinESMExports();
  }
}

/** What is in `dir`, scratch files included. */
const ls = async (dir: string) => (await fsp.readdir(path.join(TMP, dir)).catch(() => [])).sort();

describe("a failed image write", () => {
  before(async () => {
    await fsp.mkdir(path.join(TMP, "branding-images"), { recursive: true });
    await fsp.mkdir(path.join(TMP, "layout-images"), { recursive: true });
  });

  it("saveImage leaves nothing at the final name or beside it, and the next call writes it whole", async () => {
    await tearing(async () => {
      await assert.rejects(saveImage("branding-images", DATA_URL), /ENOSPC/);
    });
    assert.deepEqual(await ls("branding-images"), [], "a torn file or its scratch was left");
    const ref = await saveImage("branding-images", DATA_URL);
    assert.deepEqual((await readImage("branding-images", ref.split("/").pop()!))?.data, PNG);
  });

  it("restoreImage leaves nothing behind", async () => {
    await fsp.rm(path.join(TMP, "branding-images"), { recursive: true, force: true });
    await fsp.mkdir(path.join(TMP, "branding-images"), { recursive: true });
    await tearing(async () => {
      await assert.rejects(restoreImage("branding-images", `${HASH}.png`, PNG), /ENOSPC/);
    });
    assert.deepEqual(await ls("branding-images"), []);
    assert.equal(await restoreImage("branding-images", `${HASH}.png`, PNG), true);
  });

  it("saveLayoutImage leaves nothing behind", async () => {
    await tearing(async () => {
      await assert.rejects(saveLayoutImage(DATA_URL), /ENOSPC/);
    });
    assert.deepEqual(await ls("layout-images"), []);
  });

  it("saveLayoutImageBytes does not mistake a torn file for the image on the next import", async () => {
    // It used to write under the final name with `wx`, so a write that died halfway
    // left a short file, and the next import saw EEXIST and answered "already here".
    await tearing(async () => {
      await assert.rejects(saveLayoutImageBytes(`${HASH}.png`, PNG), /ENOSPC/);
    });
    assert.deepEqual(await ls("layout-images"), []);
    assert.equal(await saveLayoutImageBytes(`${HASH}.png`, PNG), true, "the torn file was taken for the image");
    assert.deepEqual(await fsp.readFile(path.join(TMP, "layout-images", `${HASH}.png`)), PNG);
    assert.equal(await saveLayoutImageBytes(`${HASH}.png`, PNG), false, "an image already here is written again");
  });

  it("listImages does not list a write in flight", async () => {
    await fsp.writeFile(path.join(TMP, "branding-images", `.${HASH}.png.1.2.tmp`), "x");
    assert.ok(!(await listImages("branding-images")).some((f) => f.startsWith(".")));
  });
});
