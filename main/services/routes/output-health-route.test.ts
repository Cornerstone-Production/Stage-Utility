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

const post = (id: string, body: unknown, opts: { bearer?: string; query?: string } = {}) =>
  callRoute(kioskDeviceRoutes, `/api/devices/${encodeURIComponent(id)}/health${opts.query ?? ""}`, {
    method: "POST",
    body,
    headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
  });

describe("who may post health", () => {
  it("the device itself, with its secret as a bearer token", async () => {
    const r = await post(ID, REPORT, { bearer: SECRET });
    assert.equal(r.status, 200);
    assert.deepEqual(healthList().map((h) => [h.deviceId, h.fps, h.repeated, h.dropped]), [[ID, 59.94, 0.2, 0]]);
  });

  it("or with it as ?token=, as /enroll takes it", async () => {
    const r = await post(ID, REPORT, { query: `?token=${SECRET}` });
    assert.equal(r.status, 200);
    assert.equal(healthList().length, 1);
  });

  it("not without a secret: 401, and nothing is recorded", async () => {
    const r = await post(ID, REPORT);
    assert.equal(r.status, 401);
    assert.deepEqual(healthList(), [], "an unauthenticated post was recorded");
  });

  it("not with somebody else's secret: 401, and nothing is recorded", async () => {
    for (const opts of [{ bearer: "not-the-secret" }, { query: "?token=not-the-secret" }]) {
      const r = await post(ID, REPORT, opts);
      assert.equal(r.status, 401, JSON.stringify(opts));
    }
    assert.deepEqual(healthList(), []);
  });

  it("not for a device this server holds no binding for: 404", async () => {
    const r = await post("someone-else.sdi-9", REPORT, { bearer: SECRET });
    assert.equal(r.status, 404);
    assert.deepEqual(healthList(), []);
  });
});

describe("what it refuses to record", () => {
  it("a body that is not a report: 400, and nothing is recorded", async () => {
    for (const body of [{}, { ...REPORT, fps: "fast" }, { ...REPORT, dropped: -1 }, { ...REPORT, repeated: 400 }]) {
      const r = await post(ID, body, { bearer: SECRET });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(((r.json as { error?: string }) ?? {}).error, "a refusal must say why");
    }
    assert.deepEqual(healthList(), []);
  });

  it("a path whose id is not valid percent-encoding: 400, not a crash", async () => {
    const r = await callRoute(kioskDeviceRoutes, "/api/devices/%E0%A4%A/health", { method: "POST", body: REPORT });
    assert.equal(r.status, 400);
  });
});

describe("what Screens is told", () => {
  it("the first report is broadcast, an unchanged one is not, a changed one is", async () => {
    await post(ID, REPORT, { bearer: SECRET });
    assert.equal(sent.length, 1, "the first report never reached Screens");
    assert.deepEqual(sent[0].payload.health?.map((h) => h.deviceId), [ID]);

    // Ten seconds later, the same picture: not news.
    await post(ID, { ...REPORT, fps: 59.93, at: REPORT.at + 10_000 }, { bearer: SECRET });
    assert.equal(sent.length, 1, "a steady output broadcast on every report");

    await post(ID, { ...REPORT, dropped: 3, at: REPORT.at + 20_000 }, { bearer: SECRET });
    assert.equal(sent.length, 2, "a rising dropped count never reached Screens");
  });

  it("GET /api/devices carries it, and never the secret", async () => {
    await post(ID, REPORT, { bearer: SECRET });
    const r = await callRoute(kioskDeviceRoutes, "/api/devices");
    const body = r.json as { health: { deviceId: string; fps: number }[]; bound: { id: string }[] };
    assert.deepEqual(body.health.map((h) => [h.deviceId, h.fps]), [[ID, 59.94]]);
    assert.equal(r.body.includes(SECRET), false, "the device secret was listed");
  });

  it("releasing the device forgets what it reported", async () => {
    await post(ID, REPORT, { bearer: SECRET });
    const released = await callRoute(kioskDeviceRoutes, "/api/devices/release", { method: "POST", body: { deviceId: ID } });
    assert.equal(released.status, 200);
    assert.deepEqual(healthList(), [], "a released output still showed its old health");
  });
});
