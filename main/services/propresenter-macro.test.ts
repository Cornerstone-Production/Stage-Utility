// Triggering a ProPresenter macro from a rule — the service, the manager and
// the `propresenter.macro` action, together, because they are one feature and
// one stub serves all three.
//
// Every case here runs against a REAL http.createServer on an ephemeral port,
// not a mocked fetch. The service dials ProPresenter with `http.get`, and the
// two things most worth pinning — that a name with a space is URL-encoded into
// ONE path segment, and that a 404 reads as "no such macro" rather than
// "HTTP 404" — are both properties of the wire, not of a helper. A stub that
// records `req.url` sees exactly what ProPresenter would have seen.
//
// The booth machine is never contacted: nothing in this file knows its address.

import assert from "node:assert/strict";
import { afterEach, before, after, describe, it } from "node:test";
import * as http from "node:http";

import { AUTOMATION_ACTIONS } from "./automation-actions.js";
import { propresenterService, propresenterManager } from "./propresenter-service.js";

/** Every path the stub was asked for, in order. */
let seen: string[] = [];

/**
 * Just the MACRO requests.
 *
 * `configure()` starts the poller, and its first six requests are already in
 * flight by the time `stop()` lands — they arrive at the stub whenever they
 * arrive. Filtering to `/v1/macro` (which covers both `/v1/macros` and
 * `/v1/macro/<name>/trigger`, and no polled endpoint) keeps every assertion
 * below about the thing under test, including the "contacts nothing" ones:
 * those claim no MACRO request went out, which is exactly the claim.
 */
const macroPaths = (): string[] => seen.filter((p) => p.startsWith("/v1/macro"));
/** What the stub answers for a trigger; the macro list is always the same. */
let triggerStatus = 204;

const MACROS = [
  { id: { uuid: "u-1", name: "DOORS", index: 0 } },
  { id: { uuid: "u-2", name: "SONG INTRO", index: 1 } },
  { id: { uuid: "u-3", name: "Kids Worship", index: 2 } },
];

let server: http.Server;
let port = 0;

before(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    if (req.url === "/v1/macros") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(MACROS));
      return;
    }
    // ProPresenter answers a trigger with no body at all, which is why the
    // service reads the STATUS and ignores what came back.
    res.writeHead(triggerStatus);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

after(() => {
  server.close();
});

/** A configured, STOPPED primary instance: `configure` starts the poll, and a
 *  stopped service keeps host/port, still runs a command, and leaves no timer. */
function configured(): void {
  propresenterService.configure("127.0.0.1", port);
  propresenterService.stop();
  seen = [];
  triggerStatus = 204;
  // The macro cache is per-instance and 30s long, so a case that expects a
  // request has to start from a cold one.
  clearMacroCache();
}

/** The private cache, cleared between cases. Reaching in beats exporting a
 *  test-only method: the cache is an implementation detail of listMacros. */
function clearMacroCache(): void {
  (propresenterService as unknown as { macroCache: unknown }).macroCache = null;
}

function unconfigured(): void {
  propresenterService.configure("", 0);
  propresenterService.stop();
  seen = [];
  clearMacroCache();
}

