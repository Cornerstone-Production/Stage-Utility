// What a SAVE may and may not do to the SafeSpace marker.
//
// `safeSpaceEnabled` is the non-secret record that SafeSpace is switched on. The
// id itself is a bearer credential and lives in secrets.bin, which a config
// snapshot deliberately does not carry — so the marker is the only thing a
// restored box has to tell "the operator never wanted SafeSpace" from "the
// operator wanted it and the id did not travel". Get it wrong in either
// direction and the box looks healthy on Vea while the number on the wall is a
// minute and a half old.
//
// Driven through integrationManager.setConfig — the real route POST
// /api/integrations/:id/config takes — not through foldConfigEntries on its own.
// Every defect below was in setConfig and not in the fold: one in the ORDER of
// two writes, one in a key the fold classifies perfectly correctly as ordinary
// config. A test over the fold alone was green for all of them.
//
// init() cannot be called from a unit test (it starts the reconnect timers and
// never lets the process exit), so the one thing it does that setConfig needs —
// a state map with an entry for the id — is seeded directly below. Everything
// after that is the real code. SenSource is left DISABLED throughout, so
// applySensource() stops the poller rather than dialling anything.
//
// The ids below are invented. Nothing in this repo is anyone's real one.

import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-safespace-writes-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { integrationManager } = await import("./integration-manager.js");
const { settingsStore } = await import("./settings-store.js");
const { secretsStore } = await import("./secrets.js");

const SPACE_ID = "ss-invented-writes-4d18-never-real";
const SETTINGS = path.join(TMP, "settings.json");

/** The one thing init() does that setConfig depends on. */
function seedState(config: Record<string, unknown>): void {
  (integrationManager as unknown as { states: Map<string, unknown> }).states.set("sensource", {
    id: "sensource",
    enabled: false,
    connection: "disconnected",
    message: null,
    config,
  });
}

async function save(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const next = await integrationManager.setConfig("sensource", config);
  return next.config;
}

/** settings.json as it really sits on disk — an in-memory assertion would pass
 *  on a manager that merged correctly in its map and wrote the wrong file. */
async function onDisk(): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await fs.readFile(SETTINGS, "utf8")) as {
    integrationConfigs?: Record<string, Record<string, unknown>>;
  };
  return raw.integrationConfigs?.sensource ?? {};
}

/** Back to a box that has never had SafeSpace: no marker, no stored id. */
async function reset(): Promise<void> {
  await secretsStore.setSecrets("sensource", {});
  await settingsStore.removeIntegrationConfigKeys("sensource", ["safeSpaceEnabled", "pollSeconds"]);
  await settingsStore.patchIntegrationConfig("sensource", {
    clientId: "cid-1",
    safeSpacePollSeconds: 10,
  });
  seedState({ clientId: "cid-1", safeSpacePollSeconds: 10, safeSpaceId: "", clientSecret: "", apiToken: "" });
}

describe("the marker is derived, so a request body cannot write it", () => {
  beforeEach(reset);

  test("a body claiming SafeSpace is on, with no id anywhere, is refused", async () => {
    await save({ safeSpaceEnabled: true });
    assert.equal(
      (await onDisk()).safeSpaceEnabled,
      undefined,
      "any client on the LAN can put this box into the permanent 'on with no space ID' " +
        "warning — four surfaces saying to re-enter an id that was never set",
    );
  });

  test("and neither can a body claiming it is off, which writes a forbidden literal", async () => {
    // SAFESPACE_ENABLED_KEY: "Written as `true` or REMOVED, never `false`:
    // configuredFor() reads any non-empty, non-null config value as 'the
    // operator set this up', so a literal `false` would make an otherwise
    // untouched SenSource card claim to be configured."
    await save({ safeSpaceEnabled: false });
    assert.equal(
      (await onDisk()).safeSpaceEnabled,
      undefined,
      "the literal `false` this key's own doc forbids reached settings.json off a request body",
    );
  });

  test("a marker in the body does not survive the save that deletes the id", async () => {
    // The body a client gets from GET /api/integrations and posts straight back:
    // masks for the secrets it was not shown, the marker it was shown, and an
    // emptied space id because the operator cleared that one field.
    await save({ safeSpaceId: SPACE_ID });
    assert.equal((await onDisk()).safeSpaceEnabled, true, "the fixture never turned SafeSpace on");

    const config = await save({
      clientId: "cid-1",
      safeSpacePollSeconds: 10,
      safeSpaceEnabled: true,
      clientSecret: "••••",
      apiToken: "••••",
      safeSpaceId: "",
    });

    assert.equal(
      (await secretsStore.getSecrets("sensource")).safeSpaceId,
      undefined,
      "the operator cleared the field and the credential stayed stored",
    );
    assert.equal(
      (await onDisk()).safeSpaceEnabled,
      undefined,
      "the credential was deleted and the marker survived: the operator asked to turn " +
        "SafeSpace off and got the permanent 'on with no space ID' warning instead, with " +
        "nothing left to re-enter it from",
    );
    assert.equal(
      config.safeSpaceEnabled,
      undefined,
      "the state the save returned still carries the marker, so every surface reading it lies " +
        "until the next reload",
    );
  });

  test("the server's own marker write still lands — this is not a blanket ban", async () => {
    const config = await save({ safeSpaceId: SPACE_ID });
    assert.equal((await onDisk()).safeSpaceEnabled, true, "saving an id no longer records the switch");
    assert.equal(config.safeSpaceEnabled, true, "the returned state lost the switch");
    assert.equal(config.safeSpaceId, "••••", "the id came back unmasked");
  });

  test("and an ordinary non-secret key is still written, so the strip is not too wide", async () => {
    await save({ pollSeconds: 30 });
    assert.equal((await onDisk()).pollSeconds, 30, "an ordinary config key stopped being saved");
  });
});
