// A branding image uploaded through setBranding must reach stage:state as the
// stored `/branding-images/<hash>.<ext>` reference, never as the base64 it arrived
// as.
//
// settingsStore.patch externalizes images, but only for the copy it writes to disk.
// setBranding used to merge the incoming data URL into this.state first, so the full
// image (up to ~1.5 MB each) rode in every stage:state broadcast to every display
// until a restart reloaded the reference from settings. These drive the real
// controller, the real settings store and the real broadcaster against a temp data
// directory, and read the file back off disk to compare.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "branding-state-refs-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { stageController } = await import("./stage-controller.js");
const { addBroadcastListener } = await import("./broadcaster.js");

// A one-pixel PNG, as the branding editor would hand it over.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DATA_URL = `data:image/png;base64,${PNG_B64}`;
const REF = /^\/branding-images\/[0-9a-f]{16}\.png$/;

// Every stage:state-changed payload, as a JSON string -- what the wire carries.
const frames: string[] = [];
addBroadcastListener((channel, payload, serialized) => {
  if (channel === "stage:state-changed") frames.push(serialized ?? JSON.stringify(payload));
});

async function readSettingsFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(TMP, "settings.json"), "utf8")) as Record<string, unknown>;
}

describe("setBranding keeps image bytes out of stage state", () => {
  it("stores logo, empty-slot logo and avatar as references in state, broadcast and disk", async () => {
    frames.length = 0;
    const returned = await stageController.setBranding({
      logo: DATA_URL,
      logoOriginal: DATA_URL,
      emptyLogo: DATA_URL,
      emptyLogoOriginal: DATA_URL,
      avatar: DATA_URL,
      avatarOriginal: DATA_URL,
    });

    const live = stageController.getState();
    for (const [name, state] of [["returned", returned], ["live", live]] as const) {
      assert.match(state.appLogo as string, REF, `${name} state appLogo is not a reference`);
      assert.match(state.emptySlotLogo as string, REF, `${name} state emptySlotLogo is not a reference`);
      assert.match(state.defaultAvatar as string, REF, `${name} state defaultAvatar is not a reference`);
    }

    assert.equal(frames.length, 1, "expected exactly one stage:state broadcast");
    const sent = JSON.parse(frames[0]) as Record<string, unknown>;
    assert.match(sent.appLogo as string, REF, "broadcast appLogo is not a reference");
    assert.match(sent.emptySlotLogo as string, REF, "broadcast emptySlotLogo is not a reference");
    assert.match(sent.defaultAvatar as string, REF, "broadcast defaultAvatar is not a reference");
    assert.ok(!frames[0].includes("data:image/"), "the broadcast frame still carries a data URL");
    assert.ok(!frames[0].includes(PNG_B64), "the broadcast frame still carries the image bytes");

    // Memory and disk agree, so a restart changes nothing the displays can see.
    const onDisk = await readSettingsFile();
    assert.equal(onDisk.appLogo, live.appLogo);
    assert.equal(onDisk.emptySlotLogo, live.emptySlotLogo);
    assert.equal(onDisk.defaultAvatar, live.defaultAvatar);
    assert.match(onDisk.appLogoOriginal as string, REF, "the pre-crop original was not externalized");
  });

  it("a reference passed back in is kept, and clearing still clears", async () => {
    const ref = stageController.getState().appLogo as string;
    await stageController.setBranding({ logo: ref });
    assert.equal(stageController.getState().appLogo, ref);

    await stageController.setBranding({ logo: null });
    assert.equal(stageController.getState().appLogo, null);
    assert.equal((await readSettingsFile()).appLogo, null);
  });

  it("a malformed image rejects to the caller and leaves state untouched", async () => {
    const before = stageController.getState();
    await assert.rejects(
      stageController.setBranding({ logo: "data:image/png;base64,!!!not-base64!!!", name: "Should Not Land" }),
    );
    const after = stageController.getState();
    assert.equal(after.appLogo, before.appLogo, "state took the rejected image");
    assert.equal(after.appName, before.appName, "state took half of a rejected update");
  });
});
