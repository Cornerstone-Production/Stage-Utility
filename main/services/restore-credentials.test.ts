// A config restore never sends a stored credential to an address it was not
// entered for.
//
// A snapshot carries addresses and no secrets: secrets.bin stays on the box. So
// a restore replaced the addresses while every stored credential stayed put, and
// the boot after it sent each to wherever the bundle said. A crafted bundle
// pointing OBS at another machine collected the OBS password. Driven through
// configSnapshot.apply, the body of POST /api/config/import, against stores
// seeded the way the app leaves them.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-restore-credentials-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { configSnapshot } = await import("./config-snapshot.js");
const { secretsStore } = await import("./secrets.js");
const { settingsStore } = await import("./settings-store.js");
const { wirelessStore } = await import("./wireless-store.js");
const { wirelessSecretSlot } = await import("./wireless-credentials.js");
const { videoFeedsStore } = await import("./video/feed-store.js");
const { feedSecretSlot } = await import("./video/feed-id.js");
const { DEFAULT_VIDEO_PORTS } = await import("../types/video.js");

const spectera = (id: string, host: string) => ({ id, name: `Base ${id}`, providerId: "sennheiser-spectera", enabled: false, config: { host } });
const pull = (id: string, url: string) => ({ id, name: `Feed ${id}`, source: { kind: "pull" as const, url, username: "" } });
const push = (id: string) => ({ id, name: `Feed ${id}`, source: { kind: "push" as const, protocol: "srt" as const } });

let warned: string[] = [];
const realWarn = console.warn;

beforeEach(async () => {
  warned = [];
  console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
  await settingsStore.patchIntegrationConfig("obs", { host: "obs-a.example", port: 4455 });
  await settingsStore.patchIntegrationConfig("prodcom", { host: "prodcom-a.example", port: 8000 });
  await secretsStore.setManySecrets({
    obs: { password: "obs-password" },
    prodcom: { apiKey: "prodcom-key" },
    [wirelessSecretSlot("stays")]: { password: "stays-password" },
    [wirelessSecretSlot("moves")]: { password: "moves-password" },
    [wirelessSecretSlot("dropped")]: { password: "dropped-password" },
    [feedSecretSlot("cam-stays")]: { password: "cam-stays-password" },
    [feedSecretSlot("cam-moves")]: { password: "cam-moves-password" },
    [feedSecretSlot("cam-dropped")]: { password: "cam-dropped-password" },
    [feedSecretSlot("cam-becomes-push")]: { password: "camera-password" },
    [feedSecretSlot("pushed")]: { password: "publishPassword1" },
    // A slot with no feed behind it: nothing says where it was entered for.
    [feedSecretSlot("orphan")]: { password: "orphan-password" },
  });
  await wirelessStore.save([spectera("stays", "base-a.example"), spectera("moves", "base-b.example"), spectera("dropped", "base-c.example")]);
  await videoFeedsStore.save({
    feeds: [
      pull("cam-stays", "rtsp://cam-a.example/s"),
      pull("cam-moves", "rtsp://cam-b.example/s"),
      pull("cam-dropped", "rtsp://cam-c.example/s"),
      pull("cam-becomes-push", "rtsp://cam-d.example/s"),
      push("pushed"),
    ],
    ports: DEFAULT_VIDEO_PORTS,
  });
});

afterEach(() => {
  console.warn = realWarn;
});

const snapshotOf = (files: Record<string, unknown>) => ({ kind: "stage-utility-config", version: 1, createdAt: "2026-10-20T00:00:00.000Z", files });
const has = async (slot: string) => Object.keys(await secretsStore.getSecrets(slot)).length > 0;

test("a restore clears each credential it would send somewhere new, and only those", async () => {
  await configSnapshot.apply(
    snapshotOf({
      "settings.json": {
        integrationConfigs: {
          obs: { host: "attacker.example", port: 4455 },
          prodcom: { host: "PRODCOM-A.example", port: 8000 },
        },
      },
      "wireless-connections.json": [spectera("stays", "base-a.example"), spectera("moves", "attacker.example")],
      "video-feeds.json": {
        feeds: [
          pull("cam-stays", "rtsp://cam-a.example:554/other-path"),
          pull("cam-moves", "rtsp://attacker.example/s"),
          push("cam-becomes-push"),
          push("pushed"),
          pull("orphan", "rtsp://cam-e.example/s"),
        ],
        ports: DEFAULT_VIDEO_PORTS,
      },
    }),
  );

  assert.equal(await has("obs"), false, "OBS's password survived a restore that moved OBS");
  assert.equal(await has("prodcom"), true, "a restore that left ProdCom where it was cleared its key");

  assert.equal(await has(wirelessSecretSlot("stays")), true);
  assert.equal(await has(wirelessSecretSlot("moves")), false, "a base station's password followed it to a new address");
  assert.equal(await has(wirelessSecretSlot("dropped")), false, "a connection the restore removes left its password behind");

  assert.equal(await has(feedSecretSlot("cam-stays")), true);
  assert.equal(await has(feedSecretSlot("cam-moves")), false, "a camera's password followed the feed to another camera");
  assert.equal(await has(feedSecretSlot("cam-dropped")), false, "a feed the restore removes left its password behind");
  assert.equal(await has(feedSecretSlot("cam-becomes-push")), false, "a camera's password would become a publish password");
  assert.equal(await has(feedSecretSlot("pushed")), true, "a push feed's own publish password was cleared");
  assert.equal(await has(feedSecretSlot("orphan")), false, "a slot nothing owned was handed to the feed the restore adds");

  const lines = warned.filter((l) => l.startsWith("[config-snapshot] cleared the stored credential"));
  // obs; the base station that moves and the one dropped; the camera that
  // moves, the one dropped, the one turned into a push feed, and the orphan.
  assert.equal(lines.length, 7, lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("of obs") && l.includes("attacker.example")));
  for (const secret of ["obs-password", "moves-password", "cam-moves-password"]) {
    assert.ok(!lines.join("\n").includes(secret), "a log line carried a credential");
  }
});

test("a restore whose bundle leaves a store out leaves that store's credentials alone", async () => {
  await configSnapshot.apply(snapshotOf({ "settings.json": { integrationConfigs: { obs: { host: "obs-a.example", port: 4455 }, prodcom: { host: "prodcom-a.example", port: 8000 } } } }));
  for (const slot of ["obs", "prodcom", wirelessSecretSlot("moves"), wirelessSecretSlot("dropped"), feedSecretSlot("cam-moves"), feedSecretSlot("orphan")]) {
    assert.equal(await has(slot), true, `${slot} was cleared by a restore that did not touch it`);
  }
  assert.deepEqual(warned.filter((l) => l.includes("cleared the stored credential")), []);
});