describe("propresenterService.triggerMacro", () => {
  afterEach(() => {
    unconfigured();
  });

  it("URL-encodes the macro name into one path segment", async () => {
    configured();
    const r = await propresenterService.triggerMacro("SONG INTRO", "MA");
    assert.equal(r.ok, true);
    // The bug this pins: an unencoded name is three path segments, and
    // /v1/macro/SONG INTRO/trigger is not a request ProPresenter can route.
    assert.deepEqual(macroPaths(), ["/v1/macro/SONG%20INTRO/trigger"]);
  });

  it("encodes the other characters a macro name can carry", async () => {
    configured();
    await propresenterService.triggerMacro("Kids Worship / Pre-Roll", "MA");
    assert.deepEqual(macroPaths(), ["/v1/macro/Kids%20Worship%20%2F%20Pre-Roll/trigger"]);
  });

  it("a 404 reads as no such macro, naming the macro and the machine", async () => {
    configured();
    triggerStatus = 404;
    const r = await propresenterService.triggerMacro("SONG INTRO", "MA");
    assert.equal(r.ok, false);
    // "HTTP 404" alone is what wastes the Sunday morning. A renamed or deleted
    // macro has to say so, and say where it was looked for.
    assert.equal(r.detail, 'no macro called "SONG INTRO" on MA');
  });

  it("any other HTTP error is a returned failure, never a throw", async () => {
    configured();
    triggerStatus = 500;
    const r = await propresenterService.triggerMacro("DOORS", "MA");
    assert.equal(r.ok, false);
    assert.match(r.detail, /HTTP 500/);
  });

  it("an unreachable ProPresenter fails rather than throwing, and names the address", async () => {
    // A port nothing is listening on: the connection is refused, which is
    // exactly what a booth machine that is off does.
    propresenterService.configure("127.0.0.1", 9);
    propresenterService.stop();
    const r = await propresenterService.triggerMacro("DOORS", "MA");
    assert.equal(r.ok, false);
    assert.match(r.detail, /127\.0\.0\.1:9/);
  });

  it("an unconfigured ProPresenter fails, and contacts nothing", async () => {
    unconfigured();
    const r = await propresenterService.triggerMacro("DOORS", "MA");
    assert.deepEqual(r, { ok: false, detail: "MA is not configured" });
    assert.deepEqual(macroPaths(), []);
  });

  it("a blank macro name fails, and contacts nothing", async () => {
    configured();
    const r = await propresenterService.triggerMacro("   ", "MA");
    assert.equal(r.ok, false);
    assert.deepEqual(macroPaths(), []);
  });
});

describe("propresenterService.listMacros", () => {
  afterEach(() => {
    unconfigured();
  });

  it("reads the names out of ProPresenter's own shape", async () => {
    configured();
    const r = await propresenterService.listMacros();
    assert.deepEqual(r, { names: ["DOORS", "SONG INTRO", "Kids Worship"], error: null });
    assert.deepEqual(macroPaths(), ["/v1/macros"]);
  });

  it("caches, so opening the rule editor twice is one round trip", async () => {
    configured();
    await propresenterService.listMacros();
    await propresenterService.listMacros();
    assert.deepEqual(macroPaths(), ["/v1/macros"], "the second read went back to ProPresenter");
  });

  it("does NOT cache a failure — a machine rebooting must not pin an empty list", async () => {
    propresenterService.configure("127.0.0.1", 9);
    propresenterService.stop();
    clearMacroCache();
    const first = await propresenterService.listMacros();
    assert.equal(first.names.length, 0);
    assert.ok(first.error, "a failed read has to come back with a reason");

    // Now point it at the live stub without clearing anything: a cached empty
    // list would still be within MACRO_CACHE_MS and would answer from it.
    propresenterService.configure("127.0.0.1", port);
    propresenterService.stop();
    seen = [];
    const second = await propresenterService.listMacros();
    assert.deepEqual(second.names, ["DOORS", "SONG INTRO", "Kids Worship"]);
  });

  it("an unreachable ProPresenter returns an empty list plus the reason", async () => {
    propresenterService.configure("127.0.0.1", 9);
    propresenterService.stop();
    clearMacroCache();
    const r = await propresenterService.listMacros();
    assert.deepEqual(r.names, []);
    assert.match(r.error ?? "", /127\.0\.0\.1:9/);
  });

  it("an unconfigured ProPresenter returns an empty list plus the reason", async () => {
    unconfigured();
    const r = await propresenterService.listMacros();
    assert.deepEqual(r.names, []);
    assert.match(r.error ?? "", /not configured/);
  });
});

