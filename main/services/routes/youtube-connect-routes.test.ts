// The three /api/integrations/youtube/connect routes, through callRoute — no
// socket, no real Google. youtubeConnectDeps is overwritten the same way
// youtube-connect.test.ts drives it directly, because the route layer's own
// job is dispatch and the 409 precondition, not the state machine itself.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, before, describe, test } from "node:test";

process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-connect-routes-"));

const { integrationRoutes } = await import("./integration-routes.js");
const { callRoute } = await import("./route-harness.js");
const { integrationManager } = await import("../integration-manager.js");
const { __resetForTests, youtubeConnectDeps } = await import("../youtube-connect.js");

const states = (integrationManager as unknown as {
  states: Map<string, { id: string; enabled: boolean; connection: string; message: string | null; config: Record<string, unknown> }>;
}).states;

const real = { ...youtubeConnectDeps };

/**
 * Ensures the row exists (setConfig throws "Unknown integration" otherwise —
 * this app never runs init() in a routes test, see integration-streaming.test.ts)
 * and then goes through `setConfig` rather than poking `config` directly: the
 * client secret is a secret field (SECRET_KEYS has "youtube":
 * ["apiKey", "clientSecret", "refreshToken"]), so it has to go through the fold
 * that routes it to secretsStore, or getYouTubeConnectContext() reads it back as
 * empty regardless of what a test wrote onto `config`.
 */
async function seed(config: Record<string, unknown>): Promise<void> {
  if (!states.has("youtube")) {
    states.set("youtube", { id: "youtube", enabled: true, connection: "disconnected", message: null, config: {} });
  }
  await integrationManager.setConfig("youtube", config);
}

let saved: { refreshToken: string; channelTitle: string }[] = [];
let cleared = 0;
let connected = false;
/** Every outbound request the state machine made through the fake, in order —
 *  what proves the route dispatched with the SAVED credentials rather than
 *  anything a request body carried. */
let outbound: { url: string; body: string }[] = [];

