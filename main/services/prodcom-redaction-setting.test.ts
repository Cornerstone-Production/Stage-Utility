// The ProdCom card's "Hide sensitive keywords" control, and the mapping behind
// it.
//
// The failure this guards is a control that renders and does nothing: the
// descriptor declares one key and applyProdcom reads another, so the operator
// moves the select, the value saves, and every display keeps showing the word.
// Nothing else in the suite would notice — the redaction tests drive the service
// directly, and the descriptor fixture only checks the server and the renderer
// agree with each other, not that anything reads the field.
//
// Checked against the real descriptor OBJECT, not the source text: a comment
// naming the key would satisfy a text scan, and this repo has shipped exactly
// that guard before.
//
// NOT unit-tested here, deliberately: that moving the select in a browser
// reaches applyProdcom. integrationManager.init() does not settle under the test
// runner (it starts every provider and holds the loop open), so the last link —
// save → applyProdcom → setRedactSensitive — was driven against a real server in
// a browser instead, with the asterisks appearing and disappearing on the
// transcription display. The constants below are what removes the part a test
// could check: the descriptor and applyProdcom cannot spell the key differently
// because there is only one spelling of it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// The manager resolves the data directory at import. Somewhere disposable,
// never the operator's real ~/.stage-utility.
process.env.STAGE_UTILITY_DATA = await fs.mkdtemp(path.join(os.tmpdir(), "prodcom-setting-"));

const {
  INTEGRATION_DESCRIPTORS,
  PRODCOM_REDACT_KEY,
  PRODCOM_REDACT_OFF,
  PRODCOM_REDACT_ON,
  prodcomRedactionOn,
} = await import("./integration-manager.js");

const prodcom = INTEGRATION_DESCRIPTORS.find((d) => d.id === "prodcom");

describe("the setting the operator actually sees", () => {
  it("is declared on the ProdCom card under the key applyProdcom reads", () => {
    assert.ok(prodcom, "no prodcom descriptor is shipped at all");
    const field = prodcom.configSchema.find((f) => f.key === PRODCOM_REDACT_KEY);
    assert.ok(field, `the ProdCom card declares no "${PRODCOM_REDACT_KEY}" field`);
    assert.equal(field.type, "select");
    assert.deepEqual(
      field.options?.map((o) => o.value),
      [PRODCOM_REDACT_ON, PRODCOM_REDACT_OFF],
      "the select offers values the mapping below does not understand",
    );
    assert.equal(field.default, PRODCOM_REDACT_ON, "the card must show ON before anything is saved");
  });

  it("explains that it only changes what this app displays", () => {
    // The operator has to be able to tell "this hides it on my walls" from
    // "this edits my ProdCom keywords" — one of those is destructive and this
    // is not it.
    const field = prodcom?.configSchema.find((f) => f.key === PRODCOM_REDACT_KEY);
    const help = field?.help ?? "";
    assert.match(help, /THIS app/, "the help does not say the setting is local to this app");
    assert.match(help, /ProdCom's own redaction is unchanged/);
    assert.match(help, /\/api\/prodcom\/transcript\/raw/, "the help does not say where the full text is");
  });
});

describe("a saved value maps to what leaves the server", () => {
  it("hides keywords for every value except the literal off", () => {
    // An install that predates the field, a half-written config, a value from a
    // future build: all of them redact. The safe direction for an unknown value
    // is hiding a word that did not need hiding.
    for (const config of [
      undefined,
      {},
      { [PRODCOM_REDACT_KEY]: PRODCOM_REDACT_ON },
      { [PRODCOM_REDACT_KEY]: "" },
      { [PRODCOM_REDACT_KEY]: null },
      { [PRODCOM_REDACT_KEY]: "OFF" },
      { host: "10.0.0.1", port: 24480 },
    ]) {
      assert.equal(prodcomRedactionOn(config), true, JSON.stringify(config ?? null));
    }
  });

  it("shows the transcript in full only for the exact value the card saves", () => {
    assert.equal(prodcomRedactionOn({ [PRODCOM_REDACT_KEY]: PRODCOM_REDACT_OFF }), false);
  });
});
