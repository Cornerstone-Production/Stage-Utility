// Replacing a Mac output helper's token (`--new-token` on the Mac), driven through
// the real routes against the real stores: /enroll, release and claim.
//
// The server pins the secret an output showed when it was set up, and setting a
// screen up again keeps that pin, so a new token alone only locks the output out.
// The documented way through is: the new token on the Mac, then Release on the
// server, then set the output up again. These hold that it works, that the old
// token stops opening the screen only at the release, and that the server says, once,
// why the output is on the holding screen meanwhile.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-token-rotation-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { kioskDeviceRoutes } = await import("./kiosk-device-routes.js");
const { callRoute } = await import("./route-harness.js");
const { kioskDevicesStore } = await import("../kiosk-devices-store.js");
const { recordSeen, resetKioskPresence, forgetSeen } = await import("../kiosk-presence.js");

const ID = "mac-1.decklink-ab-0";
const OLD = "old-secret-0123456789abcdef";
const NEW = "new-secret-fedcba9876543210";
const output = { kind: "decklink" as const, name: "DeckLink 8K Pro (1)", port: "DeckLink 8K Pro (1)" };

/** Where /enroll sends the device: its screen (302), or the holding screen (200). */
async function enroll(token: string): Promise<string> {
  const r = await callRoute(kioskDeviceRoutes, `/enroll?device=${encodeURIComponent(ID)}&token=${token}`);
  if (r.status === 302) return `screen ${r.headers.location}`;
  assert.equal(r.status, 200, r.body);
  return "holding";
}

/** Run `body` and return the [output-helper] lines it logged. */
async function logged(body: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    await body();
  } finally {
    console.log = realLog;
  }
  return lines.filter((l) => l.startsWith("[output-helper]"));
}

beforeEach(async () => {
  resetKioskPresence();
  await kioskDevicesStore.save([{ id: ID, token: OLD, outputId: "display-1", macs: [], output }]);
});

describe("a helper output's token replaced on its Mac", () => {
  it("is set up again with the new token by releasing it and setting it up", async () => {
    assert.equal(await enroll(OLD), `screen /display-1?device=${encodeURIComponent(ID)}`);

    // The new token on the Mac: the screen is not handed over, and the old one
    // still works until the release (the server cannot tell which is the leak).
    assert.equal(await enroll(NEW), "holding");
    assert.equal(await enroll(OLD), `screen /display-1?device=${encodeURIComponent(ID)}`);

    const released = await callRoute(kioskDeviceRoutes, "/api/devices/release", { method: "POST", body: { deviceId: ID } });
    assert.equal(released.status, 200, released.body);
    assert.equal(await enroll(OLD), "holding", "a released output must not be served its screen");

    // The holding screen reloads with the new token, then the output is heard and set up.
    assert.equal(await enroll(NEW), "holding");
    recordSeen({ id: ID, macs: [], hostname: "booth-mini", ip: "192.0.2.40", output });
    const claimed = await callRoute(kioskDeviceRoutes, "/api/devices/claim", { method: "POST", body: { deviceId: ID, outputId: "display-1" } });
    assert.equal(claimed.status, 200, claimed.body);
    // Pinned at the claim, from what the output showed: not left for whichever
    // device asks /enroll first, which could be one holding the old token.
    assert.equal((await kioskDevicesStore.load()).find((d) => d.id === ID)?.token, NEW);

    assert.equal(await enroll(NEW), `screen /display-1?device=${encodeURIComponent(ID)}`);
    assert.equal(await enroll(OLD), "holding", "the old token still opened the screen after it was set up again");
  });

  it("does not pin, after a release, a token shown before it", async () => {
    // Someone holding the leaked token asks /enroll before the operator releases.
    assert.equal(await enroll(OLD), `screen /display-1?device=${encodeURIComponent(ID)}`);
    const released = await callRoute(kioskDeviceRoutes, "/api/devices/release", { method: "POST", body: { deviceId: ID } });
    assert.equal(released.status, 200, released.body);
    const claimed = await callRoute(kioskDeviceRoutes, "/api/devices/claim", { method: "POST", body: { deviceId: ID, outputId: "display-1" } });
    assert.equal(claimed.status, 200, claimed.body);
    assert.equal((await kioskDevicesStore.load()).find((d) => d.id === ID)?.token, "", "a token shown before the release was pinned");
  });

  it("logs the mismatch once, and again only after it has matched", async () => {
    const first = await logged(async () => {
      for (let i = 0; i < 3; i++) {
        assert.equal(await enroll(NEW), "holding");
        // What the discovery responder does on every probe from a bound device.
        forgetSeen(ID);
      }
    });
    assert.equal(first.length, 1, first.join("\n"));
    assert.match(first[0], /^\[output-helper\] mac-1\.decklink-ab-0 showed a token other than the one pinned for screen display-1, so it gets the holding screen; if its token was replaced on its Mac, release it from that screen and set it up again$/);
    assert.ok(!first[0].includes(NEW) && !first[0].includes(OLD), "a token reached the log");

    const again = await logged(async () => {
      await enroll(OLD);
      await enroll(NEW);
    });
    assert.equal(again.length, 1, again.join("\n"));
  });

  it("says nothing for a bound output that shows no token, or a device that is not bound", async () => {
    const lines = await logged(async () => {
      await callRoute(kioskDeviceRoutes, `/enroll?device=${encodeURIComponent(ID)}`);
      await kioskDevicesStore.save([]);
      await enroll(NEW);
    });
    assert.deepEqual(lines, []);
  });
});
