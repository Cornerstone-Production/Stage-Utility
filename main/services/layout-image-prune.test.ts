// The layout-image prune deletes every stored image no layout references. A
// layout store that cannot be read is served as its defaults, which reference
// nothing, so the prune must not run on it: every image in use would go.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-image-prune-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { pruneLayoutImages } = await import("./layout-image-store.js");

const IMAGES = path.join(TMP, "layout-images");
const OLD = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

/** An image file older than the prune's grace window. */
async function oldImage(name: string): Promise<string> {
  const file = path.join(IMAGES, name);
  await fs.mkdir(IMAGES, { recursive: true });
  await fs.writeFile(file, "png");
  await fs.utimes(file, OLD, OLD);
  return file;
}

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("pruneLayoutImages", () => {
  it("removes nothing while views.json cannot be read", async () => {
    const used = await oldImage("in-use.png");
    // A directory where the file should be fails the read for root as well.
    await fs.mkdir(path.join(TMP, "views.json"));
    try {
      assert.equal(await pruneLayoutImages(), 0);
      await fs.access(used);
    } finally {
      await fs.rm(path.join(TMP, "views.json"), { recursive: true });
    }
  });

  it("still removes what nothing references once the stores read", async () => {
    // in-use.png from the case above is unreferenced too: no views exist now.
    const files = [path.join(IMAGES, "in-use.png"), await oldImage("orphan.png")];
    assert.equal(await pruneLayoutImages(), files.length);
    for (const f of files) await assert.rejects(fs.access(f));
  });
});
