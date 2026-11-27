// The restore-ceiling note counts the whole file a backup downloads as.
//
// It used to count the base64 of the images and originals alone, so a backup whose
// images sat just under POST /api/config/import's ceiling and whose config files took
// it over said nothing, and its download was then refused on restore. Driven through
// build() and the export's own serialisation.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-restore-ceiling-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { configSnapshot } = await import("./config-snapshot.js");
const { MAX_CONFIG_BODY_BYTES } = await import("./routes/context.js");
const { BRANDING_IMAGE_DIR } = await import("./branding-image-store.js");

after(() => fs.rm(TMP, { recursive: true, force: true }));

async function warningsOfBuild(): Promise<{ warned: string[]; fileBytes: number }> {
  const warned: string[] = [];
  const real = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  try {
    const snapshot = await configSnapshot.build();
    // What GET /api/config/export writes, byte for byte.
    return { warned, fileBytes: Buffer.byteLength(JSON.stringify(snapshot, null, 2), "utf8") };
  } finally {
    console.warn = real;
  }
}

describe("the restore-ceiling note", () => {
  it("counts the config files too: images just under the ceiling plus settings over it are said", async () => {
    // Images whose base64 alone is 1 MB under the ceiling.
    const dir = path.join(TMP, BRANDING_IMAGE_DIR);
    await fs.mkdir(dir, { recursive: true });
    const raw = Math.floor(((MAX_CONFIG_BODY_BYTES - 1024 * 1024) * 3) / 4);
    await fs.writeFile(path.join(dir, `${"a".repeat(16)}.png`), Buffer.alloc(raw, 7));
    // And 2 MB of config beside them.
    await fs.writeFile(path.join(TMP, "servicecue-layouts.json"), JSON.stringify([{ id: "l", name: "x".repeat(2 * 1024 * 1024), order: 0 }]));

    const { warned, fileBytes } = await warningsOfBuild();
    assert.ok(fileBytes > MAX_CONFIG_BODY_BYTES, `the fixture does not pass the ceiling: ${fileBytes}`);
    assert.equal(
      warned.filter((w) => w.startsWith("[config-snapshot] this backup carries")).length,
      1,
      `a backup whose download would be refused said nothing: ${warned.join("\n")}`,
    );
  });
});
