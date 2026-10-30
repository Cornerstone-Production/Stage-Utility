// POST /api/devices/:id/health, driven through the real route against the real
// stores. The point is who may post, and that a post which is not allowed leaves
// no trace: a health reading for an output that was never set up, or one posted
// with somebody else's secret, would put a number on a screen that is not true.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-output-health-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { kioskDeviceRoutes } = await import("./kiosk-device-routes.js");
const { callRoute } = await import("./route-harness.js");
const { kioskDevicesStore, updateDevices } = await import("../kiosk-devices-store.js");
const { restoreCheckFor } = await import("../stores.js");
const { healthList, resetKioskPresence } = await import("../kiosk-presence.js");
const { addBroadcastListener } = await import("../broadcaster.js");

const ID = "02aa00bb11cc.sdi-1";
const SECRET = "secret-of-sdi-1";
const REPORT = { fps: 59.94, repeated: 0.2, dropped: 0, at: 1_700_000_000_000 };

const sent: { channel: string; payload: { health?: { deviceId: string }[] } }[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === "kiosk:devices") sent.push({ channel, payload: payload as (typeof sent)[number]["payload"] });
});

beforeEach(async () => {
  resetKioskPresence();
  await updateDevices(() => [
    {
      id: ID, token: SECRET, outputId: "display-1", macs: ["02:aa:00:bb:11:cc"], hostname: "booth-mini",
      output: { kind: "decklink", name: "SDI 1", port: "SDI 1" },
    },
  ]);
  // After the binding is written: writing it announces, and that is not a frame
  // the tests below are counting.
  sent.length = 0;
});

const post = (id: string, body: unknown, opts: { token?: string; query?: string } = {}) =>
  callRoute(kioskDeviceRoutes, `/api/devices/${encodeURIComponent(id)}/health${opts.query ?? ""}`, {
    method: "POST",
    body,
    headers: opts.token ? { "x-device-token": opts.token } : {},
  });

describe("who may post health", () => {
  it("the device itself, with its secret in x-device-token", async () => {
    const r = await post(ID, REPORT, { token: SECRET });
    assert.equal(r.status, 200);
    assert.deepEqual(healthList().map((h) => [h.deviceId, h.fps, h.repeated, h.dropped]), [[ID, 59.94, 0.2, 0]]);
  });

  it("and not as ?token=: the helper sends the header only", async () => {
    const r = await post(ID, REPORT, { query: `?token=${SECRET}` });
    assert.equal(r.status, 401);
    assert.deepEqual(healthList(), [], "a secret in the query string was accepted");
  });

  it("not without a secret: 401, and nothing is recorded", async () => {
    const r = await post(ID, REPORT);
    assert.equal(r.status, 401);
    assert.deepEqual(healthList(), [], "an unauthenticated post was recorded");
  });

  it("not with somebody else's secret: 401, and nothing is recorded", async () => {
    const r = await post(ID, REPORT, { token: "not-the-secret" });
    assert.equal(r.status, 401);
    assert.deepEqual(healthList(), []);
  });

  it("not for a device this server holds no binding for: the same 401, so ids cannot be enumerated", async () => {
    const unknown = await post("someone-else.sdi-9", REPORT, { token: SECRET });
    const wrong = await post(ID, REPORT, { token: "not-the-secret" });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body, wrong.body, "an unknown id and a wrong secret answered differently");
    assert.deepEqual(healthList(), []);
  });

  it("not for a binding whose secret is not pinned yet, whatever it presents", async () => {
    await updateDevices((cur) => [...cur, { id: "unpinned.sdi-2", token: "", outputId: "display-2", macs: [], output: { kind: "decklink", name: "SDI 2", port: "SDI 2" } }]);
    for (const token of ["anything", ""]) {
      const r = await post("unpinned.sdi-2", REPORT, token ? { token } : {});
      assert.equal(r.status, 401, `token ${JSON.stringify(token)}`);
    }
    assert.deepEqual(healthList(), [], "an unpinned binding took a health report");
  });
});

