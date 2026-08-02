// The PCO Live action's tests. The guarantee worth protecting here is that one
// invocation issues at most ONE step: PCO has no jump action, so a rule that
// looped would fire every item it stepped over, live, in front of the room.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { PcoLiveDTO } from "../types/stage.js";
import { AUTOMATION_ACTIONS, liveDeps } from "./automation-actions.js";
import { advanceGuard } from "./automation-pco-items.js";

describe("advanceGuard", () => {
  it("allows the step when the next item matches", () => {
    assert.equal(advanceGuard("Doors Open", "doors").advance, true);
  });

  it("blocks the step when the next item is something else", () => {
    const v = advanceGuard("Welcome", "doors");
    assert.equal(v.advance, false);
    // The reason has to name both, or the log cannot explain the skip.
    assert.match(v.reason, /Welcome/);
    assert.match(v.reason, /doors/);
  });

  it("steps unconditionally when no guard is given", () => {
    assert.equal(advanceGuard("Anything", "").advance, true);
    assert.equal(advanceGuard(null, "   ").advance, true);
  });

  it("blocks when PCO reports no next item", () => {
    const v = advanceGuard(null, "doors");
    assert.equal(v.advance, false);
    assert.match(v.reason, /no next item/);
  });
});

describe("pco.live.advance", () => {
  const action = AUTOMATION_ACTIONS["pco.live.advance"];
  const realGetLive = liveDeps.getLive;
  const realAdvance = liveDeps.advance;
  afterEach(() => {
    liveDeps.getLive = realGetLive;
    liveDeps.advance = realAdvance;
  });

  let calls = 0;
  function fakePco(nextItemTitle: string | null, onAdvance?: () => Promise<void>): void {
    calls = 0;
    liveDeps.getLive = () => ({ nextItemTitle } as PcoLiveDTO);
    liveDeps.advance = async () => {
      calls++;
      if (onAdvance) await onAdvance();
    };
  }

  it("advances when the next item matches the guard", async () => {
    fakePco("Doors Open");
    const r = await action.run({ guardTitle: "doors" }, { simulate: false });
    assert.equal(r.ok, true);
    assert.equal(calls, 1);
    assert.match(r.detail, /^advanced/);
  });

  it("does NOT advance when the next item does not match", async () => {
    fakePco("Welcome");
    const r = await action.run({ guardTitle: "doors" }, { simulate: false });
    assert.equal(calls, 0, "it stepped the live plan despite the guard");
    assert.match(r.detail, /^skipped/);
    assert.match(r.detail, /Welcome/);
  });

  it("advances unguarded when no guardTitle is given", async () => {
    fakePco("Whatever");
    await action.run({}, { simulate: false });
    assert.equal(calls, 1);
  });

  it("issues no request at all in simulate mode", async () => {
    fakePco("Doors Open");
    const r = await action.run({ guardTitle: "doors" }, { simulate: true });
    assert.equal(calls, 0);
    assert.match(r.detail, /^would advance/);
  });

  it("reports PCO's own wording when it refuses", async () => {
    // A silent rule is this feature's worst failure, so the 403 body has to
    // survive intact all the way to the Activity log.
    fakePco("Doors Open", async () => {
      throw new Error("PCO API error 403: You are not a live controller for this plan");
    });
    const r = await action.run({ guardTitle: "doors" }, { simulate: false });
    assert.equal(r.ok, false);
    assert.match(r.detail, /403/);
    assert.match(r.detail, /not a live controller/);
  });

  it("never steps more than once per invocation", async () => {
    // The no-loop guarantee, asserted rather than assumed.
    fakePco("Doors Open");
    await action.run({ guardTitle: "doors" }, { simulate: false });
    assert.equal(calls, 1);
  });

  it("never throws, whatever PCO does", async () => {
    // The engine trusts every action to return rather than throw; one bad
    // provider must not stop the rules that follow it.
    liveDeps.getLive = () => {
      throw new Error("no plan selected");
    };
    const r = await action.run({ guardTitle: "doors" }, { simulate: false });
    assert.equal(r.ok, false);
    assert.match(r.detail, /no plan selected/);
  });
});
