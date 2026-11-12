// "Make a role for each" asks the server to add a role for every category of a service
// type that no role covers. It reads the categories from Planning Center itself, so when
// it adds nothing (not connected, or every category already in a role) the page has
// nothing to show for the click. The /log page has: one [servicecue] line per seed, saying
// what it made or why it made nothing, and one for a Planning Center read that failed.
//
// Driven through the real controller and roles store, with Planning Center's answer
// stubbed on the controller.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, test, mock } from "node:test";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-seed-log-"));
process.env.STAGE_UTILITY_DATA = dir;
process.env.HOME = path.join(dir, "home");

const { stageController } = await import("./stage-controller.js");
const { serviceCueRolesStore } = await import("./servicecue-roles-store.js");

afterEach(() => mock.restoreAll());
after(() => fs.rm(dir, { recursive: true, force: true }));

/** Every console.log line `run` writes. */
async function linesOf(run: () => Promise<unknown>): Promise<{ lines: string[]; error: unknown }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  let error: unknown = null;
  try {
    await run();
  } catch (err) {
    error = err;
  } finally {
    console.log = log;
  }
  return { lines: lines.filter((l) => l.startsWith("[servicecue]")), error };
}

test("a seed that adds roles names them", async () => {
  await serviceCueRolesStore.save([{ id: "r1", name: "Audio", members: ["Audio"] }]);
  mock.method(stageController, "listServiceCueNoteCategories", async () => ["Audio", "Lights", "Stage notes"]);
  const { lines } = await linesOf(() => stageController.seedServiceCueRoles("st1"));
  assert.deepEqual(lines, ["[servicecue] made 2 role(s) for service type st1: Lights, Stage notes"]);
});

test("a seed that adds nothing says why", async () => {
  mock.method(stageController, "listServiceCueNoteCategories", async () => ["audio"]);
  const covered = await linesOf(() => stageController.seedServiceCueRoles("st1"));
  assert.deepEqual(covered.lines, ["[servicecue] made no roles for service type st1: all 1 of its categories are in a role"]);

  mock.restoreAll();
  mock.method(stageController, "listServiceCueNoteCategories", async () => []);
  const none = await linesOf(() => stageController.seedServiceCueRoles("st2"));
  assert.deepEqual(none.lines, ["[servicecue] made no roles for service type st2: Planning Center listed no categories for it"]);
});

test("a Planning Center read that fails is said, and still fails the seed", async () => {
  mock.method(stageController, "listServiceCueNoteCategories", async () => {
    throw new Error("Planning Center answered 502");
  });
  const { lines, error } = await linesOf(() => stageController.seedServiceCueRoles("st1"));
  assert.match(String(error), /502/, "the failure was swallowed");
  assert.deepEqual(lines, ["[servicecue] could not make roles for service type st1: Planning Center answered 502"]);
});
