// A Q-SYS config save through integrationManager.setConfig, the route
// POST /api/integrations/qsys/config takes: the two meter rates go to the rates
// store (clamped to 1-30), never into settings.json's integration config, and
// come back on the state the card re-seeds from. Qsys stays DISABLED, so the
// save stops the service rather than dialling anything. Same seeding as
// safespace-marker-writes.test.ts, for the same reason (init() cannot run here).

import assert from "node:assert/strict";
import { describe, test, beforeEach, mock } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-qsys-save-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { integrationManager, configuredFor } = await import("./../integration-manager.js");
const { qsysSettingsStore } = await import("./qsys-settings-store.js");

const manager = integrationManager as unknown as { states: Map<string, { config: Record<string, unknown> }> };

function seed(config: Record<string, unknown>): void {
  manager.states.set("qsys", { id: "qsys", enabled: false, connection: "disconnected", message: null, config } as never);
}

const save = (config: Record<string, unknown>) => integrationManager.setConfig("qsys", config);

async function settingsOnDisk(): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await fs.readFile(path.join(TMP, "settings.json"), "utf8")) as {
    integrationConfigs?: Record<string, Record<string, unknown>>;
  };
  return raw.integrationConfigs?.qsys ?? {};
}

beforeEach(async () => {
  await qsysSettingsStore.saveRates({ volunteerMeterHz: 10, staffMeterHz: 20 });
  seed({ volunteerMeterHz: 10, staffMeterHz: 20 });
});

describe("saving the Q-SYS card", () => {
  test("a rate is stored in the rates store, not in the integration's config", async () => {
    await save({ host: "10.0.0.5", port: 1710, volunteerMeterHz: 15, staffMeterHz: 25 });
    assert.deepEqual(await qsysSettingsStore.loadRates(), { volunteerMeterHz: 15, staffMeterHz: 25 });
    const disk = await settingsOnDisk();
    assert.equal(disk.host, "10.0.0.5");
    assert.equal("volunteerMeterHz" in disk, false, "the rate went into settings.json as well as its own store");
    assert.equal("staffMeterHz" in disk, false);
  });

  test("the state the card re-seeds from carries the saved rates", async () => {
    const state = await save({ host: "10.0.0.5", volunteerMeterHz: 12 });
    assert.equal(state.config.volunteerMeterHz, 12);
    assert.equal(state.config.staffMeterHz, 20);
  });

  test("a rate out of range is clamped to 1-30 on the server", async () => {
    const state = await save({ host: "10.0.0.5", volunteerMeterHz: 500, staffMeterHz: 0 });
    assert.deepEqual(await qsysSettingsStore.loadRates(), { volunteerMeterHz: 30, staffMeterHz: 1 });
    assert.equal(state.config.volunteerMeterHz, 30);
  });

  test("a save without rates leaves the stored rates alone", async () => {
    await save({ host: "10.0.0.5", volunteerMeterHz: 17 });
    await save({ host: "10.0.0.6" });
    assert.equal((await qsysSettingsStore.loadRates()).volunteerMeterHz, 17);
  });
});

/** The [qsys] lines a save writes, via console.log and console.warn. */
async function linesFrom(config: Record<string, unknown>): Promise<string[]> {
  const log = mock.method(console, "log", () => {});
  const warn = mock.method(console, "warn", () => {});
  try {
    await save(config);
    return [...log.mock.calls, ...warn.mock.calls].map((c) => String(c.arguments[0])).filter((l) => l.startsWith("[qsys]"));
  } finally {
    log.mock.restore();
    warn.mock.restore();
  }
}

describe("what a Q-SYS save says on /log", () => {
  test("a rate that changed is logged", async () => {
    const lines = await linesFrom({ host: "h", volunteerMeterHz: 15, staffMeterHz: 20 });
    assert.deepEqual(lines, ["[qsys] meter rates set: volunteer 15/s, staff 20/s"]);
  });

  test("the dialog's every-save post of unchanged rates is silent", async () => {
    assert.deepEqual(await linesFrom({ host: "h", volunteerMeterHz: 10, staffMeterHz: 20 }), []);
  });

  test("a rate that is not a number is named, never its value, and the stored rate stays", async () => {
    const lines = await linesFrom({ host: "h", volunteerMeterHz: "fast-secret" });
    assert.deepEqual(lines, ["[qsys] ignoring a non-numeric volunteerMeterHz; the stored rate is unchanged"]);
    assert.equal((await qsysSettingsStore.loadRates()).volunteerMeterHz, 10);
  });
});

describe("a Q-SYS card is configured only once it has a host", () => {
  test("the rates alone do not make it configured", () => {
    assert.equal(configuredFor({ id: "qsys", config: { volunteerMeterHz: 10, staffMeterHz: 20, password: "" } }, {} as never, false), false);
  });

  test("a host does", () => {
    assert.equal(configuredFor({ id: "qsys", config: { host: "10.0.0.5", volunteerMeterHz: 10 } }, {} as never, false), true);
  });
});
