// A backup made from a real install restores unchanged.
//
// config-restore-checks.test.ts round-trips hand-written fixtures. This starts
// from an empty data directory, lets the controller write what a first start
// writes (the default screen and view, every default setting, the legacy
// displays entry every settings.json still carries), saves a few things through
// the setters the settings pages call, and then restores the backup of that
// over a cleared directory. A check stricter than the save paths shows up here
// as a refusal, or as a file that came back different.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-restore-roundtrip-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { configSnapshot, configFiles } = await import("./config-snapshot.js");
const { stageController } = await import("./stage-controller.js");
const { savedColorsStore } = await import("./saved-colors-store.js");
const { notesStore } = await import("./notes-store.js");
const { historyMilestonesStore } = await import("./history-milestones-store.js");

const ctl = stageController as unknown as { broadcast: () => void; recomputeResolved: () => void; startUpdateChecks: () => void };
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
ctl.startUpdateChecks = () => {};

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

test("the backup of a fresh install, plus saves through the real setters, restores unchanged", async () => {
  await stageController.init();
  await stageController.createView("Wall", "custom", "display");
  await stageController.setPublicUrl("stage.example.org/");
  await stageController.setIconColor("tools/clock", "#FF8800");
  await stageController.setTaperWindow({ preMin: 30.4 });
  await stageController.setReconnectSchedule({ leadMin: 90 });
  await stageController.setBaptismAutoStart({ enabled: true, testimonyKeyword: "stories" });
  await stageController.setAutoUpdate({ mode: "auto-install", hour: 4, dayOfWeek: 0 });
  await stageController.setTimezone("America/Chicago");
  await stageController.setHourCycle("24h");
  await stageController.setCaptionChannelColor("Pastor", "ffcc00");
  await savedColorsStore.init();
  await savedColorsStore.add("#123456");
  await notesStore.set("obj-1", { text: "Spare pack in the rack" });
  await historyMilestonesStore.save({ date: "2026-01-04", label: "New series", serviceTypeId: null });

  const bundle = JSON.parse(JSON.stringify(await configSnapshot.build()));
  for (const name of ["settings.json", "views.json", "saved-colors.json", "notes.json", "history-milestones.json"]) {
    assert.ok(Object.hasOwn(bundle.files, name), `${name} should be in the backup`);
  }
  for (const name of configFiles()) await fs.rm(path.join(TMP, name), { force: true });

  await configSnapshot.apply(bundle);
  for (const [name, contents] of Object.entries(bundle.files as Record<string, unknown>)) {
    const onDisk = JSON.parse(await fs.readFile(path.join(TMP, name), "utf8"));
    assert.deepEqual(onDisk, contents, `${name} did not come back as it was saved`);
  }
});

test("the public URL setter refuses what is not a web address, as a restore does", async () => {
  await assert.rejects(() => stageController.setPublicUrl("javascript:alert(1)//"), /http or https/);
});
