// The action is the only piece that writes a signal, so this is where the
// hold-on-failure guarantee is enforced end to end: every refusal path must leave
// the previous value standing and record why.

import assert from "node:assert/strict";
import { describe, it, before, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { TeamMemberDTO } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-signal-action-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { AUTOMATION_ACTIONS } = await import("./automation-actions.js");
const { signalStore } = await import("./signal-store.js");
const { stageController } = await import("./stage-controller.js");

const action = () => AUTOMATION_ACTIONS["companion.signal-from-roster"];

const m = (name: string, notes: string | null, teamPositionName = "Vocals"): TeamMemberDTO => ({
  id: name, name, personId: name, photoUrl: null,
  teamPositionName, teamName: "Band", status: "C", notes,
});

function setRoster(members: TeamMemberDTO[]): void {
  (stageController as unknown as { teamMembers: TeamMemberDTO[] }).teamMembers = members;
}

const ROWS = JSON.stringify({ "1": "Vox 1", "2": "Vox 2", "4": "31.Vox 4" });
const params = (over: Record<string, unknown> = {}) => ({
  signal: "dante-tb", marker: "TB", position: "Vocals", rows: ROWS, ...over,
});

before(async () => {
  await signalStore.init();
});

beforeEach(() => {
  setRoster([]);
});

describe("companion.signal-from-roster", () => {
  it("publishes the exact string the operator typed", async () => {
    setRoster([m("A", "1"), m("B", "4 TB")]);
    const r = await action().run(params(), { simulate: false });
    assert.equal(r.ok, true);
    // Exactly what was typed, prefix and all — no template generated it.
    assert.equal(signalStore.all()["dante-tb"].value, "31.Vox 4");
    assert.match(r.detail, /B, slot 4/);
  });

  it("holds the previous value when nobody is marked", async () => {
    setRoster([m("A", "1"), m("B", "4 TB")]);
    await action().run(params(), { simulate: false });
    setRoster([m("A", "1"), m("B", "4")]);
    const r = await action().run(params(), { simulate: false });
    assert.equal(r.ok, false);
    assert.equal(signalStore.all()["dante-tb"].value, "31.Vox 4", "route must survive");
    assert.match(signalStore.all()["dante-tb"].error ?? "", /nobody/);
  });

  it("holds the previous value when two people are marked", async () => {
    setRoster([m("B", "4 TB")]);
    await action().run(params(), { simulate: false });
    setRoster([m("A", "1 TB"), m("B", "4 TB")]);
    const r = await action().run(params(), { simulate: false });
    assert.equal(r.ok, false);
    assert.equal(signalStore.all()["dante-tb"].value, "31.Vox 4");
    assert.match(signalStore.all()["dante-tb"].error ?? "", /two or more/);
  });

  it("holds when the matched slot has no row, and names the slot", async () => {
    setRoster([m("B", "4 TB")]);
    await action().run(params(), { simulate: false });
    setRoster([m("C", "3 TB")]);
    const r = await action().run(params(), { simulate: false });
    assert.equal(r.ok, false);
    assert.match(r.detail, /slot 3/);
    assert.equal(signalStore.all()["dante-tb"].value, "31.Vox 4");
  });

  it("writes nothing in simulate mode", async () => {
    setRoster([m("B", "2 TB")]);
    const before = signalStore.all()["sim-only"];
    const r = await action().run(params({ signal: "sim-only" }), { simulate: true });
    assert.equal(r.ok, true);
    assert.match(r.detail, /SIMULATED/);
    assert.equal(signalStore.all()["sim-only"], before);
  });

  it("refuses without a signal name rather than writing an empty key", async () => {
    setRoster([m("B", "2 TB")]);
    const r = await action().run(params({ signal: "  " }), { simulate: false });
    assert.equal(r.ok, false);
  });

  it("treats a malformed rows table as empty rather than throwing", async () => {
    setRoster([m("B", "2 TB")]);
    for (const rows of ["not json", "[1,2,3]", "", null]) {
      const r = await action().run(params({ signal: "bad-rows", rows }), { simulate: false });
      assert.equal(r.ok, false, `rows=${JSON.stringify(rows)}`);
    }
  });

  it("never throws, whatever it is handed", async () => {
    setRoster(undefined as never);
    const r = await action().run(params(), { simulate: false });
    assert.equal(r.ok, false);
  });
});
