// A deleted screen, and the tags that still named it.
//
// Left behind, the id reads as a member that is simply never online: a tag's
// screen count includes it, so "the foyer (7)" means six. It was also worse than
// cosmetic while the Now board stood one member in for a whole tag — a tag whose
// FIRST member had been deleted showed a blank card, which is how this was
// found, on real data.

import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-utility-signage-prune-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
process.env.HOME = path.join(TMP, "home");

const { signageGroupsStore, forgetOutputInSignageGroups } = await import("./signage-groups-store.js");

// It returns `{ changed, error? }` rather than a bare count: 0 also means "there
// was nothing to change", so a caller could not tell a clean no-op from a failed
// write — and the state this cleanup prevents (a screen gone from the settings
// and still named by every tag) would have persisted silently.

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  await signageGroupsStore.save([]);
});

describe("removing a screen", () => {
  test("drops it from every tag, and says how many changed", async () => {
    await signageGroupsStore.save([
      { id: "g1", name: "Foyer", outputIds: ["display-1", "gone"], createdAt: "" },
      { id: "g2", name: "Hall", outputIds: ["gone"], createdAt: "" },
      { id: "g3", name: "Cafe", outputIds: ["display-2"], createdAt: "" },
    ]);
    assert.deepEqual(await forgetOutputInSignageGroups("gone"), { changed: 2 });
    const after = await signageGroupsStore.load();
    assert.deepEqual(
      after.map((g) => g.outputIds),
      [["display-1"], [], ["display-2"]],
    );
  });

  test("leaves a tag that never named it completely alone", async () => {
    await signageGroupsStore.save([
      { id: "g1", name: "Foyer", outputIds: ["display-1"], createdAt: "" },
    ]);
    assert.deepEqual(await forgetOutputInSignageGroups("display-9"), { changed: 0 });
    assert.deepEqual((await signageGroupsStore.load())[0].outputIds, ["display-1"]);
  });

  test("a tag with no outputIds at all does not stop the removal", async () => {
    // A hand-edited store. A screen must still be deletable.
    await signageGroupsStore.save([{ id: "g1", name: "Broken", createdAt: "" } as never]);
    assert.deepEqual(await forgetOutputInSignageGroups("display-1"), { changed: 0 });
  });

  test("an empty tag list is not an error", async () => {
    assert.deepEqual(await forgetOutputInSignageGroups("display-1"), { changed: 0 });
  });
});
