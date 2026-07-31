import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { buildLabel } from "./build-label.js";

const status = (over: Partial<UpdateStatus> = {}) =>
  ({ version: "1.6.0-beta.1", branch: "beta", currentSha: "fc87558", currentDate: "2026-07-30T12:00:00Z", ...over }) as UpdateStatus;

describe("buildLabel", () => {
  test("a full build reads version, track, commit and date", () => {
    const out = buildLabel(status());
    assert.match(out, /^v1\.6\.0-beta\.1 · beta · fc87558 · /);
    assert.equal(out.split(" · ").length, 4);
  });

  test("a machine that is not a git checkout still names its version", () => {
    // No branch or commit to report — better than "v1.6.0 ·  · ".
    assert.equal(buildLabel(status({ branch: null, currentSha: null, currentDate: null })), "v1.6.0-beta.1");
  });

  test("an unparseable date is dropped rather than printed as Invalid Date", () => {
    assert.equal(buildLabel(status({ currentDate: "not a date" })), "v1.6.0-beta.1 · beta · fc87558");
  });

  test("no version means no label, so the tooltip does not open empty", () => {
    assert.equal(buildLabel(status({ version: "" })), "");
    assert.equal(buildLabel(null), "");
    assert.equal(buildLabel(undefined), "");
  });

  test("the separator matches the label it explains", () => {
    // The sidebar label joins with the same middot; the hover should not look like
    // a different piece of information.
    assert.ok(buildLabel(status()).includes(" · "));
  });
});
