// Which plan notes feed the pre-service checklist, and the ways a request can
// eat the operator's choices.
//
// DRIVEN THROUGH THE ROUTE, the way bar-config-store.test.ts is driven, and for
// the same reason: the bug only exists in the route's own coercion of a body it
// was handed. Calling setChecklistSources with a hand-built pair cannot see it.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

// Set before the module graph loads, so the stores this route file reaches read
// an empty tree instead of the operator's real config.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "checklist-sources-"));
process.env.STAGE_UTILITY_DATA = DIR;

const { systemRoutes } = await import("./routes/system-routes.js");
const { callRoute } = await import("./routes/route-harness.js");

after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

const save = (body: unknown) =>
  callRoute(systemRoutes, "/api/checklist-sources", { method: "POST", body: body as never });

/** What actually reached the disk — the cache reads as saved either way. */
const onDisk = () => {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, "settings.json"), "utf8")) as {
    checklistNoteCategories?: string[];
    checklistNoteTeams?: string[];
  };
  return { categories: raw.checklistNoteCategories ?? [], teams: raw.checklistNoteTeams ?? [] };
};

describe("POST /api/checklist-sources", () => {
  test("both lists save", async () => {
    const out = await save({ categories: ["Audio Notes"], teams: ["Front of House"] });
    assert.equal(out.status, 200);
    assert.deepEqual(onDisk(), { categories: ["Audio Notes"], teams: ["Front of House"] });
  });

  test("THE GUARD: saving only the categories leaves the teams alone", async () => {
    // THE BUG. `list(v)` returned [] for anything that was not an array, and
    // the route passed both lists positionally — so a body naming only one
    // list handed the setter [] for the other and deleted it, with a 200.
    await save({ categories: ["Audio Notes", "Video Notes"] });

    assert.deepEqual(onDisk().teams, ["Front of House"], "saving the categories wiped the teams");
    assert.deepEqual(onDisk().categories, ["Audio Notes", "Video Notes"]);
  });

  test("THE GUARD, mirrored: saving only the teams leaves the categories alone", async () => {
    // Not symmetric by construction — each list is resolved on its own line —
    // so each direction is its own guard.
    await save({ teams: ["Front of House", "Broadcast"] });

    assert.deepEqual(
      onDisk().categories,
      ["Audio Notes", "Video Notes"],
      "saving the teams wiped the categories",
    );
    assert.deepEqual(onDisk().teams, ["Front of House", "Broadcast"]);
  });

  test("an explicit empty list clears that one, and only that one", async () => {
    // NOT the same as omitting it: [] means "no note feeds the checklist from
    // this side", so it has to stay writable or the picker's way back to none
    // would silently do nothing.
    await save({ teams: [] });
    assert.deepEqual(onDisk(), { categories: ["Audio Notes", "Video Notes"], teams: [] });
  });

  test("a body naming neither list is refused", async () => {
    const before = onDisk();
    const out = await save({});
    assert.equal(out.status, 400);
    assert.deepEqual(onDisk(), before, "a refused body still reached the store");
  });

  test("a list that is not a list of strings is refused, and changes nothing", async () => {
    // Both lists are optional. "Optional" must not have quietly become
    // "unvalidated" — this is the LAN-facing surface, and the old filter turned
    // every one of these into a silent [].
    const before = onDisk();
    const bodies = [
      { categories: "Audio Notes" },
      { categories: [1, 2] },
      { teams: "Front of House" },
      { teams: [null] },
      { categories: ["Audio Notes"], teams: 7 },
    ];
    for (const body of bodies) {
      const out = await save(body);
      assert.equal(out.status, 400, `accepted ${JSON.stringify(body)}`);
    }
    assert.deepEqual(onDisk(), before, "a refused body still reached the store");
  });
});
