// A screen's rotation and video mode are the operator's work, so they have to be
// in a backup. They live on the Output in settings.json, which is a config store,
// and this drives that through the real configSnapshot.build() and apply() rather
// than trusting the classification: a field that rode a different file, or a
// restore that rebuilt the outputs list from known fields only, would lose them
// with every check on the store itself green.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-output-format-persist-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { configSnapshot } = await import("./config-snapshot.js");

const SETTINGS_FILE = path.join(TMP, "settings.json");
const storedOutputs = async (): Promise<Output[]> =>
  ((JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")) as { outputs?: Output[] }).outputs) ?? [];

describe("rotation and video mode in a config backup", () => {
  it("are carried by an export and brought back by a restore", async () => {
    const id = stageController.getState().outputs[0].id;
    await stageController.setOutputRotation(id, 270);
    await stageController.setOutputVideoMode(id, "1080i59.94");

    const exported = await configSnapshot.build();
    const settings = exported.files["settings.json"] as { outputs?: Output[] } | undefined;
    const exportedOutput = settings?.outputs?.find((o) => o.id === id);
    assert.equal(exportedOutput?.rotation, 270, "the export did not carry the rotation");
    assert.equal(exportedOutput?.videoMode, "1080i59.94", "the export did not carry the mode");

    // Put them back the way a fresh screen has them, so the restore is what
    // brings the exported values back and not the fact they never left.
    await stageController.setOutputRotation(id, 0);
    await stageController.setOutputVideoMode(id, "1080p59.94");
    const reset = (await storedOutputs()).find((o) => o.id === id);
    assert.equal(reset?.rotation, 0);
    assert.equal(reset?.videoMode, "1080p59.94");

    await configSnapshot.apply(exported);
    const restored = (await storedOutputs()).find((o) => o.id === id);
    assert.equal(restored?.rotation, 270, "the restored settings.json lost the rotation");
    assert.equal(restored?.videoMode, "1080i59.94", "the restored settings.json lost the mode");
  });
});
