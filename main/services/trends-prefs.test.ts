// The Trends card's organisation-wide sound metric: validated, saved before it
// is published, broadcast on change only, hydrated on connect, and carried by a
// backup. Real files, the real broadcaster, the real route handler and the real
// hello burst.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { before, describe, it, mock } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-trends-prefs-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { trendsPrefs, TrendsPrefs, TrendsPrefsRefused } = await import("./trends-prefs.js");
const { addBroadcastListener } = await import("./broadcaster.js");
const { configFiles, runtimeFiles } = await import("./config-snapshot.js");
const { historyRoutes } = await import("./routes/history-routes.js");
const { callRoute } = await import("./routes/route-harness.js");
const { ROUTE_MODULES, writeHelloBurst } = await import("./remote-server.js");
type TrendsPrefsState = import("../types/trends-prefs.js").TrendsPrefsState;

const FILE = path.join(TMP, "trends-prefs.json");
const onDisk = async () => (JSON.parse(await fs.readFile(FILE, "utf8")) as { soundMetric: string | null }).soundMetric;

const frames: TrendsPrefsState[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === "trends:prefs") frames.push(payload as TrendsPrefsState);
});
const logged: string[] = [];
mock.method(console, "log", (...a: unknown[]) => void logged.push(a.map(String).join(" ")));

before(async () => {
  await trendsPrefs.start();
});

describe("trends prefs", () => {
  it("is config: a restore onto a fresh box brings the choice with it", () => {
    assert.ok(configFiles().includes("trends-prefs.json"));
    assert.ok(!runtimeFiles().includes("trends-prefs.json"));
  });

  it("starts unset", () => {
    assert.deepEqual(trendsPrefs.state(), { rev: 0, soundMetric: null });
  });

  it("saves to disk before it answers, bumps the rev, broadcasts, and says so on the log", async () => {
    const s = await trendsPrefs.setSoundMetric("LCeq 2");
    assert.deepEqual(s, { rev: 1, soundMetric: "LCeq 2" });
    assert.equal(await onDisk(), "LCeq 2");
    assert.deepEqual(frames.at(-1), { rev: 1, soundMetric: "LCeq 2" });
    assert.ok(logged.includes("[history] Trends sound metric set to LCeq 2"), logged.join("\n"));
  });

  it("an unchanged value writes nothing and broadcasts nothing", async () => {
    const before = frames.length;
    const logs = logged.length;
    await trendsPrefs.setSoundMetric("LCeq 2");
    assert.equal(frames.length, before);
    assert.equal(logged.length, logs);
    assert.equal(trendsPrefs.state().rev, 1);
  });

  it("null clears back to the default", async () => {
    await trendsPrefs.setSoundMetric(null);
    assert.deepEqual(trendsPrefs.state(), { rev: 2, soundMetric: null });
    assert.equal(await onDisk(), null);
    assert.ok(logged.includes("[history] Trends sound metric cleared (default)"));
    await trendsPrefs.setSoundMetric("LAeq 2");
  });

  it("refuses what is not a metric name, and changes nothing", async () => {
    const rev = trendsPrefs.state().rev;
    for (const bad of ["", " LAeq 2", "LAeq 2\nforged", "__proto__\u0000", "x".repeat(60), 7, undefined, {}, ["LAeq 2"]]) {
      await assert.rejects(trendsPrefs.setSoundMetric(bad), TrendsPrefsRefused, `value ${JSON.stringify(bad)}`);
    }
    assert.equal(trendsPrefs.state().rev, rev);
    assert.equal(await onDisk(), "LAeq 2");
  });

  it("accepts every key shape Smaart sends", async () => {
    for (const ok of ["LAeq 1", "LAeq 10", "LCeq 2", "SPL Fast", "SPL A Slow", "SPL C Slow"]) {
      await trendsPrefs.setSoundMetric(ok);
      assert.equal(trendsPrefs.state().soundMetric, ok);
    }
    await trendsPrefs.setSoundMetric("LAeq 2");
  });

  it("a write that fails throws and leaves the published choice alone", async () => {
    const rev = trendsPrefs.state().rev;
    const before = frames.length;
    // The data dir is gone: the atomic write cannot land.
    const aside = `${TMP}-aside`;
    await fs.rename(TMP, aside);
    try {
      await assert.rejects(trendsPrefs.setSoundMetric("SPL Fast"));
    } finally {
      await fs.rename(aside, TMP);
    }
    assert.equal(trendsPrefs.state().soundMetric, "LAeq 2", "memory must not run ahead of the disk");
    assert.equal(trendsPrefs.state().rev, rev);
    assert.equal(frames.length, before, "nothing was published for a choice that was not saved");
  });

  it("a restart reads the choice back", async () => {
    const fresh = new TrendsPrefs();
    await fresh.start();
    assert.equal(fresh.state().soundMetric, "LAeq 2");
  });
});

describe("/api/history/trends-prefs", () => {
  it("is dispatched by the server", () => {
    assert.ok(ROUTE_MODULES.includes(historyRoutes));
  });

  it("POST chooses, GET reads it back", async () => {
    const post = await callRoute(historyRoutes, "/api/history/trends-prefs", { method: "POST", body: { soundMetric: "SPL Fast" } });
    assert.equal(post.status, 200);
    assert.equal((post.json as TrendsPrefsState).soundMetric, "SPL Fast");
    const get = await callRoute(historyRoutes, "/api/history/trends-prefs");
    assert.equal((get.json as TrendsPrefsState).soundMetric, "SPL Fast");
  });

  it("a body that is not a metric is a 400 that says so; a missing soundMetric is too", async () => {
    for (const body of [{ soundMetric: "a\nb" }, { soundMetric: 3 }, {}]) {
      const r = await callRoute(historyRoutes, "/api/history/trends-prefs", { method: "POST", body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match((r.json as { error: string }).error, /soundMetric/);
    }
    assert.equal(trendsPrefs.state().soundMetric, "SPL Fast");
  });

  it("null clears it", async () => {
    const r = await callRoute(historyRoutes, "/api/history/trends-prefs", { method: "POST", body: { soundMetric: null } });
    assert.equal(r.status, 200);
    assert.equal((r.json as TrendsPrefsState).soundMetric, null);
  });
});

describe("the hello burst", () => {
  it("hydrates trends:prefs with the current choice, so a card opened later still shows it", async () => {
    await trendsPrefs.setSoundMetric("LCeq 2");
    const sink = { collected: [] as { channel: string; serialized: string }[] };
    writeHelloBurst(sink);
    const frame = sink.collected.find((f) => f.channel === "trends:prefs");
    assert.ok(frame, `the burst did not hydrate trends:prefs: ${sink.collected.map((f) => f.channel).join(", ")}`);
    assert.equal((JSON.parse(frame.serialized) as TrendsPrefsState).soundMetric, "LCeq 2");
  });
});
