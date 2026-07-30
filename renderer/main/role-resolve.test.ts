// One rule covers every case the operator specified: join the non-empty members in the
// role's order. One populated shows it; the first blank falls through to the next; more
// than one populated merges, first-listed first.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { resolveRole, roleAppliesTo } from "./role-resolve.js";

const AUDIO = { id: "role-audio", name: "Audio", members: ["Audio", "Audio/Visual"] };

describe("resolveRole", () => {
  test("one member has a note — that note shows", () => {
    assert.equal(resolveRole(AUDIO, { Audio: "Ring out on the 1" }), "Ring out on the 1");
  });

  test("the first member is absent — the next one shows", () => {
    assert.equal(resolveRole(AUDIO, { "Audio/Visual": "Roll VT" }), "Roll VT");
  });

  test("the first member is blank — the next one shows", () => {
    assert.equal(resolveRole(AUDIO, { Audio: "   ", "Audio/Visual": "Roll VT" }), "Roll VT");
  });

  test("both populated — merged, first-listed first", () => {
    const out = resolveRole(AUDIO, { "Audio/Visual": "Roll VT", Audio: "Ring out" });
    assert.equal(out, "Ring out\nRoll VT");
  });

  test("member order is the priority chain, not object order", () => {
    const reversed = { id: "r", name: "A", members: ["Audio/Visual", "Audio"] };
    assert.equal(resolveRole(reversed, { Audio: "second", "Audio/Visual": "first" }), "first\nsecond");
  });

  test("no member present — empty, so the cell renders blank", () => {
    assert.equal(resolveRole(AUDIO, { Lighting: "House to 40%" }), "");
  });

  test("a role with no members is empty rather than throwing", () => {
    assert.equal(resolveRole({ id: "r", name: "Empty", members: [] }, { Audio: "x" }), "");
  });

  test("a member is matched case-insensitively against PCO's exact key", () => {
    // "EG 1 (Lead)" and "EG 1 (LEAD)" both exist in the wild.
    const eg = { id: "r", name: "EG", members: ["eg 1 (lead)"] };
    assert.equal(resolveRole(eg, { "EG 1 (LEAD)": "Capo 3" }), "Capo 3");
  });
});

describe("roleAppliesTo", () => {
  test("true when the service type defines any member", () => {
    assert.equal(roleAppliesTo(AUDIO, ["Band", "Audio/Visual"]), true);
  });

  test("false when it defines none — the column is hidden, not empty", () => {
    // The bug this fixes: an Audio column rendered blank on the 13 service types that
    // say Audio/Visual.
    assert.equal(roleAppliesTo(AUDIO, ["Band", "Vocals"]), false);
  });

  test("matching ignores case and padding", () => {
    assert.equal(roleAppliesTo(AUDIO, ["  audio/VISUAL "]), true);
  });

  test("a role with no members applies to nothing", () => {
    assert.equal(roleAppliesTo({ id: "r", name: "Empty", members: [] }, ["Audio"]), false);
  });
});
