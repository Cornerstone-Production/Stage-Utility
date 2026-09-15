// The SafeSpace marker must reach DISK, not just the migration's return value.
//
// planSecretMigration() sets `safeSpaceEnabled` on the config map it RETURNS —
// which init() builds the in-memory state from, so a box keeps working all
// session on a marker that was never written down. applySecretMigration() is the
// half that persists it, and the write is two lines that nothing else depends
// on: delete them and the box still runs, still reports SafeSpace on, still
// polls SafeSpace. The next boot reads `safeSpaceEnabled = undefined`, and
// getSensourceConfig's `|| !!secrets.safeSpaceId` hides even that. The failure
// surfaces one config snapshot later: the bundle carries no marker, the restore
// lands silently back on Vea, and that is the exact bug the marker exists to
// prevent.
//
// OWN DATA DIR, ON PURPOSE. safespace-id-storage.test.ts covers the same
// migration but its fixtures patch `safeSpaceEnabled: true` onto the shared
// store first, and `removeIntegrationConfigKeys` only takes SECRET keys back
// out — so the marker is already on disk before the code under test runs and an
// assertion that it is there afterwards passes on the fixture. Everything here
// starts from a settings.json written by hand, as an upgrading box really has
// it: the id in cleartext and nothing at all recording that SafeSpace is on.
//
// The id below is invented. Nothing in this repo is anyone's real one.

import assert from "node:assert/strict";
import { describe, test, before } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-safespace-marker-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

/** Unmistakable inside a whole serialized file, and not anyone's real id. */
const SPACE_ID = "ss-invented-upgrade-9c41-never-real";
const SETTINGS = path.join(TMP, "settings.json");

// settings.json exactly as the build before this release left it: safeSpaceId is
// ordinary config, and there is no marker because the id WAS the marker. Written
// before the stores are imported so nothing in this file can have seeded it.
await fs.writeFile(
  SETTINGS,
  JSON.stringify({
    integrationConfigs: {
      sensource: { clientId: "cid", safeSpaceId: SPACE_ID, safeSpacePollSeconds: 10 },
    },
  }),
);

const { planSecretMigration, applySecretMigration } = await import("./integration-manager.js");
const { settingsStore } = await import("./settings-store.js");
const { secretsStore } = await import("./secrets.js");

async function sensourceOnDisk(): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await fs.readFile(SETTINGS, "utf8")) as {
    integrationConfigs?: Record<string, Record<string, unknown>>;
  };
  return raw.integrationConfigs?.sensource ?? {};
}

describe("the boot migration writes the SafeSpace marker to disk", () => {
  let ran: { moved: boolean };

  before(async () => {
    // The precondition, asserted rather than assumed: no marker anywhere before
    // the code under test runs. Without this every assertion below could be
    // passing on a value some earlier line wrote.
    const start = await sensourceOnDisk();
    assert.equal(start.safeSpaceId, SPACE_ID, "the fixture never reached settings.json");
    assert.equal(
      start.safeSpaceEnabled,
      undefined,
      "the fixture already carried a marker, so this file cannot tell a persisted one from a seeded one",
    );

    const settings = await settingsStore.load();
    const plan = planSecretMigration(settings.integrationConfigs);
    assert.ok(plan, "a settings.json holding a cleartext space id produced no migration");
    assert.deepEqual(plan.moved, ["sensource.safeSpaceId"]);
    ran = await applySecretMigration(plan);
  });

  test("it ran at all, so the assertions below are not passing on a decline", () => {
    assert.equal(ran.moved, true, "the migration declined; nothing below is evidence about the marker");
  });

  test("the id is out of settings.json and into secrets.bin", async () => {
    const after = await sensourceOnDisk();
    assert.equal(after.safeSpaceId, undefined, "the cleartext id is still in settings.json");
    assert.equal(
      (await secretsStore.getSecrets("sensource")).safeSpaceId,
      SPACE_ID,
      "the id was not stored, so SafeSpace is off rather than secured",
    );
  });

  test("and the marker is ON DISK, so the next boot still knows SafeSpace is on", async () => {
    assert.equal(
      (await sensourceOnDisk()).safeSpaceEnabled,
      true,
      "the marker was only set on the map the migration returned, never written. The box runs " +
        "fine this session and comes back with SafeSpace off — and every config snapshot taken " +
        "in between restores onto Vea saying nothing",
    );
  });
});
