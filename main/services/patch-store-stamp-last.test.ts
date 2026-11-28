// A patch.json stamped at the last moment a Date can hold (hand-edited, or restored from somewhere that wrote it)
// still takes a save: the next stamp stays there instead of stepping past it, where toISOString() throws and every
// save after would fail. Its own file: it starts on that patch.json, and a store reads its file once.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "patch-store-stamp-last-"));
process.env.STAGE_UTILITY_DATA = TMP;
const LAST = new Date(8.64e15).toISOString();
await fs.writeFile(path.join(TMP, "patch.json"), JSON.stringify({ sheets: [], updatedAt: LAST }));

const { patchStore } = await import("./patch-store.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

test("a save over a file stamped at the last moment a Date can hold goes through", async () => {
  const saved = await patchStore.save({ sheets: [], updatedAt: "" });
  assert.equal(saved.updatedAt, LAST);
  assert.equal((await patchStore.loadStrict()).updatedAt, LAST, "the save did not reach the file");
});
