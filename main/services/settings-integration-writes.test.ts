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
