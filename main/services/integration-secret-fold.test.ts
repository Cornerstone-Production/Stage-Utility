// A credential entered in the integrations dialog could not be taken back out.
//
// `foldConfigEntries` skipped a secret field whose value was the mask OR the
// empty string, so the two cases were indistinguishable — and the empty string
// is the operator clearing the field. The dialog omits a still-masked password
// from the body entirely (integrations-panel.handleSave), so `""` arriving here
// means one thing and one thing only: the operator emptied it and saved.
//
// The result was that a PCO token, an OBS password, a Resi password or a
// SafeSpace space id could be entered and never removed. The form showed an
// empty field afterwards and the server went on holding the value, which is the
// worst version of it — nothing on screen says the credential is still there.
//
// wireless-credentials.mergeSecrets was rewritten for exactly this ("a masked or
// absent value keeps what is already stored; an empty string is an explicit
// clear"). This is the OTHER copy of that shape, and it kept the old behaviour.
//
// Driven through the real exported fold — the one `setConfig` calls — not a
// reimplementation of it. See config-key-injection.test.ts for why that
// distinction was expensive here.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { foldConfigEntries } from "./integration-manager.js";

const SECRETS = ["password", "apiToken"];

describe("clearing a stored credential", () => {
  test("an empty secret field is an explicit clear, not 'unchanged'", () => {
    const { secrets, clearedSecrets } = foldConfigEntries({ password: "" }, SECRETS, "test");
    assert.deepEqual(clearedSecrets, ["password"], "the operator emptied the field and nothing said so");
    assert.deepEqual({ ...secrets }, {}, "an empty field must not be stored as a value");
  });

  test("a mask still means 'leave it alone'", () => {
    const { secrets, clearedSecrets } = foldConfigEntries({ password: "••••" }, SECRETS, "test");
    assert.deepEqual(clearedSecrets, [], "a mask is the form echoing back what it was shown");
    assert.deepEqual({ ...secrets }, {});
  });

  test("the panel's LONGER mask means the same thing", () => {
    // integrations-panel renders "••••••••" into the field it shows. Matching
    // only the four this file writes would store a row of bullets AS the
    // credential — the bug wireless-credentials.isMask exists to prevent.
    const { secrets, clearedSecrets } = foldConfigEntries({ password: "••••••••" }, SECRETS, "test");
    assert.deepEqual(clearedSecrets, []);
    assert.deepEqual({ ...secrets }, {}, "a row of bullets was stored as the credential");
  });

  test("a real value is still a real value", () => {
    const { secrets, clearedSecrets } = foldConfigEntries(
      { password: "hunter2", apiToken: "tok-1" },
      SECRETS,
      "test",
    );
    assert.deepEqual({ ...secrets }, { password: "hunter2", apiToken: "tok-1" });
    assert.deepEqual(clearedSecrets, []);
  });

  test("clearing one secret does not disturb another in the same save", () => {
    const { secrets, clearedSecrets } = foldConfigEntries(
      { password: "", apiToken: "tok-1", host: "203.0.113.7" },
      SECRETS,
      "test",
    );
    assert.deepEqual(clearedSecrets, ["password"]);
    assert.deepEqual({ ...secrets }, { apiToken: "tok-1" });
    assert.equal(foldConfigEntries({ host: "203.0.113.7" }, SECRETS, "test").config.host, "203.0.113.7");
  });

  test("an empty NON-secret field is an ordinary value, not a clear", () => {
    // "" is a legitimate saved value for a text field — a blank ProPresenter
    // instance name, a cleared host. Only a secret slot treats it as a delete.
    const { config, clearedSecrets } = foldConfigEntries({ host: "" }, SECRETS, "test");
    assert.equal(config.host, "");
    assert.deepEqual(clearedSecrets, []);
  });
});