describe("propresenterManager macro routing", () => {
  afterEach(() => {
    unconfigured();
    // Leave no extras behind for the next file — apply([]) tears them down.
    propresenterManager.apply(null, []);
  });

  it("an unknown instance id is a returned failure, not a throw", async () => {
    configured();
    const r = await propresenterManager.triggerMacro("auditorium-9", "DOORS");
    assert.equal(r.ok, false);
    assert.match(r.detail, /auditorium-9/);
    assert.deepEqual(macroPaths(), [], "an unknown instance must not dial anything");
  });

  it("an unknown instance id yields an empty macro list plus the reason", async () => {
    const r = await propresenterManager.listMacros("auditorium-9");
    assert.deepEqual(r.names, []);
    assert.match(r.error ?? "", /auditorium-9/);
  });

  it("a blank instance id is the primary", async () => {
    configured();
    propresenterManager.apply("MA", []);
    const r = await propresenterManager.triggerMacro("", "DOORS");
    assert.equal(r.ok, true);
    assert.equal(r.detail, 'triggered "DOORS" on MA');
    assert.deepEqual(macroPaths(), ["/v1/macro/DOORS/trigger"]);
  });

  it("the union across instances notes where a name exists on only one", async () => {
    configured();
    propresenterManager.apply("MA", [
      { id: "chapel", name: "Chapel", host: "127.0.0.1", port, enabled: true },
    ]);
    const all = await propresenterManager.allMacros();
    assert.equal(all.instanceCount, 2);
    assert.deepEqual(all.unreachable, []);
    // Both instances are the same stub, so every name is on both.
    assert.deepEqual(
      all.names.map((n) => n.name),
      ["DOORS", "SONG INTRO", "Kids Worship"],
    );
    for (const n of all.names) assert.deepEqual(n.instances, ["MA", "Chapel"]);
  });

  it("one unreachable instance costs its own macros, never the other's", async () => {
    configured();
    propresenterManager.apply("MA", [
      { id: "chapel", name: "Chapel", host: "127.0.0.1", port: 9, enabled: true },
    ]);
    const all = await propresenterManager.allMacros();
    assert.deepEqual(all.unreachable, ["Chapel"]);
    assert.deepEqual(
      all.names.map((n) => n.name),
      ["DOORS", "SONG INTRO", "Kids Worship"],
      "the reachable instance's macros still have to be offered",
    );
  });
});

describe("the propresenter.macro action", () => {
  const action = AUTOMATION_ACTIONS["propresenter.macro"];

  afterEach(() => {
    unconfigured();
    propresenterManager.apply(null, []);
  });

  it("simulate contacts ProPresenter not at all", async () => {
    configured();
    propresenterManager.apply("MA", []);
    const r = await action.run({ instance: "default", macro: "SONG INTRO" }, { simulate: true });
    assert.deepEqual(r, { ok: true, detail: 'would trigger "SONG INTRO"' });
    // A simulated cue that still dials the booth is a cue that cannot be tested
    // with the machine off, which is when a rule is usually written.
    assert.deepEqual(macroPaths(), []);
  });

  it("triggers the macro on the chosen instance", async () => {
    configured();
    propresenterManager.apply("MA", []);
    const r = await action.run({ instance: "default", macro: "SONG INTRO" }, { simulate: false });
    assert.deepEqual(r, { ok: true, detail: 'triggered "SONG INTRO" on MA' });
    assert.deepEqual(macroPaths(), ["/v1/macro/SONG%20INTRO/trigger"]);
  });

  // Both blank cases are asserted under SIMULATE, which is the half the action
  // owns: with simulate off the service refuses a blank name with the same
  // sentence, so a test there would pass with this guard deleted — vacuous.
  // Ahead of the simulate branch, a rule with nothing chosen would otherwise
  // test as `would trigger ""` and read as ready.
  it("a blank macro is refused ahead of simulate, not reported as OK", async () => {
    configured();
    const r = await action.run({ instance: "default", macro: "   " }, { simulate: true });
    assert.deepEqual(r, { ok: false, detail: "no macro chosen" });
    assert.deepEqual(macroPaths(), []);
  });

  it("a missing macro param is refused the same way", async () => {
    configured();
    const r = await action.run({ instance: "default" }, { simulate: true });
    assert.deepEqual(r, { ok: false, detail: "no macro chosen" });
    assert.deepEqual(macroPaths(), []);
  });

  it("an instance that is no longer configured fails rather than throwing", async () => {
    configured();
    const r = await action.run({ instance: "auditorium-9", macro: "DOORS" }, { simulate: false });
    assert.equal(r.ok, false);
    assert.match(r.detail, /auditorium-9/);
  });

  it("an unreachable ProPresenter fails rather than throwing", async () => {
    propresenterService.configure("127.0.0.1", 9);
    propresenterService.stop();
    propresenterManager.apply("MA", []);
    const r = await action.run({ instance: "default", macro: "DOORS" }, { simulate: false });
    assert.equal(r.ok, false);
    assert.match(r.detail, /127\.0\.0\.1:9/);
  });

  it("a 404 reaches the rule as no-such-macro, not as HTTP 404", async () => {
    configured();
    propresenterManager.apply("MA", []);
    triggerStatus = 404;
    const r = await action.run({ instance: "default", macro: "SONG INTRO" }, { simulate: false });
    assert.deepEqual(r, { ok: false, detail: 'no macro called "SONG INTRO" on MA' });
  });
});
