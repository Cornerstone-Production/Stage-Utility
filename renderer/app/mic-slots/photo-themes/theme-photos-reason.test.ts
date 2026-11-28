// When Theme photos can be pressed, and what it says when it cannot.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { themePhotosReason } from "./theme-photos-reason.js";

const ok = { hasServiceType: true, hasPlan: true, side: "plan" as const };

describe("themePhotosReason", () => {
  // The OpenAI connection is not an input: with no key, or one OpenAI rejected, the
  // sheet still opens, so the switch, Approve and Remove stay in reach. The panel's
  // tests cover what waits for a key (Generate and Redo).
  test("a plan has no reason", () => {
    assert.equal(themePhotosReason(ok), null);
  });
  test("a Default is per service, and offers the plan when there is one", () => {
    assert.deepEqual(themePhotosReason({ ...ok, side: "default" }), { why: "Theme photos is per service: pick a plan", fix: "plan" });
    assert.deepEqual(themePhotosReason({ ...ok, side: "default", hasPlan: false }), { why: "Theme photos is per service: pick a plan", fix: null });
  });
  test("no service type says so rather than blaming the Default", () => {
    assert.equal(themePhotosReason({ ...ok, hasServiceType: false, side: "default", hasPlan: false })?.why, "Pick a service type first");
  });
});