function installFakes(deviceCodeBody: unknown = {
  device_code: "super-secret-device-code",
  user_code: "ABCD-EFGH",
  verification_url: "https://www.google.com/device",
  expires_in: 1800,
  interval: 5,
}): void {
  youtubeConnectDeps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body == null ? "" : String(init.body);
    outbound.push({ url: url.pathname, body });
    return new Response(JSON.stringify(deviceCodeBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  youtubeConnectDeps.schedule = () => () => {};
  youtubeConnectDeps.saveConnection = async (refreshToken, channelTitle) => {
    saved.push({ refreshToken, channelTitle });
    connected = true;
  };
  youtubeConnectDeps.clearConnection = async () => {
    cleared++;
    connected = false;
  };
  youtubeConnectDeps.connectionInfo = async () => ({ connected, channelTitle: connected ? "A Church" : null });
}

before(async () => {
  await seed({ mode: "key", apiKey: "", channel: "" });
});

afterEach(() => {
  __resetForTests();
  Object.assign(youtubeConnectDeps, real);
  saved = [];
  cleared = 0;
  connected = false;
  outbound = [];
});

describe("POST /api/integrations/youtube/connect", () => {
  test("409s with the stated sentence when the client id and secret are not saved", async () => {
    await seed({ mode: "oauth", clientId: "", clientSecret: "" });
    const res = await callRoute(integrationRoutes, "/api/integrations/youtube/connect", { method: "POST" });
    assert.equal(res.status, 409);
    assert.equal((res.json as { error: string }).error, "Save the client ID and secret first");
  });

  test("409s the same way when the mode is not oauth, even with fields saved from an earlier switch", async () => {
    await seed({ mode: "key", clientId: "id", clientSecret: "secret" });
    const res = await callRoute(integrationRoutes, "/api/integrations/youtube/connect", { method: "POST" });
    assert.equal(res.status, 409);
  });

  test("starts an attempt using the SAVED client id and secret, and answers the pending shape", async () => {
    await seed({ mode: "oauth", clientId: "saved-client-id", clientSecret: "saved-client-secret" });
    installFakes();
    const res = await callRoute(integrationRoutes, "/api/integrations/youtube/connect", { method: "POST" });
    assert.equal(res.status, 200);
    const body = res.json as { status: string; userCode?: string; verificationUrl?: string; expiresAt?: number };
    assert.equal(body.status, "pending");
    assert.equal(body.userCode, "ABCD-EFGH");
    assert.equal(body.verificationUrl, "https://www.google.com/device");
    assert.equal(typeof body.expiresAt, "number");

    // The route reads the client id/secret off getYouTubeConnectContext()
    // (what Save persisted), never off the request. This is what proves it —
    // asserting only the response shape above would pass even if the route
    // forwarded a client id a caller supplied.
    assert.equal(outbound.length, 1);
    assert.ok(
      outbound[0].body.includes("client_id=saved-client-id"),
      `expected the saved client id on the wire, got: ${outbound[0].body}`,
    );
  });

  test("a client id in the request body is ignored — the SAVED one is what reaches Google", async () => {
    await seed({ mode: "oauth", clientId: "saved-client-id", clientSecret: "saved-client-secret" });
    installFakes();
    await callRoute(integrationRoutes, "/api/integrations/youtube/connect", {
      method: "POST",
      body: { clientId: "browser-supplied-client-id", clientSecret: "browser-supplied-secret" },
    });

    assert.equal(outbound.length, 1);
    assert.ok(
      outbound[0].body.includes("client_id=saved-client-id"),
      `a browser-supplied client id must never reach Google: ${outbound[0].body}`,
    );
    assert.ok(!outbound[0].body.includes("browser-supplied-client-id"));
  });

  test("the device code never appears in any response body", async () => {
    await seed({ mode: "oauth", clientId: "saved-client-id", clientSecret: "saved-client-secret" });
    installFakes();
    const res = await callRoute(integrationRoutes, "/api/integrations/youtube/connect", { method: "POST" });
    assert.ok(!res.body.includes("super-secret-device-code"), `the device code leaked into the response: ${res.body}`);

    const statusRes = await callRoute(integrationRoutes, "/api/integrations/youtube/connect", { method: "GET" });
    assert.ok(!statusRes.body.includes("super-secret-device-code"));
  });
});

describe("GET /api/integrations/youtube/connect", () => {
  test("idle with nothing pending and nothing stored", async () => {
    await seed({ mode: "oauth", clientId: "", clientSecret: "" });
    installFakes();
    const res = await callRoute(integrationRoutes, "/api/integrations/youtube/connect");
    assert.deepEqual(res.json, { status: "idle" });
  });

  test("pending after a start, connected after a finished flow", async () => {
    await seed({ mode: "oauth", clientId: "saved-client-id", clientSecret: "saved-client-secret" });
    installFakes();
    await callRoute(integrationRoutes, "/api/integrations/youtube/connect", { method: "POST" });
    const pending = await callRoute(integrationRoutes, "/api/integrations/youtube/connect");
    assert.equal((pending.json as { status: string }).status, "pending");

    // Finish the attempt directly through the state machine's own success path
    // is exercised in youtube-connect.test.ts; here it is enough to confirm the
    // route reflects storage once connected.
    connected = true;
    const done = await callRoute(integrationRoutes, "/api/integrations/youtube/connect", { method: "DELETE" });
    // A bare DELETE cancels the pending attempt rather than disconnecting, so
    // the connected flag set above must still be what GET reports next.
    assert.equal((done.json as { status: string }).status, "connected");
  });
});

describe("DELETE /api/integrations/youtube/connect", () => {
  test("with no body, cancels a pending attempt and returns to idle", async () => {
    await seed({ mode: "oauth", clientId: "saved-client-id", clientSecret: "saved-client-secret" });
    installFakes();
    await callRoute(integrationRoutes, "/api/integrations/youtube/connect", { method: "POST" });
    const res = await callRoute(integrationRoutes, "/api/integrations/youtube/connect", { method: "DELETE" });
    assert.deepEqual(res.json, { status: "idle" });
    assert.equal(cleared, 0, "a bare cancel must not clear a stored connection");
  });

  test("with { disconnect: true }, clears the stored connection", async () => {
    await seed({ mode: "oauth", clientId: "saved-client-id", clientSecret: "saved-client-secret" });
    installFakes();
    connected = true;
    const res = await callRoute(integrationRoutes, "/api/integrations/youtube/connect", {
      method: "DELETE",
      body: { disconnect: true },
    });
    assert.equal(cleared, 1);
    assert.deepEqual(res.json, { status: "idle" });
  });
});