describe("what it refuses to record", () => {
  it("a body that is not a report: 400, and nothing is recorded", async () => {
    for (const body of [{}, { ...REPORT, fps: "fast" }, { ...REPORT, dropped: -1 }, { ...REPORT, repeated: 400 }]) {
      const r = await post(ID, body, { token: SECRET });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(((r.json as { error?: string }) ?? {}).error, "a refusal must say why");
    }
    assert.deepEqual(healthList(), []);
  });

  it("a latencyMs that is not a number from 0 to 10000: 400 naming it, and nothing is recorded", async () => {
    for (const latencyMs of [-5, 10_001, "20", true]) {
      const r = await post(ID, { ...REPORT, latencyMs }, { token: SECRET });
      assert.equal(r.status, 400, JSON.stringify(latencyMs));
      assert.match(((r.json as { error?: string }) ?? {}).error ?? "", /latencyMs/);
    }
    assert.deepEqual(healthList(), [], "a report with a bad latency was recorded");
  });

  it("a path whose id is not valid percent-encoding: 400, not a crash", async () => {
    const r = await callRoute(kioskDeviceRoutes, "/api/devices/%E0%A4%A/health", { method: "POST", body: REPORT });
    assert.equal(r.status, 400);
  });
});

describe("latencyMs", () => {
  it("is stored with the reading, and listed by GET /api/devices", async () => {
    const r = await post(ID, { ...REPORT, latencyMs: 20.5 }, { token: SECRET });
    assert.equal(r.status, 200);
    assert.deepEqual(healthList().map((h) => h.latencyMs), [20.5]);
    const listed = (await callRoute(kioskDeviceRoutes, "/api/devices")).json as { health: { latencyMs?: number }[] };
    assert.deepEqual(listed.health.map((h) => h.latencyMs), [20.5]);
  });

  it("stays absent when the report carries none, or null", async () => {
    for (const body of [REPORT, { ...REPORT, latencyMs: null }]) {
      resetKioskPresence();
      const r = await post(ID, body, { token: SECRET });
      assert.equal(r.status, 200);
      assert.equal("latencyMs" in healthList()[0], false, "an unmeasured latency appeared on the reading");
    }
  });

  it("a latency that moves a whole millisecond is broadcast, a steady one is not", async () => {
    await post(ID, { ...REPORT, latencyMs: 20 }, { token: SECRET });
    assert.equal(sent.length, 1);
    await post(ID, { ...REPORT, latencyMs: 20.3, at: REPORT.at + 10_000 }, { token: SECRET });
    assert.equal(sent.length, 1, "a steady latency broadcast on every report");
    await post(ID, { ...REPORT, latencyMs: 25, at: REPORT.at + 20_000 }, { token: SECRET });
    assert.equal(sent.length, 2, "a changed latency never reached Screens");
    assert.deepEqual(sent[1].payload.health?.map((h) => (h as { latencyMs?: number }).latencyMs), [25]);
  });

  it("does not make an output struggle, however long", async () => {
    for (let i = 0; i < 6; i++) await post(ID, { ...REPORT, latencyMs: 9_000, at: REPORT.at + i }, { token: SECRET });
    assert.deepEqual(healthList().map((h) => h.struggling), [false]);
  });
});

describe("what Screens is told", () => {
  it("the first report is broadcast, an unchanged one is not, a changed one is", async () => {
    await post(ID, REPORT, { token: SECRET });
    assert.equal(sent.length, 1, "the first report never reached Screens");
    assert.deepEqual(sent[0].payload.health?.map((h) => h.deviceId), [ID]);

    // Ten seconds later, the same picture: not news.
    await post(ID, { ...REPORT, fps: 59.93, at: REPORT.at + 10_000 }, { token: SECRET });
    assert.equal(sent.length, 1, "a steady output broadcast on every report");

    await post(ID, { ...REPORT, dropped: 3, at: REPORT.at + 20_000 }, { token: SECRET });
    assert.equal(sent.length, 2, "a rising dropped count never reached Screens");
  });

  it("GET /api/devices carries it, and never the secret", async () => {
    await post(ID, REPORT, { token: SECRET });
    const r = await callRoute(kioskDeviceRoutes, "/api/devices");
    const body = r.json as { health: { deviceId: string; fps: number }[]; bound: { id: string }[] };
    assert.deepEqual(body.health.map((h) => [h.deviceId, h.fps]), [[ID, 59.94]]);
    assert.equal(r.body.includes(SECRET), false, "the device secret was listed");
  });

  it("a DeckLink output on a run of dropped frames is struggling, and a display output is not", async () => {
    const DISPLAY_ID = "02aa00bb11cc.hdmi-1";
    await updateDevices((cur) => [
      ...cur,
      { id: DISPLAY_ID, token: "secret-hdmi", outputId: "display-2", macs: [], output: { kind: "display", name: "HDMI 1", port: "HDMI 1" } },
    ]);
    for (const dropped of [0, 5, 10, 15]) {
      await post(ID, { ...REPORT, dropped }, { token: SECRET });
      await post(DISPLAY_ID, { ...REPORT, fps: 0, dropped }, { token: "secret-hdmi" });
    }
    const byId = Object.fromEntries(healthList().map((h) => [h.deviceId, h.struggling]));
    assert.deepEqual(byId, { [ID]: true, [DISPLAY_ID]: false });
  });

  it("releasing the device forgets what it reported", async () => {
    await post(ID, REPORT, { token: SECRET });
    const released = await callRoute(kioskDeviceRoutes, "/api/devices/release", { method: "POST", body: { deviceId: ID } });
    assert.equal(released.status, 200);
    assert.deepEqual(healthList(), [], "a released output still showed its old health");
  });
});

