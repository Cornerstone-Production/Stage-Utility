// Which password fields a save cleared because the address moved, as the two
// settings panels work it out from what they had, what they sent and what came
// back. Wrong one way, the operator is told a password was cleared when they
// cleared it themselves; wrong the other, an empty field reads as a lost one.

import assert from "node:assert/strict";
import { test } from "node:test";

import { FORM_MASK, MASK } from "@main/services/mask";
import type { ConfigField } from "@main/types/integrations";

import { droppedCredentialFields, droppedCredentialMessage, droppedCredentialNotice } from "./dropped-credentials";

const SCHEMA: ConfigField[] = [
  { key: "host", label: "Host", type: "text" },
  { key: "password", label: "Password", type: "password" },
];
const keys = (fields: ConfigField[]) => fields.map((f) => f.key);

test("a stored password left alone that comes back empty was dropped", () => {
  // The integrations form leaves an unchanged password out; the wireless panel
  // sends the mask back. Both mean "unchanged".
  assert.deepEqual(keys(droppedCredentialFields(SCHEMA, { password: FORM_MASK }, { host: "b.example" }, { password: "" })), ["password"]);
  assert.deepEqual(keys(droppedCredentialFields(SCHEMA, { password: MASK }, { host: "b.example", password: MASK }, { password: "" })), ["password"]);
});

test("one the operator cleared or retyped was not", () => {
  assert.deepEqual(droppedCredentialFields(SCHEMA, { password: FORM_MASK }, { password: "" }, { password: "" }), []);
  assert.deepEqual(droppedCredentialFields(SCHEMA, { password: FORM_MASK }, { password: "new" }, { password: MASK }), []);
});

test("nor one that is still stored, or that was never stored, or a reply that says nothing", () => {
  assert.deepEqual(droppedCredentialFields(SCHEMA, { password: FORM_MASK }, {}, { password: MASK }), []);
  assert.deepEqual(droppedCredentialFields(SCHEMA, { password: "" }, {}, { password: "" }), []);
  assert.deepEqual(droppedCredentialFields(SCHEMA, { password: FORM_MASK }, {}, undefined), []);
});

test("a field the saved config no longer carries at all was dropped: a provider without it", () => {
  assert.deepEqual(keys(droppedCredentialFields(SCHEMA, { password: MASK }, {}, { host: "a.example" })), ["password"]);
});

test("the notice names what was cleared", () => {
  assert.equal(
    droppedCredentialMessage("OBS settings saved", ["Password"]),
    "OBS settings saved: the saved Password was cleared because it was entered for a different address or device. Enter it again if it is still needed.",
  );
  assert.equal(
    droppedCredentialMessage("Base A", ["Password", "Key"]),
    "Base A: the saved Password and Key were cleared because they were entered for a different address or device. Enter them again if they are still needed.",
  );
});

test("the combined notice is null when nothing was cleared, and the message when something was", () => {
  assert.equal(droppedCredentialNotice("OBS", SCHEMA, { password: FORM_MASK }, { host: "a" }, { password: MASK }), null);
  assert.equal(
    droppedCredentialNotice("OBS", SCHEMA, { password: FORM_MASK }, { host: "b" }, { password: "" }),
    droppedCredentialMessage("OBS", ["Password"]),
  );
});
