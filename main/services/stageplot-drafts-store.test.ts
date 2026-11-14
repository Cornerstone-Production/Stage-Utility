// stageplot-drafts.json's own rules: one draft per plot, at most MAX_DRAFTS, each with a real
// time. checkDraftsDoc is the restore check (a backup from any device on the LAN is held to it)
// and the rule every write keeps; a load reads what parses, and is never held to it.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stageplot-drafts-store-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { MAX_DRAFTS, checkDraftsDoc, plotDraftsStore } = await import("./stageplot-drafts-store.js");
const { restoreCheckFor } = await import("./store-registry.js");

after(() => fs.rm(TMP, { recursive: true, force: true }));

const draft = (plotId: string, over: Record<string, unknown> = {}) => ({ plotId, baseVersion: 0, items: [], savedAt: "2026-11-14T14:32:00.000Z", ...over });

/** Each way a drafts file is refused, and what the refusal says. */
const REFUSED: [string, unknown, RegExp][] = [
  ["the same plot twice", { drafts: [draft("p-1"), draft("p-2"), draft("p-1", { baseVersion: 3 })] }, /plot "p-1" has more than one draft/],
  ["more drafts than there can be plots", { drafts: Array.from({ length: MAX_DRAFTS + 1 }, (_, i) => draft(`p-${i}`)) }, new RegExp(`at most ${MAX_DRAFTS} plot drafts`)],
  ["a time that is not one", { drafts: [draft("p-1", { savedAt: "yesterday" })] }, /the draft for plot "p-1"'s time must be an ISO date and time/],
  ["no time at all", { drafts: [draft("p-1", { savedAt: undefined })] }, /the draft for plot "p-1"'s time must be an ISO date and time/],
];

describe("the plot drafts file", () => {
  test("as many drafts as there can be plots, one each, is a file it keeps, sorted by plot", () => {
    const all = Array.from({ length: MAX_DRAFTS }, (_, i) => draft(`p-${String(MAX_DRAFTS - i).padStart(4, "0")}`));
    const read = checkDraftsDoc({ drafts: all });
    assert.equal(read.drafts.length, MAX_DRAFTS);
    assert.equal(read.drafts[0].plotId, "p-0001");
  });

  for (const [what, file, says] of REFUSED) {
    test(`a restore of ${what} is refused`, async () => {
      assert.throws(() => checkDraftsDoc(file), says);
      const check = restoreCheckFor("stageplot-drafts.json");
      assert.ok(check, "stageplot-drafts.json has no restore check");
      const r = await check(file);
      assert.equal(r.ok, false, `a restore took ${what}`);
      assert.match(r.ok ? "" : r.reason, says);
    });
  }

  test("a write that would leave the same plot twice is refused, and leaves the file as it was", async () => {
    await plotDraftsStore.update(() => [draft("p-1")]);
    await assert.rejects(() => plotDraftsStore.update((d) => [...d, draft("p-1", { baseVersion: 2 })]), /plot "p-1" has more than one draft/);
    assert.deepEqual(await plotDraftsStore.all(), [draft("p-1")]);
  });
});
