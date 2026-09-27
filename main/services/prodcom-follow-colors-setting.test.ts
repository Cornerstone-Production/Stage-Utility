// "Follow ProdCom's channel colors" — the persisted setting behind the
// Transcription colors panel's switch.
//
// Stored in settings.json beside captionChannelColors, not in the ProdCom
// integration's own config (host/port/apiKey) — it is a caption DISPLAY
// preference, the same category as the per-channel picks, not a connection
// setting. settings.json is in CONFIG_FILES, so this rides along verbatim in
// every config export and restore; the round-trip test below drives that
// through the real configSnapshot.build()/apply(), not by trusting the
// classification.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "prodcom-follow-colors-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { stageController } = await import("./stage-controller.js");
const { configSnapshot, configFiles } = await import("./config-snapshot.js");

const SETTINGS_FILE = path.join(TMP, "settings.json");

async function readSettingsFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")) as Record<string, unknown>;
}

describe("follow ProdCom's channel colors", () => {
  it("is off by default", () => {
    assert.equal(stageController.getState().followProdcomColors, false);
  });

  it("is declared in settings.json, which config export/restore already covers", () => {
    // Not a new store to classify (see CLAUDE.md's config/runtime rule) — a new
    // FIELD on one already in CONFIG_FILES. Checked directly rather than
    // trusted: a typo landing it in a different file would silently drop it
    // from every backup with this suite green otherwise.
    assert.ok(configFiles().includes("settings.json"), "settings.json is not in CONFIG_FILES");
  });

  it("setFollowProdcomColors persists to disk and updates live state", async () => {
    const state = await stageController.setFollowProdcomColors(true);
    assert.equal(state.followProdcomColors, true, "the returned state was not updated");
    assert.equal(stageController.getState().followProdcomColors, true, "the live state was not updated");
    const onDisk = await readSettingsFile();
    assert.equal(onDisk.followProdcomColors, true, "the setting was not written to settings.json");
  });

  it("survives a config export and restore", async () => {
    await stageController.setFollowProdcomColors(true);
    const exported = await configSnapshot.build();
    const settingsFile = exported.files["settings.json"] as Record<string, unknown> | undefined;
    assert.ok(settingsFile, "settings.json was not captured in the export at all");
    assert.equal(settingsFile.followProdcomColors, true, "the export did not carry the setting");

    // Change it locally, so restoring is what brings the exported value back —
    // not that it never left.
    await stageController.setFollowProdcomColors(false);
    assert.equal((await readSettingsFile()).followProdcomColors, false);

    // apply() writes the snapshot's files straight to disk; a real restore
    // then restarts the process so every in-memory store re-reads them (see
    // config-snapshot-restore.test.ts) — that restart is existing, separately
    // tested machinery, so this checks what apply() itself is responsible for:
    // the file on disk.
    await configSnapshot.apply(exported);
    assert.equal(
      (await readSettingsFile()).followProdcomColors,
      true,
      "the restored settings.json does not have the exported value back",
    );
  });
});
