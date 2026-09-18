// A field the form masks must be a field the server stores encrypted.
//
// SECRET_KEYS decides where a value goes: a key in it is written to secrets.bin,
// a key not in it is written to settings.json — which is in CONFIG_FILES and so
// rides verbatim into every config snapshot and every automatic backup, a bundle
// the UI presents as safe to keep on a drive or hand to somebody.
//
// The descriptor's `type: "password"` decides only what the input looks like.
// The two were kept in step by hand, and nothing noticed when they were not:
// sensource's `safeSpaceId` was `type: "text"` and absent from SECRET_KEYS while
// safespace-client.ts described it in capitals as "THE ENTIRE CREDENTIAL. There
// is no key, no token and no account check" — so it sat in settings.json in
// cleartext and went into every backup.
//
// This runs against the DESCRIPTOR OBJECTS the server ships and the real
// secretKeysFor(), not against source text. A comment claiming a field is a
// secret cannot satisfy it, and neither can an interface declaring one — both
// have happened to guards in this repo.
//
// Exact sets, not a subset each way, and an exact TOTAL: a floor with slack is
// how three config stores went missing from every backup with the suite green.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { INTEGRATION_DESCRIPTORS, secretKeysFor, configuredFor, planSecretMigration } = await import(
  "./integration-manager.js"
);

/** Every `password` field each descriptor declares, by integration id. */
function passwordFields(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of INTEGRATION_DESCRIPTORS) {
    const keys = d.configSchema.filter((f) => f.type === "password").map((f) => f.key);
    if (keys.length > 0) out.set(d.id, keys.sort());
  }
  return out;
}

describe("the form's password fields and the encrypted store agree", () => {
  test("every masked field is stored as a secret", () => {
    for (const [id, keys] of passwordFields()) {
      const stored = [...secretKeysFor(id)].sort();
      for (const key of keys) {
        assert.ok(
          stored.includes(key),
          `${id}.${key} is a password field in the dialog but is NOT in SECRET_KEYS — ` +
            "it is written to settings.json in cleartext and carried in every config snapshot",
        );
      }
    }
  });

  test("every secret slot is a field the form actually masks", () => {
    // The other direction. A slot with no password field behind it means the
    // value arrives through a `text` input, which shows it on screen and leaves
    // it in the browser's autofill.
    for (const d of INTEGRATION_DESCRIPTORS) {
      const declared = new Set(d.configSchema.map((f) => f.key));
      for (const key of secretKeysFor(d.id)) {
        assert.ok(
          declared.has(key),
          `${d.id}.${key} is in SECRET_KEYS but the descriptor declares no such field`,
        );
        const field = d.configSchema.find((f) => f.key === key);
        // "oauth-device" is the one other type this test accepts: it is
        // YouTube's connect row (see youtube-connect.ts), and like "password"
        // it never puts the raw secret in a DOM input — the row shows only a
        // masked "Connected" state, a code, or an error sentence.
        assert.ok(
          field?.type === "password" || field?.type === "oauth-device",
          `${d.id}.${key} is a secret but its field is type "${field?.type}" — it is shown in the clear`,
        );
      }
    }
  });

  test("the total is exactly this, so a slot cannot go missing quietly", () => {
    // Spelled out rather than counted. Adding a credential here is a deliberate
    // act; a name disappearing from this list should make a reviewer stop.
    const all = INTEGRATION_DESCRIPTORS.flatMap((d) => secretKeysFor(d.id).map((k) => `${d.id}.${k}`));
    assert.deepEqual(all.sort(), [
      "obs.password",
      "planning-center.secret",
      "prodcom.apiKey",
      "pvp.token",
      "resi.password",
      "sensource.apiToken",
      "sensource.clientSecret",
      // The SafeSpace space id. The endpoint has no key, no token and no account
      // check — the id is the whole of its authority.
      "sensource.safeSpaceId",
      "smaart.password",
      "youtube.apiKey",
      "youtube.clientSecret",
      "youtube.refreshToken",
    ].sort());
  });
});

// ── ids that came from outside ───────────────────────────────────────────────
//
// Both tables are read with a key the app did not choose. settings.json's
// `integrationConfigs` is walked key by key at boot, and an integration id
// reaches configuredFor() off an HTTP path segment. As RECORDS they answered
// `Object.prototype` — or a function — for the names every JavaScript object
// carries, and `JSON.parse('{"__proto__":{}}')` keeps "__proto__" as an own
// enumerable key that Object.entries yields, so this is reachable from a
// hand-edited or partly-damaged settings.json. The `?? []` never fired, because
// Object.prototype is truthy, and `.filter` on it threw inside init(): no boot,
// no HTTP server, nothing at /log to read.
//
// Maps have no prototype chain to walk, so every one of these is a plain miss.

/** The names a plain object answers to without anyone putting them there. */
const INHERITED = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];

describe("a table keyed by an id from outside the app", () => {
  test("secretKeysFor answers no keys for an inherited name", () => {
    for (const name of INHERITED) {
      assert.deepEqual([...secretKeysFor(name)], [], `secretKeysFor("${name}") did not answer empty`);
    }
  });

  test("configuredFor answers for an inherited name instead of throwing", () => {
    const setup = { wirelessConnections: 0, oscTargets: 0, rossTalkTargets: 0, followedTeams: 0 };
    for (const name of INHERITED) {
      assert.equal(
        configuredFor({ id: name, config: {} }, setup, false),
        false,
        `configuredFor({ id: "${name}" }) did not answer false`,
      );
    }
  });

  test("the boot migration survives a settings.json carrying one", () => {
    // THE REACHABLE ONE, driven exactly as init() drives it: the real planner
    // over a real JSON.parse of a settings.json with a __proto__ key. As a
    // record this is `TypeError: keys.filter is not a function` out of init(),
    // which server.ts turns into exit 100 on every restart.
    const configs = JSON.parse(
      '{"__proto__":{"password":"x"},"constructor":{},"toString":{},"obs":{"password":"secret-0004"}}',
    ) as Record<string, Record<string, unknown>>;

    const plan = planSecretMigration(configs);

    assert.ok(plan, "the migration found nothing to move, so this proves nothing about the inherited keys");
    assert.deepEqual(plan.moved, ["obs.password"], "an inherited key was treated as an integration");
  });
});
