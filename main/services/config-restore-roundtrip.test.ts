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
import { deflateSync } from "node:zlib";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-restore-roundtrip-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { configSnapshot, configFiles } = await import("./config-snapshot.js");
const { stageController } = await import("./stage-controller.js");
const { savedColorsStore } = await import("./saved-colors-store.js");
const { notesStore } = await import("./notes-store.js");
const { historyMilestonesStore } = await import("./history-milestones-store.js");
const { saveLayoutImage } = await import("./layout-image-store.js");
const { claim, updateDevices } = await import("./kiosk-devices-store.js");
const { videoService } = await import("./video/video-service.js");
const { automationEngine } = await import("./automation-engine.js");

/** A real 1x1 PNG, built here so the branding upload's content check sees one. */
function tinyPng(): string {
  const crc = (buf: Buffer): number => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const idat = deflateSync(Buffer.from([0, 255, 0, 0]));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** An SVG that opens with a doctype: the layout upload stores it, and has never
 *  checked an image's bytes, so a backup of it must restore. */
const DOCTYPE_SVG =
  '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#2e6691"/></svg>';

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
  // A slots screen gets a board of its own, so slots.json's boards half is in the
  // backup and goes through its restore check too.
  await stageController.createView("Mics", "slots", "display");
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
  await stageController.setBranding({ logo: tinyPng() });
  const layoutImage = await saveLayoutImage(`data:image/svg+xml;base64,${Buffer.from(DOCTYPE_SVG).toString("base64")}`);
  await stageController.addOutput({ name: "Lobby" });
  const lobby = stageController.getState().outputs.find((o) => o.name === "Lobby")!;
  await stageController.setOutputSlug(lobby.id, " Lobby-TV ");
  await updateDevices((d) => claim(d, "pi-lobby", lobby.id, { secret: "s3cret", macs: ["aa:bb:cc:dd:ee:ff"], hostname: "lobby-pi" }).devices);
  const feed = await videoService.addFeed({ name: "Porch cam", source: { kind: "pull", url: "rtsp://192.0.2.10/stream", username: "" } });
  assert.ok(feed.ok, JSON.stringify(feed));
  await automationEngine.init();
  await automationEngine.addRule({
    name: "Lights off",
    enabled: false,
    trigger: { id: "call.by-name", params: { name: "lights_off" } },
    conditions: [],
    action: { id: "rosstalk.command", params: {} },
    cooldownSec: 0,
    oncePerService: false,
  } as unknown as Parameters<typeof automationEngine.addRule>[0]);
  const mics = stageController.getState().views.find((v) => v.name === "Mics")!;
  await stageController.setViewSlots(mics.id, [
    { id: "s1", channel: "07", order: 0, link: { kind: "pco", matchBy: "position", positions: [{ name: "Vocals" }] }, deviceBinding: null, displayName: null, photoUrl: null } as never,
  ], { kind: "default", serviceTypeId: "123" });

  const bundle = JSON.parse(JSON.stringify(await configSnapshot.build()));
  for (const name of ["settings.json", "views.json", "saved-colors.json", "notes.json", "history-milestones.json", "kiosk-devices.json", "video-feeds.json", "automation-rules.json", "slots.json"]) {
    assert.ok(Object.hasOwn(bundle.files, name), `${name} should be in the backup`);
  }
  const images = Object.keys(bundle.images ?? {});
  assert.ok(images.includes(layoutImage.slice(1)), `the layout image ${layoutImage} should be in the backup`);
  assert.ok(images.some((ref) => ref.startsWith("branding-images/")), "the logo should be in the backup");
  for (const name of configFiles()) await fs.rm(path.join(TMP, name), { force: true });
  for (const ref of images) await fs.rm(path.join(TMP, ref), { force: true });

  await configSnapshot.apply(bundle);
  for (const [name, contents] of Object.entries(bundle.files as Record<string, unknown>)) {
    const onDisk = JSON.parse(await fs.readFile(path.join(TMP, name), "utf8"));
    assert.deepEqual(onDisk, contents, `${name} did not come back as it was saved`);
  }
  for (const [ref, b64] of Object.entries((bundle.images ?? {}) as Record<string, string>)) {
    assert.equal((await fs.readFile(path.join(TMP, ref))).toString("base64"), b64, `${ref} did not come back`);
  }
});

test("the public URL setter refuses what is not a web address, as a restore does", async () => {
  await assert.rejects(() => stageController.setPublicUrl("javascript:alert(1)//"), /http or https/);
});

test("the caption colour setter writes no key a restore would refuse", async () => {
  for (const channel of ["__proto__", "constructor", "prototype"]) {
    await stageController.setCaptionChannelColor(channel, "#ffcc00");
  }
  const colors = stageController.getState().captionChannelColors;
  assert.ok(
    !["__proto__", "constructor", "prototype"].some((k) => Object.hasOwn(colors, k)),
    `an unsafe channel name was stored: ${JSON.stringify(Object.keys(colors))}`,
  );
});
