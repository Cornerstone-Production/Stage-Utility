// The two ends of the credential round trip must agree on what a mask is.
//
// The server puts MASK in a config for a stored secret; the settings dialog and
// the wireless panel seed a password INPUT with the longer FORM_MASK; and
// whatever the form posts back comes through foldConfigEntries, which has to
// read both as "the operator did not retype this, leave it alone". Get that
// wrong in either direction and the panel stores a row of bullets AS the
// credential — with the real one gone and nothing on screen to tell you,
// because a masked field and a bullets-valued field render identically.
//
// This existed as FOUR separate decisions: isMask in wireless-credentials.ts, a
// verbatim copy in integrations-panel.tsx, another in
// wireless-connections-panel.tsx, and a differently-shaped `!== ""` in
// sensource-scope-picker.tsx. They agreed, so nothing was broken — which is
// exactly the state every drifted copy in this repo was in the day before it
// drifted. There is one copy now, in mask.ts, and this pins the CONTRACT rather
// than counting copies: a scan for duplicate source text is the kind of guard a
// comment has satisfied here before.
//
// Driven through the real exported fold, the one setConfig calls.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MASK, FORM_MASK, isMask, isSecretStored, isBlankSecret, hasSecretValue } from "./mask.js";
import { mergeSecrets, publicConfig, splitConfig } from "./wireless-credentials.js";
import { foldConfigEntries } from "./integration-manager.js";

const SECRETS = ["password", "apiToken"];

describe("what the form sends back", () => {
  test("the server's own mask means 'leave it alone'", () => {
    const { secrets, clearedSecrets } = foldConfigEntries({ password: MASK }, SECRETS, "test");
    assert.deepEqual({ ...secrets }, {}, "the mask was stored as the password");
    assert.deepEqual(clearedSecrets, [], "posting back the mask deleted the credential");
  });

  test("and so does the LONGER one the password fields are seeded with", () => {
    // initialConfig() in integrations-panel.tsx and the wireless panel both put
    // FORM_MASK in the field. If the fold stopped recognising it, every save
    // from either panel would store a row of bullets as the credential.
    const { secrets, clearedSecrets } = foldConfigEntries({ password: FORM_MASK }, SECRETS, "test");
    assert.deepEqual(
      { ...secrets },
      {},
      `the form seeds a password field with ${FORM_MASK.length} bullets and the server stored them ` +
        "as the password — the real credential is gone, and the field looks exactly the same",
    );
    assert.deepEqual(clearedSecrets, []);
  });

  test("both are masks, and neither is mistaken for an empty field", () => {
    assert.equal(isMask(MASK), true);
    assert.equal(isMask(FORM_MASK), true);
    assert.equal(isMask(""), false, "an empty field is the operator clearing it, not a mask");
    assert.equal(isMask("hunter2"), false);
    assert.equal(isMask(null), false);
  });

  test("a stored secret reads as stored, an unset one does not", () => {
    // What the SenSource panel asks before it decides whether SafeSpace has its
    // id. The server writes MASK or "" into the state and nothing else.
    assert.equal(isSecretStored(MASK), true);
    assert.equal(isSecretStored(FORM_MASK), true);
    assert.equal(isSecretStored(""), false, "an unset credential read as stored — no notice is shown");
    assert.equal(isSecretStored(undefined), false);
  });

  test("a real value is still stored, so none of the above passes by refusing everything", () => {
    const { secrets } = foldConfigEntries({ password: "hunter2" }, SECRETS, "test");
    assert.equal(secrets.password, "hunter2");
  });
});

describe("whitespace in a credential field is an empty field", () => {
  // GUARD. `value === ""` decided this in seven places while every reader used
  // `value?.trim() || null`, so one field had two answers. POST
  // {"config":{"safeSpaceId":"   "}} against a real server stored three spaces,
  // masked them as "••••" — which sensource-scope-picker reads as "an ID is
  // stored", so the notice went quiet — while getSensourceConfig trimmed the
  // same value to null and logged "SafeSpace is switched on but no space ID is
  // stored". The one surface that stays put beside the field the operator has to
  // retype was the one that said nothing.
  for (const blank of ["   ", "\t", "\n", " \t\n "]) {
    test(`${JSON.stringify(blank)} clears the field rather than becoming the credential`, () => {
      const { secrets, clearedSecrets } = foldConfigEntries({ password: blank }, SECRETS, "test");
      assert.deepEqual(
        { ...secrets },
        {},
        "whitespace was stored as a credential. It masks as a stored value on every surface " +
          "that checks truthiness and reads as absent on every surface that trims",
      );
      assert.deepEqual(clearedSecrets, ["password"], "the operator emptied the field and nothing said so");
    });
  }

  test("but a value that merely HAS whitespace keeps every character", () => {
    // The emptiness decision only. A password may legitimately begin or end with
    // a space, and silently trimming one breaks a working login with nothing on
    // screen to explain it.
    const { secrets } = foldConfigEntries({ password: "  hunter2  " }, SECRETS, "test");
    assert.equal(secrets.password, "  hunter2  ", "the stored credential was trimmed");
  });

  test("the two predicates agree on every case, in both directions", () => {
    for (const v of ["   ", "", "\t"]) {
      assert.equal(isBlankSecret(v), true, `${JSON.stringify(v)} is not an empty field`);
      assert.equal(hasSecretValue(v), false, `${JSON.stringify(v)} counts as a stored credential`);
    }
    for (const v of ["x", " x ", MASK]) {
      assert.equal(isBlankSecret(v), false);
      assert.equal(hasSecretValue(v), true);
    }
    // A NON-STRING is neither. Folding it in as "blank" would make
    // POST {"password":null} delete a working credential.
    for (const v of [null, undefined, 42, {}, []] as unknown[]) {
      assert.equal(isBlankSecret(v), false, `${String(v)} would clear a stored credential`);
      assert.equal(hasSecretValue(v), false, `${String(v)} would mask as a stored credential`);
    }
  });

  // Sennheiser Spectera is the one wireless provider that declares a password.
  const SPECTERA = "sennheiser-spectera";

  test("the wireless fold, the other copy of this decision, agrees", () => {
    assert.deepEqual(
      mergeSecrets(SPECTERA, { password: "   " }, { password: "real-password" }),
      {},
      "a whitespace-only password left the real one stored, masked and unreachable",
    );
    assert.deepEqual(
      mergeSecrets(SPECTERA, { password: null }, { password: "real-password" }),
      { password: "real-password" },
      "a non-string deleted the stored password",
    );
  });

  test("and neither the wireless split nor its mask calls a whitespace value 'stored'", () => {
    assert.equal(
      publicConfig(SPECTERA, { password: "   ", host: "192.0.2.10" }).password,
      "",
      "GET /api/wireless/connections showed a mask over three spaces",
    );
    assert.equal(publicConfig(SPECTERA, { password: "real", host: "192.0.2.10" }).password, MASK);
    assert.equal(
      splitConfig({ password: "   ", host: "192.0.2.10" }).secret.password,
      undefined,
      "whitespace was written into the encrypted store as a base-station password",
    );
  });
});
