// POST /api/devices/:id/health, driven through the real route against the real
// stores. The point is who may post, and that a post which is not allowed leaves
// no trace: a health reading for an output that was never set up, or one posted
// with somebody else's secret, would put a number on a screen that is not true.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-output-health-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { kioskDeviceRoutes } = await import("./kiosk-device-routes.js");
const { callRoute } = await import("./route-harness.js");
const { updateDevices } = await import("../kiosk-devices-store.js");
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
