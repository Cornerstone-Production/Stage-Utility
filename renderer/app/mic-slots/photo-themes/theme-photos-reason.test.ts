// When Theme photos can be pressed, and what it says when it cannot.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { OpenAiConnectionDTO, OpenAiState } from "@main/types/photo-themes";

import { themePhotosReason } from "./theme-photos-reason.js";

const conn = (state: OpenAiState): OpenAiConnectionDTO => ({ method: "api-key", hint: "sk-…3f2a", state, reason: null, checkedAt: null });
const ok = { hasServiceType: true, hasPlan: true, side: "plan" as const, connection: conn("connected") };

describe("themePhotosReason", () => {
  test("a plan, with a working key, has no reason", () => {
    assert.equal(themePhotosReason(ok), null);
  });
  test("a Default is per service, and offers the plan when there is one", () => {
    assert.deepEqual(themePhotosReason({ ...ok, side: "default" }), { why: "Theme photos is per service: pick a plan", fix: "plan" });
    assert.deepEqual(themePhotosReason({ ...ok, side: "default", hasPlan: false }), { why: "Theme photos is per service: pick a plan", fix: null });
  });
  test("no service type says so rather than blaming the Default", () => {
    assert.equal(themePhotosReason({ ...ok, hasServiceType: false, side: "default", hasPlan: false })?.why, "Pick a service type first");
  });
  test("no key, or one OpenAI rejected, sends the operator to Integrations", () => {
    for (const state of ["not-connected", "invalid-key"] as const) {
      assert.deepEqual(themePhotosReason({ ...ok, connection: conn(state) }), { why: "Connect OpenAI in Integrations", fix: "integrations" });
    }
  });
  test("a key that is out of credits, unchecked, refused or unreachable still opens the sheet, which says what will happen", () => {
    for (const state of ["unchecked", "out-of-credits", "forbidden", "unreachable"] as const) {
      assert.equal(themePhotosReason({ ...ok, connection: conn(state) }), null, state);
    }
  });
  test("a connection not yet read is not held against the button", () => {
    assert.equal(themePhotosReason({ ...ok, connection: undefined }), null);
  });
});
