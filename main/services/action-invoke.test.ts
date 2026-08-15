import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-invoke-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { invokeAction, invocableActions } = await import("./action-invoke.js");
const { AUTOMATION_ACTIONS } = await import("./automation-actions.js");

// A control on a console invokes an ActionDef that already exists. The thing
// that must hold here is CONTAINMENT: the operator is standing at this console
// mid-service, and one badly-behaved provider must fail its own press rather
// than take the surface down.

describe("invokeAction", () => {
  it("returns a failed result for an unknown id rather than throwing", async () => {
    // A layout saved against a build that had an action this one does not - a
    // downgrade, or an integration removed. It must report, not explode.
    const r = await invokeAction("nope.not.an.action");
    assert.equal(r.ok, false);
    assert.match(r.detail, /unknown action/i);
  });

  it("names the id it could not find", async () => {
    const r = await invokeAction("osc.sned");
    assert.match(r.detail, /osc\.sned/, "the detail must name the id, or it is unfixable");
  });

  it("runs a real registered action and returns its result", async () => {
    const r = await invokeAction("log.message", { message: "from a console button" });
    assert.equal(typeof r.ok, "boolean");
    assert.equal(typeof r.detail, "string");
  });

  it("contains a provider that breaks the never-throw contract", async () => {
    // ActionDef promises never to throw. This asserts we do not TRUST that.
    AUTOMATION_ACTIONS["test.boom"] = {
      id: "test.boom",
      label: "boom",
      params: [],
      run: async () => { throw new Error("kaboom"); },
    };
    const r = await invokeAction("test.boom");
    assert.equal(r.ok, false, "a throwing provider must fail its press, not the console");
    assert.match(r.detail, /kaboom/, "and the reason must survive, not be swallowed");
    delete AUTOMATION_ACTIONS["test.boom"];
  });

  it("contains a provider that rejects", async () => {
    AUTOMATION_ACTIONS["test.reject"] = {
      id: "test.reject",
      label: "reject",
      params: [],
      run: () => Promise.reject(new Error("nope")),
    };
    const r = await invokeAction("test.reject");
    assert.equal(r.ok, false);
    assert.match(r.detail, /nope/);
    delete AUTOMATION_ACTIONS["test.reject"];
  });
});

describe("invocableActions", () => {
  it("offers the registered actions, sorted for a picker", async () => {
    const list = invocableActions();
    assert.ok(list.length >= 5, `expected the real registry, got ${list.length}`);
    const labels = list.map((a) => a.label);
    assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b)));
  });

  it("includes advancing PCO Live", async () => {
    // The design doc's point: advancing the plan is an ordinary control, not a
    // restricted one. Capability gating is what keeps it off a wall display.
    assert.ok(invocableActions().some((a) => a.id === "pco.live.advance"));
  });
});

after(() => fs.rm(TMP, { recursive: true, force: true }));
