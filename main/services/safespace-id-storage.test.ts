// The SafeSpace space id must never reach a config snapshot.
//
// safespace-client.ts states it in capitals: "THE SPACE ID IS THE ENTIRE
// CREDENTIAL. There is no key, no token and no account check: whoever holds the
// id can read the occupancy." It was nevertheless stored as ordinary integration
// config, which means settings.json — a CONFIG_FILES member, so it rode VERBATIM
// into every downloadable snapshot and every automatic backup, a bundle the
// Settings page presents as safe to keep on a drive or hand to somebody.
//
// Verified before this change by building a snapshot over a settings.json
// holding an id: the bundle carried the literal value, and a restore put the
// literal value back.
//
// THE OTHER HALF, and the reason REDACTED_FIELDS was not the answer. That
// mechanism empties a field at EXPORT time, so the restored value is "" — which
// for kiosk-devices.json is meaningful (an empty token is unpinned) and for a
// space id would mean SafeSpace silently switched off. It also only walks
// array-shaped stores, and settings.json is an object, so an entry for it would
// have been a no-op that looked like a fix.
//
// So the id lives in secrets.bin, and a non-secret marker records that SafeSpace
// is switched ON. A restore then lands in a state that SAYS it needs the id back
// rather than one that looks healthy on Vea. That marker is what these guards
// are really protecting: without it the two ways to have no id are the same
// state and the fallback is silent.
//
// Driven through the real code — foldConfigEntries, the real settings store, the
// real secrets store and configSnapshot.build() — not against source text.
// `integrationManager.init()` cannot be called from a unit test (it starts the
// reconnect timers and never lets the process exit), so the boot migration is
// exported in the two halves init calls and both are driven here.
//
// The id below is invented. Nothing in this repo is anyone's real one.

import assert from "node:assert/strict";
import { describe, test, before } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-safespace-id-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { foldConfigEntries, secretKeysFor, planSecretMigration, applySecretMigration } = await import(
  "./integration-manager.js"
);
const { settingsStore } = await import("./settings-store.js");
const { secretsStore } = await import("./secrets.js");
const { configSnapshot } = await import("./config-snapshot.js");

/** Unmistakable inside a whole serialized bundle, and not anyone's real id. */
const SPACE_ID = "ss-invented-7a2f-never-real";
const VEA_SECRET = "vea-invented-client-secret";

/** Everything a snapshot would put on a drive, as one string to search. */
async function snapshotText(): Promise<string> {
  return JSON.stringify(await configSnapshot.build("guard"));
}

describe("saving a space id through the real config path", () => {
  before(async () => {
    // Exactly what POST /api/integrations/sensource/config hands setConfig.
    const { config, secrets } = foldConfigEntries(
      { clientId: "cid", clientSecret: VEA_SECRET, safeSpaceId: SPACE_ID, safeSpacePollSeconds: 10 },
      secretKeysFor("sensource"),
      "sensource",
    );
    await settingsStore.patchIntegrationConfig("sensource", { ...config, safeSpaceEnabled: true });
    await secretsStore.setSecrets("sensource", secrets);
  });

  test("the fold puts the id in the secrets half, not the config half", () => {
    const { config, secrets } = foldConfigEntries(
      { safeSpaceId: SPACE_ID },
      secretKeysFor("sensource"),
      "sensource",
    );
    assert.equal(secrets.safeSpaceId, SPACE_ID, "the id was not classified as a credential");
    assert.equal(config.safeSpaceId, undefined, "the id was written to the file backups copy");
  });

  test("settings.json on disk holds no space id", async () => {
    const raw = await fs.readFile(path.join(TMP, "settings.json"), "utf8");
    assert.ok(!raw.includes(SPACE_ID), "the space id is in cleartext in settings.json");
    assert.ok(!raw.includes(VEA_SECRET), "the Vea client secret is in cleartext in settings.json");
  });

  test("a config snapshot carries no space id", async () => {
    const text = await snapshotText();
    assert.ok(!text.includes(SPACE_ID), "the space id rode into a config snapshot");
    assert.ok(!text.includes(VEA_SECRET), "the Vea client secret rode into a config snapshot");
  });

  test("but it DOES carry the marker, so a restore knows SafeSpace was on", async () => {
    const bundle = await configSnapshot.build("guard");
    const sensource = (bundle.files["settings.json"] as { integrationConfigs: Record<string, Record<string, unknown>> })
      .integrationConfigs.sensource;
    assert.equal(
      sensource?.safeSpaceEnabled,
      true,
      "the snapshot lost the fact that SafeSpace was on — a restore cannot tell it apart " +
        "from a site that never had it, and falls back to Vea saying nothing",
    );
  });

  test("the id really is stored, so the guards above are not passing on nothing", async () => {
    assert.equal(
      (await secretsStore.getSecrets("sensource")).safeSpaceId,
      SPACE_ID,
      "the id was not stored anywhere — SafeSpace would be off, not secured",
    );
  });
});

