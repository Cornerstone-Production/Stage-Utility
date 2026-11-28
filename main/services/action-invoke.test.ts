import assert from "node:assert/strict";
import { describe, it, after, type TestContext } from "node:test";
import { captureConsole } from "./fixtures/capture-console.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-invoke-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { invokeAction } = await import("./action-invoke.js");
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
      help: "test",
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
      help: "test",
      params: [],
      run: () => Promise.reject(new Error("nope")),
    };
    const r = await invokeAction("test.reject");
    assert.equal(r.ok, false);
    assert.match(r.detail, /nope/);
    delete AUTOMATION_ACTIONS["test.reject"];
  });
});

describe("invokeAction — a refusal leaves a line on /log", () => {
  // Filtered to this one tag: baptism-timer-service.ts and others already log
  // their own "[baptism] …"/"[cues] …" lines through console.warn/console.log,
  // and this suite must not mistake one of those for the line under test.
  function captureActionWarnings(t: TestContext) {
    const warned = captureConsole(t, "warn");
    return {
      get lines() {
        return warned.filter((l) => l.startsWith("[action]"));
      },
    };
  }

  it("logs an unknown id, generically — not a baptism action, on purpose: this must cover every action, not one", async (t) => {
    const logged = captureActionWarnings(t);
    await invokeAction("nope.not.an.action");
    assert.equal(logged.lines.length, 1, "expected exactly one [action] line for one refused press");
    assert.match(logged.lines[0]!, /^\[action\] nope\.not\.an\.action refused: unknown action/);
  });

  it("logs a registered action's own refusal, not only an unknown id", async (t) => {
    AUTOMATION_ACTIONS["test.refuse"] = {
      id: "test.refuse",
      label: "refuse",
      help: "test",
      params: [],
      run: async () => ({ ok: false, detail: "nothing to do" }),
    };
    const logged = captureActionWarnings(t);
    try {
      const r = await invokeAction("test.refuse");
      assert.equal(r.ok, false);
    } finally {
      delete AUTOMATION_ACTIONS["test.refuse"];
    }
    assert.equal(logged.lines.length, 1);
    assert.match(logged.lines[0]!, /^\[action\] test\.refuse refused: nothing to do/);
  });

  it("logs a provider that breaks the never-throw contract, same as an ordinary refusal", async (t) => {
    AUTOMATION_ACTIONS["test.boom"] = {
      id: "test.boom",
      label: "boom",
      help: "test",
      params: [],
      run: async () => { throw new Error("kaboom"); },
    };
    const logged = captureActionWarnings(t);
    try {
      await invokeAction("test.boom");
    } finally {
      delete AUTOMATION_ACTIONS["test.boom"];
    }
    assert.equal(logged.lines.length, 1);
    assert.match(logged.lines[0]!, /^\[action\] test\.boom refused: kaboom/);
  });

  it("says nothing at all when the press succeeds", async (t) => {
    const logged = captureActionWarnings(t);
    const r = await invokeAction("log.message", { message: "from a console button" });
    assert.equal(r.ok, true);
    assert.deepEqual(logged.lines, [], "a working press must not add a line to /log — only a refusal is worth an operator's attention");
  });

  it("scrubs a newline out of the id so a crafted actionId cannot forge a second log line", async (t) => {
    const logged = captureActionWarnings(t);
    await invokeAction("nope\n[action] forged: whatever you like");
    assert.equal(logged.lines.length, 1, "one press must still produce exactly one log line, not two");
    assert.doesNotMatch(logged.lines[0]!, /\n/, "a raw newline would let the rest of the string masquerade as its own log line");
  });
});

after(() => fs.rm(TMP, { recursive: true, force: true }));
