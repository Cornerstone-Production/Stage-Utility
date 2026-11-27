// A Q-SYS config save through integrationManager.setConfig, the route
// POST /api/integrations/qsys/config takes. The two meter rates are ordinary
// integration config: they go into settings.json beside the host, come back on
// the state the card re-seeds from, and reach the service clamped to 1-30 on the
// next apply, with no restart. qsysService.configure is replaced so nothing is
// dialled. Same seeding as safespace-marker-writes.test.ts, for the same reason
// (init() cannot run here).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-qsys-save-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { integrationManager, configuredFor } = await import("./../integration-manager.js");
const { qsysService } = await import("./qsys-service.js");
const { secretsStore } = await import("../secrets.js");
const { settingsStore } = await import("../settings-store.js");
const { MASK } = await import("../mask.js");
type QsysSettings = import("./qsys-settings.js").QsysSettings;

const manager = integrationManager as unknown as { states: Map<string, { config: Record<string, unknown> }> };

function seed(enabled: boolean): void {
  manager.states.set("qsys", { id: "qsys", enabled, connection: "disconnected", message: null, config: {} } as never);
}

const save = (config: Record<string, unknown>) => integrationManager.setConfig("qsys", config);

async function settingsOnDisk(): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await fs.readFile(path.join(TMP, "settings.json"), "utf8")) as {
    integrationConfigs?: Record<string, Record<string, unknown>>;
  };
  return raw.integrationConfigs?.qsys ?? {};
}

/** What the service was last handed, and with which password. */
let configured: { settings: QsysSettings; password: string | null }[] = [];

beforeEach(async () => {
  configured = [];
  mock.method(qsysService, "configure", (settings: QsysSettings, password: string | null) => {
    configured.push({ settings, password });
  });
  mock.method(qsysService, "stop", () => {});
  await secretsStore.setSecrets("qsys", {});
  await settingsStore.removeIntegrationConfigKeys("qsys", ["host", "port", "user", "volunteerMeterHz", "staffMeterHz"]);
  seed(true);
});

afterEach(() => mock.restoreAll());

const last = () => configured.at(-1)?.settings;

describe("saving the Q-SYS card", () => {
  test("the rates are the integration's own config, on disk and on the card's state", async () => {
    const state = await save({ host: "10.0.0.5", port: 1710, volunteerMeterHz: 15, staffMeterHz: 25 });
    const disk = await settingsOnDisk();
    assert.equal(disk.host, "10.0.0.5");
    assert.equal(disk.volunteerMeterHz, 15);
    assert.equal(disk.staffMeterHz, 25);
    assert.equal(state.config.volunteerMeterHz, 15);
    assert.equal(state.config.staffMeterHz, 25);
  });

  test("a rate change reaches the running service on the save, with no restart", async () => {
    await save({ host: "10.0.0.5", port: 1710, volunteerMeterHz: 10, staffMeterHz: 20 });
    await save({ host: "10.0.0.5", port: 1710, volunteerMeterHz: 12, staffMeterHz: 24 });
    assert.equal(configured.length, 2, "the second save did not re-apply the service");
    assert.deepEqual([last()?.volunteerMeterHz, last()?.staffMeterHz], [12, 24]);
  });

  test("no rate saved yet: the service gets the defaults, 10 and 20", async () => {
    await save({ host: "10.0.0.5" });
    assert.deepEqual([last()?.volunteerMeterHz, last()?.staffMeterHz], [10, 20]);
  });

  test("a stored rate out of range reaches the service clamped to 1-30", async () => {
    await save({ host: "10.0.0.5", volunteerMeterHz: 500, staffMeterHz: 0 });
    assert.deepEqual([last()?.volunteerMeterHz, last()?.staffMeterHz], [30, 1]);
  });

  test("a rate stored as typed text is read as its number; one that is not a number reads as the default", async () => {
    await save({ host: "10.0.0.5", volunteerMeterHz: "12", staffMeterHz: "fast" });
    assert.deepEqual([last()?.volunteerMeterHz, last()?.staffMeterHz], [12, 20]);
  });

  test("the user is handed over trimmed", async () => {
    await save({ host: "10.0.0.5", user: "  op  " });
    assert.equal(last()?.user, "op");
  });
});

describe("the Q-SYS password goes only to the Core it was entered for", () => {
  test("a save that moves the host clears it, even when it also changes a rate", async () => {
    await save({ host: "core-a.example", port: 1710, user: "op", password: "s3cret" });
    assert.equal((await secretsStore.getSecrets("qsys")).password, "s3cret");
    await save({ host: "core-b.example", port: 1710, user: "op", password: MASK, volunteerMeterHz: 14 });
    assert.equal((await secretsStore.getSecrets("qsys")).password, undefined, "the password followed the save to another Core");
    assert.equal(last()?.volunteerMeterHz, 14);
    assert.equal(configured.at(-1)?.password, null, "the service was handed the old Core's password for the new one");
  });

  test("a save that changes only a rate keeps it", async () => {
    await save({ host: "core-a.example", port: 1710, user: "op", password: "s3cret" });
    await save({ host: "core-a.example", port: 1710, user: "op", password: MASK, staffMeterHz: 26 });
    assert.equal((await secretsStore.getSecrets("qsys")).password, "s3cret");
    assert.equal(configured.at(-1)?.password, "s3cret");
    assert.equal(last()?.staffMeterHz, 26);
  });
});

describe("a Q-SYS card is configured only once it has a host", () => {
  test("the rates alone do not make it configured", () => {
    assert.equal(configuredFor({ id: "qsys", config: { volunteerMeterHz: 10, staffMeterHz: 20, password: "" } }, {} as never, false), false);
  });

  test("a blank host does not either, the same as the dialler reads it", () => {
    assert.equal(configuredFor({ id: "qsys", config: { host: "   ", volunteerMeterHz: 10 } }, {} as never, false), false);
  });

  test("a host does", () => {
    assert.equal(configuredFor({ id: "qsys", config: { host: "10.0.0.5", volunteerMeterHz: 10 } }, {} as never, false), true);
  });
});
