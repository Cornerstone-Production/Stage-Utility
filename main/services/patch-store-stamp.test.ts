// Every patch save is stamped after the file it replaces. newest() orders a read against the last
// save by that stamp, so a stage plot save that read the patch before a patch save landed takes the
// newer file: a save in the same millisecond as the one before it, or after the clock stepped back,
// must still stamp later. Its own file: it starts on a patch.json a clock an hour ahead wrote, and a
// store reads its file once.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, mock, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "patch-store-stamp-"));
process.env.STAGE_UTILITY_DATA = TMP;
// Written before a restart by a clock that has since been set back an hour.
const AHEAD = new Date(Date.now() + 3_600_000).toISOString();
await fs.writeFile(path.join(TMP, "patch.json"), JSON.stringify({ sheets: [], updatedAt: AHEAD }));

const { patchStore } = await import("./patch-store.js");
type PatchFile = import("../types/patch.js").PatchFile;

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

const sheet = (name: string): PatchFile => ({
  updatedAt: "",
  sheets: [{ id: "main", name, kind: "analog", devices: [], endpoints: [], variants: [], assignments: { byServiceType: {}, byPlan: {} } }],
});

// First: the case needs the file the earlier clock wrote, before any save replaces it.
test("a save after the clock stepped back is stamped after the file it replaces, and overtakes a read of it", async () => {
  const read = await patchStore.loadStrict();
  assert.equal(read.updatedAt, AHEAD);
  const saved = await patchStore.save(sheet("After the restart"));
  assert.ok(saved.updatedAt > AHEAD, `stamped ${saved.updatedAt}, not after the file it replaced (${AHEAD})`);
  assert.equal(patchStore.newest(read), saved, "a read made before the save was taken over the save");
});

test("two saves in the same millisecond are stamped in the order they were saved", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const first = await patchStore.save(sheet("First"));
    const read = await patchStore.loadStrict();
    const second = await patchStore.save(sheet("Second"));
    assert.ok(second.updatedAt > first.updatedAt, `the second save was stamped ${second.updatedAt}, the first ${first.updatedAt}`);
    assert.equal(patchStore.newest(read), second, "a read of the first save was taken over the second");
    // The last save is its own newest: a read of it is not overtaken by anything.
    assert.equal(patchStore.newest(await patchStore.loadStrict()).sheets[0]!.name, "Second");
    // A file whose stamp is not a date (hand-written, or an older build's) is older than any save: as text, "h" sorts after "2".
    assert.equal(patchStore.newest({ ...first, updatedAt: "hand-written" }), second, "a file with no date for a stamp was taken over the last save");
  } finally {
    mock.timers.reset();
  }
});
