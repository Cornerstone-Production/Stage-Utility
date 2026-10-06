// applyAccentVar sets the Branding accent on the root, and says whether it was
// PICKED. --brand-accent has a CSS default per theme, so it is always present;
// a kiosk surface in the light app cannot tell a pick from a default by reading
// it. --brand-accent-set is present exactly when the operator picked one.

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();
after(() => teardown());

const { applyAccentVar } = await import("./apply-accent.js");
const root = () => document.documentElement.style;

test("a picked accent sets both the accent and the marker that it was picked", () => {
  applyAccentVar("#2e6691");
  assert.equal(root().getPropertyValue("--brand-accent"), "#2e6691");
  assert.equal(root().getPropertyValue("--brand-accent-set"), "#2e6691");
});

test("clearing it removes both, so the CSS defaults win and the marker is absent", () => {
  applyAccentVar("#2e6691");
  applyAccentVar(null);
  assert.equal(root().getPropertyValue("--brand-accent"), "");
  assert.equal(root().getPropertyValue("--brand-accent-set"), "");
});

test("an invalid colour is treated as none", () => {
  applyAccentVar("#2e6691");
  applyAccentVar("blue");
  assert.equal(root().getPropertyValue("--brand-accent"), "");
  assert.equal(root().getPropertyValue("--brand-accent-set"), "");
});
