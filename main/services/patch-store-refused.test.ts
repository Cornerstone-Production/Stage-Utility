// A patch save the store refuses broadcasts nothing: patch:updated follows a save that landed,
// or /patch, the editor and the stage plots publisher would follow a patch that is not on disk.
// Its own file: it starts on a patch.json that cannot be read, and a store reads its file once.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "patch-store-refused-"));
process.env.STAGE_UTILITY_DATA = TMP;
// A directory where the file should be: every read fails, so saves are refused until a restart.
await fs.mkdir(path.join(TMP, "patch.json"));
const quiet = console.error;
console.error = () => undefined;

const { addBroadcastListener } = await import("./broadcaster.js");
const { patchStore } = await import("./patch-store.js");

after(async () => {
  console.error = quiet;
  await fs.rm(TMP, { recursive: true, force: true });
});

test("a refused patch save broadcasts nothing", async () => {
  const heard: unknown[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel === "patch:updated") heard.push(payload);
  });
  await assert.rejects(patchStore.loadStrict());
  await assert.rejects(patchStore.save({ sheets: [], updatedAt: "" }));
  assert.deepEqual(heard, []);
});