describe("switching an output on and off", () => {
  const setEnabled = (deviceId: string, enabled: unknown) =>
    callRoute(kioskDeviceRoutes, "/api/devices/enabled", { method: "POST", body: { deviceId, enabled } });
  const stored = async () => (await kioskDevicesStore.loadStrict()).find((d) => d.id === ID);

  it("a post is answered with what Screens wants, on until it is switched off", async () => {
    const r = await post(ID, REPORT, { token: SECRET });
    assert.deepEqual(r.json, { ok: true, enabled: true });
  });

  it("Screens switches it off, and the helper's next post is told so", async () => {
    const r = await setEnabled(ID, false);
    assert.equal(r.status, 200);
    assert.equal((await stored())?.enabled, false);
    const answer = await post(ID, { ...REPORT, enabled: true }, { token: SECRET });
    assert.deepEqual(answer.json, { ok: true, enabled: false });
  });

  it("and back on: the stored flag goes away rather than saying true", async () => {
    await setEnabled(ID, false);
    await setEnabled(ID, true);
    assert.equal("enabled" in ((await stored()) ?? {}), false);
    assert.deepEqual((await post(ID, REPORT, { token: SECRET })).json, { ok: true, enabled: true });
  });

  it("an output that is off posts no figures and is not struggling, and keeps being heard", async () => {
    await setEnabled(ID, false);
    for (let i = 0; i < 4; i++) await post(ID, { enabled: false }, { token: SECRET });
    assert.deepEqual(healthList().map((h) => [h.deviceId, h.enabled, h.struggling]), [[ID, false, false]]);
  });

  it("an echo of the Mac's value never overrides Screens", async () => {
    await setEnabled(ID, false);
    // The Mac has not caught up: it still says on, with no `changed`.
    const r = await post(ID, { ...REPORT, enabled: true }, { token: SECRET });
    assert.deepEqual(r.json, { ok: true, enabled: false });
    assert.equal((await stored())?.enabled, false, "a stale echo switched the output back on");
  });

  it("a change made on the Mac itself is taken, once, and Screens then shows it", async () => {
    const r = await post(ID, { enabled: false, changed: "c1" }, { token: SECRET });
    assert.deepEqual(r.json, { ok: true, enabled: false });
    assert.equal((await stored())?.enabled, false);
    // And the Mac switching it back on is taken the same way.
    const back = await post(ID, { ...REPORT, enabled: true, changed: "c2" }, { token: SECRET });
    assert.deepEqual(back.json, { ok: true, enabled: true });
    assert.equal("enabled" in ((await stored()) ?? {}), false);
  });

  it("the same change sent again, after a lost reply or replayed, is taken once and cannot undo Screens", async () => {
    await post(ID, { enabled: false, changed: "c1" }, { token: SECRET });
    assert.equal((await stored())?.enabled, false);
    // The operator switches it back on in Screens, then the Mac's retry arrives.
    await setEnabled(ID, true);
    const retry = await post(ID, { enabled: false, changed: "c1" }, { token: SECRET });
    assert.deepEqual(retry.json, { ok: true, enabled: true });
    assert.equal("enabled" in ((await stored()) ?? {}), false, "a retried change undid what Screens set");
    // A new change is still taken.
    const fresh = await post(ID, { enabled: false, changed: "c2" }, { token: SECRET });
    assert.deepEqual(fresh.json, { ok: true, enabled: false });
  });

  it("only the device's own secret may say it changed, and a refused post changes nothing", async () => {
    const r = await post(ID, { enabled: false, changed: "c1" }, { token: "not-the-secret" });
    assert.equal(r.status, 401);
    assert.equal("enabled" in ((await stored()) ?? {}), false, "an unauthenticated post switched an output off");
    assert.equal(r.body.includes("enabled"), false, "the flag was in a refusal");
  });

  it("the switch answers 400 to a body that is not an object", async () => {
    for (const body of [null, [], "x"]) {
      const r = await callRoute(kioskDeviceRoutes, "/api/devices/enabled", { method: "POST", body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  });

  it("the switch refuses what it cannot do", async () => {
    assert.equal((await setEnabled(ID, "no")).status, 400);
    assert.equal((await setEnabled("", true)).status, 400);
    assert.equal((await setEnabled("someone-else.sdi-9", false)).status, 404);
    await updateDevices((cur) => [...cur, { id: "pi-1", token: "t", outputId: "display-3", macs: [] }]);
    const pi = await setEnabled("pi-1", false);
    assert.equal(pi.status, 400, "a Pi kiosk was given a switch that does nothing");
    assert.equal("enabled" in (((await kioskDevicesStore.loadStrict()).find((d) => d.id === "pi-1")) ?? {}), false);
  });

  it("the switch does not list the secret", async () => {
    await setEnabled(ID, false);
    const list = await callRoute(kioskDeviceRoutes, "/api/devices");
    assert.equal(list.body.includes(SECRET), false);
    assert.equal((list.json as { bound: { id: string; enabled?: boolean }[] }).bound.find((d) => d.id === ID)?.enabled, false);
  });

  it("a restored binding keeps a false switch and drops any other value", async () => {
    const run = restoreCheckFor("kiosk-devices.json");
    assert.ok(run, "kiosk-devices.json has no restore check");
    const r = (await run([
      { id: "a.1", outputId: "o1", enabled: false },
      { id: "b.1", outputId: "o2", enabled: true },
      { id: "c.1", outputId: "o3", enabled: "no" },
    ])) as { ok: boolean; value: { id: string; enabled?: boolean }[] };
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.map((d) => [d.id, d.enabled]), [["a.1", false], ["b.1", undefined], ["c.1", undefined]]);
  });
});

describe("the log says what the switch did", () => {
  const lines: string[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  beforeEach(() => {
    lines.length = 0;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    console.warn = (...a: unknown[]) => { lines.push(a.join(" ")); };
  });
  after(() => { console.log = realLog; console.warn = realWarn; });
  const switchLines = () => lines.filter((l) => l.includes("[output-helper]") && l.includes(ID));
  const setEnabled = (enabled: boolean) =>
    callRoute(kioskDeviceRoutes, "/api/devices/enabled", { method: "POST", body: { deviceId: ID, enabled } });

  it("says a switch from Screens, once, and nothing when it changes nothing", async () => {
    await setEnabled(false);
    await setEnabled(false);
    assert.deepEqual(switchLines().map((l) => l.replace(/^.*\[output-helper\] /, "")), [`${ID} (decklink "SDI 1") switched off from Screens`]);
  });

  it("says a switch made on the Mac", async () => {
    await post(ID, { enabled: false, changed: "c1" }, { token: SECRET });
    assert.deepEqual(switchLines().map((l) => l.replace(/^.*\[output-helper\] /, "")), [`${ID} was switched off on its Mac`]);
  });

  it("says once, after two posts, that the Mac has not answered, and again after it has", async () => {
    await setEnabled(false);
    lines.length = 0;
    await post(ID, { ...REPORT, enabled: true }, { token: SECRET });
    assert.equal(switchLines().length, 0, "warned after one post");
    await post(ID, { ...REPORT, enabled: true }, { token: SECRET });
    assert.match(switchLines().join("\n"), /is set off in Screens and it still says on after 2 health posts/);
    await post(ID, { ...REPORT, enabled: true }, { token: SECRET });
    assert.equal(switchLines().length, 1, "warned on every post, not once");
    // The Mac answers; the next disagreement counts again from one.
    await post(ID, { enabled: false }, { token: SECRET });
    await setEnabled(true);
    lines.length = 0;
    await post(ID, { enabled: false }, { token: SECRET });
    assert.equal(switchLines().length, 0);
    await post(ID, { enabled: false }, { token: SECRET });
    assert.match(switchLines().join("\n"), /is set on in Screens and it still says off/);
  });

  it("says an old helper does not report it, only for an output that is off", async () => {
    await post(ID, REPORT, { token: SECRET });
    await post(ID, REPORT, { token: SECRET });
    assert.equal(switchLines().length, 0, "an old helper on an output that is on was warned about");
    await setEnabled(false);
    lines.length = 0;
    await post(ID, REPORT, { token: SECRET });
    await post(ID, REPORT, { token: SECRET });
    assert.match(switchLines().join("\n"), /its helper does not report it/);
  });

  it("a struggling output that is switched off does not log a recovery", async () => {
    for (const dropped of [0, 5, 10, 15]) await post(ID, { ...REPORT, dropped }, { token: SECRET });
    lines.length = 0;
    await post(ID, { enabled: false }, { token: SECRET });
    assert.equal(lines.some((l) => l.includes("has recovered")), false, "a switch off was logged as a recovery");
  });
});
