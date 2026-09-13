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

import { MASK, FORM_MASK, isMask, isSecretStored } from "./mask.js";
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
