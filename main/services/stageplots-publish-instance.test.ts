// The publisher as the app wires it reads the patch strictly. Its own file: it starts on a
// damaged patch.json, and a store reads its file once.
//
// A non-strict read answers the seed sheets for a damaged file, and every published linked
// point would then go out as "device removed" instead of "patch sheet unavailable".

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stageplots-publish-instance-"));
process.env.STAGE_UTILITY_DATA = TMP;
await fs.writeFile(path.join(TMP, "patch.json"), "{ not json");
const quiet = console.error;
console.error = () => undefined;

const { publisherPatch } = await import("./stageplots-publish-instance.js");

after(async () => {
  console.error = quiet;
  await fs.rm(TMP, { recursive: true, force: true });
});

test("the app's publisher refuses a damaged patch.json rather than reading the seed sheets", async () => {
  await assert.rejects(publisherPatch(), { name: "StoreReadError" });
});
