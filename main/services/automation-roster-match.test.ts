import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TeamMemberDTO } from "../types/stage.js";
import { matchRoster } from "./automation-roster-match.js";

const m = (name: string, notes: string | null, teamPositionName = "Vocals"): TeamMemberDTO => ({
  id: name, name, personId: name, photoUrl: null,
  teamPositionName, teamName: "Band", status: "C", notes,
});

const opts = { marker: "TB", position: "Vocals" };

describe("matchRoster", () => {
  it("matches the one person whose note carries the marker", () => {
    const r = matchRoster([m("A", "1"), m("B", "4 TB"), m("C", "2")], opts);
    assert.ok(r.ok);
    assert.equal(r.slot, 4);
    assert.equal(r.member.name, "B");
  });

  it("is case-insensitive and tolerates where the marker sits", () => {
    for (const note of ["4 tb", "tb 4", "4 - TB", "4TB", "TB, 4"]) {
      const r = matchRoster([m("B", note)], opts);
      assert.ok(r.ok, `should match ${JSON.stringify(note)}`);
      assert.equal(r.slot, 4, `slot from ${JSON.stringify(note)}`);
    }
  });

  it("does not treat TBD as the TB marker", () => {
    // "TBD" in a note is a scheduling comment, not talkback. Whole-word matching.
    assert.equal(matchRoster([m("B", "4 TBD")], opts).ok, false);
    assert.equal(matchRoster([m("B", "4 - to be decided")], opts).ok, false);
  });

  it("reads 10 as ten, not as one", () => {
    // The prefix ambiguity slot-resolver still has: "1".startsWith matches "10".
    const r = matchRoster([m("B", "10 TB")], opts);
    assert.ok(r.ok);
    assert.equal(r.slot, 10);
  });

  it("refuses when two people carry the marker", () => {
    const r = matchRoster([m("A", "1 TB"), m("B", "4 TB")], opts);
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; reason: string }).reason, /A, B/);
  });

  it("refuses when nobody carries it", () => {
    assert.equal(matchRoster([m("A", "1"), m("B", "2")], opts).ok, false);
  });

  it("refuses when the marked note has no number", () => {
    const r = matchRoster([m("B", "TB")], opts);
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; reason: string }).reason, /no number/i);
  });

  it("applies the position filter, and skips it when blank", () => {
    const roster = [m("B", "4 TB", "Guitar")];
    assert.equal(matchRoster(roster, { marker: "TB", position: "Vocals" }).ok, false);
    assert.ok(matchRoster(roster, { marker: "TB", position: "" }).ok);
    assert.ok(matchRoster(roster, { marker: "TB" }).ok);
  });

  it("ignores people with no notes rather than throwing", () => {
    assert.equal(matchRoster([m("A", null), m("B", "   ")], opts).ok, false);
  });

  it("refuses without a marker rather than matching everyone", () => {
    const r = matchRoster([m("A", "1"), m("B", "2")], { marker: "" });
    assert.equal(r.ok, false);
  });

  it("survives a malformed roster", () => {
    assert.equal(matchRoster(undefined as never, opts).ok, false);
    assert.equal(matchRoster([null as never], opts).ok, false);
  });

  it("treats a marker with regex characters literally", () => {
    // An operator may type anything here; it must not become a pattern.
    assert.ok(matchRoster([m("B", "4 T.B")], { marker: "T.B" }).ok);
    assert.equal(matchRoster([m("B", "4 TXB")], { marker: "T.B" }).ok, false);
  });
});
