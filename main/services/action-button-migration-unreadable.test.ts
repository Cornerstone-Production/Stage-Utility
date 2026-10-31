// The Run an action migration when automation-rules.json cannot be read.
//
// Its own file (and so its own process and data dir) because a store that failed
// its first read refuses saves until the server restarts: nothing after this test
// could save a rule.
//
// An unreadable file reads as NO rules, and writing over that is how an operator's
// cues are lost. So nothing converts, nothing is saved, the flag stays unset, and
// the one line says why in the store's own words, not as a failed save.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import type { Output, View } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "action-button-unreadable-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");
// A directory where the file should be: readFile fails with EISDIR, not ENOENT, so it
// is "a file we could not read" and not "a first run".
await fs.mkdir(path.join(TMP, "automation-rules.json"), { recursive: true });

const { stageController } = await import("./stage-controller.js");
const { viewsStore } = await import("./views-store.js");
const { settingsStore } = await import("./settings-store.js");
const { automationStore } = await import("./automation-store.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

type Pass = (views: View[], outputs: Output[]) => Promise<{ views: View[]; outputs: Output[] }>;
const runLoadPass = (stageController as unknown as { applySurfaceMigration: Pass }).applySurfaceMigration.bind(
  stageController,
) as Pass;

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

test("unreadable rules: one precise line, no view changed, the flag unset", async (t) => {
  const views = [
    {
      id: "v-booth",
      name: "Booth",
      kind: "custom",
      createdAt: "",
      surface: "console",
      layout: {
        version: 1,
        canvas: { width: 1920, height: 1080, background: null, fit: "responsive" },
        objects: [
          { id: "b-rec", x: 0.1, y: 0.1, w: 0.2, h: 0.1, z: 1, config: { type: "action-button", actionId: "obs.record", params: {}, label: "Rec" } },
        ],
      },
    },
  ] as unknown as View[];
  await settingsStore.patch({ actionButtonsMigrated: false });
  await viewsStore.save(views);
  const lines = captureConsole(t, "log", "error");

  const out = await runLoadPass(await viewsStore.load(), []);

  const said = lines.filter((l) => l.includes("were not converted"));
  assert.equal(said.length, 1, JSON.stringify(lines));
  assert.match(said[0]!, /^\[automation\] Run an action buttons were not converted: automation-rules\.json could not be read \(EISDIR\)/);
  assert.equal(said[0]!.includes("could not be saved"), false, "reported as a failed save, not as what it was");
  // Home is seeded by the same pass, so it is the Booth view alone that is read.
  const typeIn = (list: readonly View[]) => list.find((v) => v.id === "v-booth")?.layout?.objects[0]?.config.type;
  assert.equal(typeIn(out.views), "action-button", "a Button was converted without its rule");
  assert.equal(typeIn(await viewsStore.load()), "action-button");
  assert.equal((await settingsStore.get()).actionButtonsMigrated, false);
  assert.equal(automationStore.refusingSaves() !== null, true);
});
