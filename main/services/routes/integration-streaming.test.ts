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
globalThis.fetch = (async () =>
  new Response(JSON.stringify({}), { status: 500 })) as typeof fetch;

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
const CONFIGS: Record<string, Record<string, string>> = {
  resi: { username: "someone@example.org", password: "secret" },
  youtube: { clientId: "id", clientSecret: "secret", refreshToken: "token" },
};

for (const [id, config] of Object.entries(CONFIGS)) {
  test(`enabling ${id} starts ${id}`, async () => {
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
      `${id} was given credentials while enabled but never applied`,
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
      `${id} was configured and enabled but never applied`,
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