describe("the boot migration off an upgrading box", () => {
  // settings.json as it looks on a box that ran the build where safeSpaceId was
  // ordinary config. This is the state that made the id ride into every backup.
  const LEGACY = {
    sensource: { clientId: "cid", safeSpaceId: SPACE_ID, safeSpacePollSeconds: 10 },
    obs: { host: "192.0.2.60", password: "invented-obs-password" },
    // Already migrated, with the mask left behind by an older build. Storing the
    // mask would replace the real credential with a row of bullets.
    resi: { username: "u", password: "••••" },
    // Nothing to move.
    reaper: { host: "192.0.2.61" },
  };

  test("it moves every credential out of the config, by name", () => {
    const plan = planSecretMigration(LEGACY);
    assert.ok(plan, "a settings.json full of cleartext credentials produced no migration");
    assert.deepEqual(plan.moved.sort(), ["obs.password", "sensource.safeSpaceId"]);
    assert.equal(plan.configs.sensource?.safeSpaceId, undefined, "the id stayed in the config");
    assert.equal(plan.configs.obs?.password, undefined, "the OBS password stayed in the config");
    assert.equal(plan.configs.resi?.password, "••••", "a mask is not a credential and must not move");
    assert.deepEqual(plan.configs.reaper, { host: "192.0.2.61" }, "an untouched integration was rewritten");
  });

  test("and records that SafeSpace was switched on, because the id WAS the switch", () => {
    const plan = planSecretMigration(LEGACY)!;
    assert.equal(
      plan.configs.sensource?.safeSpaceEnabled,
      true,
      "moving the id out of settings.json took SafeSpace's switch with it — the box would " +
        "come back with the occupancy quietly on Vea and nothing anywhere saying so",
    );
  });

  test("nothing to move is no migration at all", () => {
    assert.equal(planSecretMigration({ reaper: { host: "192.0.2.61" } }), null);
    assert.equal(planSecretMigration({}), null);
  });

  test("applying it leaves settings.json — and every snapshot — clean", async () => {
    const legacyId = "ss-invented-legacy-0001";
    await settingsStore.patchIntegrationConfig("sensource", { safeSpaceId: legacyId });
    // It really is in the file first, or the assertion below proves nothing.
    const before = await fs.readFile(path.join(TMP, "settings.json"), "utf8");
    assert.ok(before.includes(legacyId), "the fixture never wrote the legacy value");

    const settings = await settingsStore.load();
    const plan = planSecretMigration(settings.integrationConfigs)!;
    await applySecretMigration(plan);

    const after = await fs.readFile(path.join(TMP, "settings.json"), "utf8");
    assert.ok(!after.includes(legacyId), "the legacy space id survived the migration in settings.json");
    assert.ok(!after.includes("safeSpaceId"), "the key itself was emptied rather than removed");
    assert.ok(!(await snapshotText()).includes(legacyId), "the legacy id still rides into a snapshot");
    // NOT asserted here: that the marker reached disk. The before() hook above
    // patched `safeSpaceEnabled: true` onto this same store, and
    // removeIntegrationConfigKeys only takes SECRET keys back out — so the
    // marker is already in settings.json before applySecretMigration runs, and
    // an assertion that it is there afterwards passes on the fixture. Deleting
    // the migration's marker write left this whole file green.
    // safespace-marker-persist.test.ts starts from its own data dir with no
    // marker anywhere and is the guard that goes red on it.
  });

  test("secrets.bin wins a collision — a stale config copy never overwrites it", async () => {
    // Every slot but safeSpaceId has been masked at init since the slot existed,
    // so a value still in settings.json for one of those is a leftover from
    // before the split, not the value in use. Overwriting the live credential
    // with it would break the integration on the next boot.
    await secretsStore.setSecrets("obs", { password: "the-live-one" });
    await settingsStore.patchIntegrationConfig("obs", { password: "a-stale-leftover" });
    const settings = await settingsStore.load();
    await applySecretMigration(planSecretMigration(settings.integrationConfigs)!);
    assert.equal((await secretsStore.getSecrets("obs")).password, "the-live-one");
  });

  test("it declines onto a secrets.bin that will not decrypt, and leaves it alone", async () => {
    // secrets.ts deliberately does NOT move an unreadable file aside on a read:
    // "the KEY may be what is wrong, and the file perfectly good. Moving it aside
    // here would turn 'fix the key and restart' into permanent loss." It moves it
    // aside on the next SAVE instead — right when an operator re-enters a
    // credential, wrong for a write nobody asked for. This migration is that
    // write, and it runs at boot on every upgrading box.
    const orphan = "ss-invented-orphan-0002";
    await settingsStore.patchIntegrationConfig("sensource", { safeSpaceId: orphan });
    await fs.writeFile(path.join(TMP, "secrets.bin"), "not a valid GCM payload");
    const store = secretsStore as unknown as { cache: unknown; unreadable: boolean };
    store.cache = null;
    store.unreadable = false;

    const settings = await settingsStore.load();
    const ran = await applySecretMigration(planSecretMigration(settings.integrationConfigs)!);

    assert.equal(ran.moved, false, "it wrote onto a secrets.bin it could not read");
    assert.equal(
      await fs.readFile(path.join(TMP, "secrets.bin"), "utf8"),
      "not a valid GCM payload",
      "the unreadable file was overwritten — fixing the key no longer recovers in place",
    );
    assert.deepEqual(
      (await fs.readdir(TMP)).filter((f) => f.startsWith("secrets.bin.unreadable-")),
      [],
      "the one-time preservation was spent on a write the operator never asked for",
    );
    // And the credential is still where it was, so the next boot can try again.
    const after = JSON.parse(await fs.readFile(path.join(TMP, "settings.json"), "utf8"));
    assert.equal(after.integrationConfigs.sensource.safeSpaceId, orphan);
  });
});
