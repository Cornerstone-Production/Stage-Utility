// Two integrations saved at once, against the real store and a real file.
//
// `patch` is a serialized read-modify-write and is atomic FOR THE VALUES HANDED
// TO IT. Both integration writers used to build the whole nested map first —
//
//   const settings = await settingsStore.load();
//   await settingsStore.patch({
//     integrationConfigs: { ...settings.integrationConfigs, [id]: merged },
//   });
//
// — which puts the read back outside the queue. Two integrations saved close
// together both read `integrationConfigs` before either write lands, and the
// second writes a map that never heard of the first: credentials accepted,
// reported saved, and gone. The same shape as the whole-object `save` that was
// deleted from this store, one level down the object.
//
// Driven through the real DataStore into a real temp directory, and asserted
// against the FILE. An in-memory assertion would pass on a store that had
// merged correctly in its cache and written the wrong thing to disk, which is
// the failure this repo has shipped before.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-settings-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { settingsStore } = await import("./settings-store.js");
const { secretsStore } = await import("./secrets.js");
const { integrationManager } = await import("./integration-manager.js");
import type { IntegrationState } from "../types/integrations.js";

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** settings.json as it actually sits on disk. */
async function onDisk(): Promise<{
  integrationConfigs?: Record<string, Record<string, unknown>>;
  integrationEnabled?: Record<string, boolean>;
  timezone?: string | null;
}> {
  return JSON.parse(await fs.readFile(path.join(TMP, "settings.json"), "utf8"));
}

describe("two integrations written at once", () => {
  before(async () => {
    // A field neither writer touches, so a whole-object clobber shows up here
    // too rather than only in the map under test.
    await settingsStore.patch({ timezone: "America/Chicago" });
  });

  it("both configs survive, rather than the second reverting the first", async () => {
    // Concurrent on purpose: neither await sits before the other's read. This is
    // an operator saving one integration while a second surface — a restored
    // snapshot, another browser tab, a rule — saves another.
    const [alpha, beta] = await Promise.all([
      settingsStore.patchIntegrationConfig("alpha", { host: "203.0.113.10", port: 4455 }),
      settingsStore.patchIntegrationConfig("beta", { host: "203.0.113.11" }),
    ]);
    assert.deepEqual(alpha, { host: "203.0.113.10", port: 4455 }, "the merged config handed back is wrong");
    assert.deepEqual(beta, { host: "203.0.113.11" });

    const file = await onDisk();
    assert.deepEqual(
      Object.keys(file.integrationConfigs ?? {}).sort(),
      ["alpha", "beta"],
      "one integration's config was reverted by the other's write",
    );
    assert.deepEqual(file.integrationConfigs?.alpha, { host: "203.0.113.10", port: 4455 });
    assert.deepEqual(file.integrationConfigs?.beta, { host: "203.0.113.11" });
    assert.equal(file.timezone, "America/Chicago", "an untouched field was written back stale");
  });

  it("both enabled flags survive too", async () => {
    const [, ,] = await Promise.all([
      settingsStore.patchIntegrationEnabled("alpha", true),
      settingsStore.patchIntegrationEnabled("beta", true),
      settingsStore.patchIntegrationEnabled("gamma", false),
    ]);
    const file = await onDisk();
    assert.deepEqual(
      file.integrationEnabled,
      { alpha: true, beta: true, gamma: false },
      "a concurrent toggle was reverted",
    );
  });

  it("a second save of the same integration MERGES, it does not replace", async () => {
    // The other half of the contract setConfig depends on: it writes only the
    // fields the form sent, and a key it did not send must survive.
    const merged = await settingsStore.patchIntegrationConfig("alpha", { port: 4456 });
    assert.deepEqual(merged, { host: "203.0.113.10", port: 4456 });
    assert.deepEqual((await onDisk()).integrationConfigs?.alpha, { host: "203.0.113.10", port: 4456 });
  });
});

// ── and the encrypted file is not rewritten for a save that touched no secret ──
//
// secrets.ts re-encrypts the WHOLE blob on every save, and the concurrent-write
// race it guards against is per write — so an ordinary edit (the poll interval,
// a zone selection) rewriting the credentials file is a window opened for
// nothing. setConfig's `if (secretsChanged)` is what closes it, and nothing in
// the suite noticed when it was changed to `if (true)`.
//
// Driven through the real setConfig, against the real secrets store. sensource
// is the integration used because its apply pass is inert without credentials —
// `hasCreds` is false, so it stops the poller and contacts nothing.

describe("a save that touches no secret", () => {
  const manager = integrationManager as unknown as { states: Map<string, IntegrationState> };
  const realSetSecrets = secretsStore.setSecrets.bind(secretsStore);
  let writes: string[] = [];

  before(() => {
    // init() cannot be called from a unit test — it starts the reconnect timers
    // and never lets the process exit — so the one row setConfig needs is seeded
    // the way every other case in this repo seeds it.
    manager.states.set("sensource", {
      id: "sensource",
      enabled: false,
      connection: "disconnected",
      message: null,
      config: {},
    });
  });

  after(() => {
    secretsStore.setSecrets = realSetSecrets;
  });

  it("does not rewrite secrets.bin, however many times it is saved", async () => {
    // GUARD. Exactly zero, not "few": one rewrite is one window.
    writes = [];
    secretsStore.setSecrets = async (id: string, values: Record<string, string>) => {
      writes.push(id);
      return realSetSecrets(id, values);
    };

    await integrationManager.setConfig("sensource", { pollSeconds: 30 });
    await integrationManager.setConfig("sensource", { pollSeconds: 30 });

    assert.deepEqual(writes, [], "an ordinary edit re-encrypted the whole credentials file");
  });

  it("...and a save that DOES carry one writes exactly once", async () => {
    // The other direction, so the case above cannot pass on a setSecrets that
    // never runs at all.
    writes = [];
    await integrationManager.setConfig("sensource", { clientSecret: "vea-invented-secret-0005" });
    assert.deepEqual(writes, ["sensource"], "a new credential was not written");

    // ...and saving the SAME value again is not a change either.
    writes = [];
    await integrationManager.setConfig("sensource", { clientSecret: "vea-invented-secret-0005" });
    assert.deepEqual(writes, [], "re-saving an unchanged credential rewrote the file");
  });
});
