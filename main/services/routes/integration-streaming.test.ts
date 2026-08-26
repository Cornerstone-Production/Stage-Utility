import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, after } from "node:test";

// A scratch data directory, set before the module graph loads, so the managers
// this route file imports read an empty tree instead of the real config.
process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "streaming-"));

// Nothing here may reach Resi or Google. Both services poll the moment they are
// configured, so the stub goes in before the import that starts them.
const realFetch = globalThis.fetch;
/** Every request the services attempt, so a test can assert what went on the
 *  wire rather than only what the code meant to send. */
const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  sent.push({
    url: typeof input === "string" ? input : String((input as Request)?.url ?? input),
    body: typeof init?.body === "string" ? init.body : "",
    // Headers too: the YouTube key moved out of the query string into
    // X-Goog-Api-Key, and the guard below has to follow it there rather than
    // stop asserting that the real key is what gets sent.
    headers: Object.fromEntries(
      Object.entries((init?.headers as Record<string, string> | undefined) ?? {}),
    ),
  });
  // Enough of a reply for the Resi and YouTube happy paths to walk to the end.
  return new Response(
    JSON.stringify({ access_token: "t", expires_in: 3600, customerId: "c", items: [] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

const { integrationRoutes } = await import("./integration-routes.js");
const { callRoute } = await import("./route-harness.js");
const { resiService } = await import("../resi-service.js");
const { youtubeService } = await import("../youtube-service.js");
const { integrationManager } = await import("../integration-manager.js");

/**
 * Seed the two rows this test drives, rather than running the manager's init().
 *
 * init() is the whole appliance coming up — Planning Center, wireless, OSC,
 * SenSource — and none of it is what is under test here. The rows it would
 * create are exactly these, so the dispatch under test sees what it would see in
 * production.
 */
const states = (integrationManager as unknown as {
  states: Map<string, { id: string; enabled: boolean; connection: string; message: string | null; config: Record<string, unknown> }>;
}).states;

after(() => {
  resiService.stop();
  youtubeService.stop();
  globalThis.fetch = realFetch;
});

/**
 * Enabling an integration must start THAT integration.
 *
 * Obvious, and it was still wrong: Resi and YouTube were applied from inside the
 * `id === "reaper"` arm of the dispatch, so configuring either one saved the
 * credentials, reported success, and started nothing. Every widget then sat at
 * "no streaming platform connected" with a fully configured integration behind
 * it and no error anywhere.
 *
 * The observable is the connection state the route itself returns: applying an
 * integration moves it off "disconnected", and skipping the apply leaves it
 * there. Restore the bug — move either call back under the reaper arm — and this
 * goes red on the assertion below, which is how it was found.
 */
const CONFIGS: { name: string; id: string; config: Record<string, string> }[] = [
  { name: "resi", id: "resi", config: { username: "someone@example.org", password: "secret" } },
  // Both YouTube modes, because "configured" means different fields in each and
  // a mode that cannot start is a card that says ready over nothing running.
  { name: "youtube (public channel)", id: "youtube", config: { mode: "key", apiKey: "key", channel: "@example" } },
  {
    name: "youtube (OAuth)",
    id: "youtube",
    config: { mode: "oauth", clientId: "id", clientSecret: "secret", refreshToken: "token" },
  },
];

for (const { name, id, config } of CONFIGS) {
  test(`enabling ${name} starts ${id}`, async () => {
    // Already enabled, credentials arriving: the shape of a first-time setup,
    // where the operator switches it on and then pastes the details in.
    states.set(id, { id, enabled: true, connection: "disconnected", message: null, config: {} });
    const configured = await callRoute(integrationRoutes, `/api/integrations/${id}/config`, {
      method: "POST",
      body: { config },
    });
    assert.notEqual(
      (configured.json as { connection: string }).connection,
      "disconnected",
      `${name} was given credentials while enabled but never applied`,
    );

    // And the other order: credentials already saved, the switch goes on.
    await callRoute(integrationRoutes, `/api/integrations/${id}/enabled`, {
      method: "POST",
      body: { enabled: false },
    });
    const out = await callRoute(integrationRoutes, `/api/integrations/${id}/enabled`, {
      method: "POST",
      body: { enabled: true },
    });
    assert.notEqual(
      (out.json as { connection: string }).connection,
      "disconnected",
      `${name} was configured and enabled but never applied`,
    );

    // And disabling stops it again, so the poll does not outlive the operator
    // turning it off.
    const off = await callRoute(integrationRoutes, `/api/integrations/${id}/enabled`, {
      method: "POST",
      body: { enabled: false },
    });
    assert.equal((off.json as { connection: string }).connection, "disconnected");
  });
}

/**
 * The credentials that reach the wire are the real ones.
 *
 * The state map holds secrets MASKED — the literal string "••••" — and reading
 * a password from there instead of from secretsStore is invisible in every way
 * that matters until production: the field is filled, the card says configured,
 * the integration reports an error that reads like a typo, and a stub server
 * happily accepts the mask. This asserts on the bytes.
 *
 * Reintroduce it — read `password` off `states.get("resi").config` in
 * getResiConfig — and this goes red.
 */
const MASK = "\u2022\u2022\u2022\u2022";

test("Resi is sent the real password, not the mask", async () => {
  states.set("resi", { id: "resi", enabled: true, connection: "disconnected", message: null, config: {} });
  await callRoute(integrationRoutes, "/api/integrations/resi/config", {
    method: "POST",
    body: { config: { username: "someone@example.org", password: "s3cret-resi" } },
  });
  sent.length = 0;
  await callRoute(integrationRoutes, "/api/integrations/resi/test", { method: "POST", body: {} });

  const auth = sent.find((r) => r.url.includes("/auth/token"));
  assert.ok(auth, "Resi was never asked for a token");
  assert.ok(auth.body.includes("s3cret-resi"), `the real password never reached Resi: ${auth.body}`);
  assert.ok(!auth.body.includes(MASK), "the masked placeholder was sent as the password");
});

test("YouTube is sent the real API key, not the mask", async () => {
  states.set("youtube", { id: "youtube", enabled: true, connection: "disconnected", message: null, config: {} });
  await callRoute(integrationRoutes, "/api/integrations/youtube/config", {
    method: "POST",
    body: { config: { mode: "key", apiKey: "s3cret-key", channel: "@example" } },
  });
  sent.length = 0;
  await callRoute(integrationRoutes, "/api/integrations/youtube/test", { method: "POST", body: {} });

  const call = sent.find((r) => r.url.includes("/channels?"));
  assert.ok(call, "YouTube was never asked to resolve the channel");

  // In the HEADER now, not the query string. A key in a URL is written to proxy
  // logs and any intermediary that records paths; the assertion that matters --
  // that the REAL key is sent and never the mask -- is unchanged.
  const key = call.headers["X-Goog-Api-Key"];
  assert.equal(key, "s3cret-key", `the real key never reached YouTube: ${JSON.stringify(call.headers)}`);
  assert.notEqual(key, MASK, "the masked placeholder was sent as the key");

  // And it must not have leaked back into the URL on the way.
  assert.ok(!call.url.includes("s3cret-key"), `the key is in the URL again: ${call.url}`);
  assert.ok(!call.url.includes("key="), "the key must not be a query parameter");
});
