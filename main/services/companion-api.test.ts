// Pressing a Companion button, and reading its configuration.
//
// The press path is covered with a STUBBED fetch and never against the real
// Companion — a test that presses a button turns something on in a building.
// What is asserted is the exact URL and method Companion wants, and the two
// answers that are easy to read wrong:
//
//  - 204, which Companion returns for a coordinate that holds no control. The
//    request succeeded and nothing was pressed. Read as success, a cue for a
//    button somebody moved reads as working forever.
//  - a network failure, which must come back as a result rather than a throw:
//    an ActionDef that throws stops the whole engine.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

// companion-api's getTarget seam reaches the integration manager, which resolves
// the data directory at import. Point it somewhere disposable first.
process.env.STAGE_UTILITY_DATA = await fsp.mkdtemp(path.join(os.tmpdir(), "companion-api-"));

const { companionApi, companionDeps, CONNECTIONS_TIMEOUT_MS, VARIABLE_TIMEOUT_MS } = await import(
  "./companion-api.js"
);
const { AUTOMATION_ACTIONS } = await import("./automation-actions.js");
const { companionExportFixture } = await import("./fixtures/companion-export.js");

const realFetch = companionDeps.fetch;
const realTarget = companionDeps.getTarget;

interface Call {
  url: string;
  method: string;
  body: string;
  /** Whatever was passed as `init.signal`, so the timeout can be asserted. */
  signal: AbortSignal | null | undefined;
}

/** Record every request and answer it however the case needs. */
function stub(answer: (url: string) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  companionDeps.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: String(init?.body ?? ""),
      signal: init?.signal as AbortSignal | null | undefined,
    });
    return answer(url);
  };
  return calls;
}

const target = (t: { host: string; port: number } | null) => {
  companionDeps.getTarget = async () => t;
};

afterEach(() => {
  companionDeps.fetch = realFetch;
  companionDeps.getTarget = realTarget;
  companionApi.invalidate();
});

describe("press", () => {
  test("posts the coordinate Companion's API takes, with an empty JSON body", async () => {
    target({ host: "192.168.1.100", port: 8000 });
    const calls = stub(() => new Response("ok", { status: 200 }));

    const r = await companionApi.press({ page: 17, row: 2, col: 6 });

    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "http://192.168.1.100:8000/api/location/17/2/6/press");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.body, "{}");
  });

  test("204 is a FAILURE — Companion pressed nothing", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stub(() => new Response(null, { status: 204 }));

    const r = await companionApi.press({ page: 99, row: 9, col: 9 });

    assert.equal(r.ok, false);
    assert.equal(r.status, 204);
    assert.match(r.detail, /no button at p99 r9 c9/);
  });

  test("a non-2xx is a failure carrying the status", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stub(() => new Response("nope", { status: 500 }));

    const r = await companionApi.press({ page: 1, row: 0, col: 0 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /HTTP 500/);
  });

  test("a network failure RETURNS, it does not throw", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const r = await companionApi.press({ page: 1, row: 0, col: 0 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /ECONNREFUSED/);
  });

  test("a coordinate that is not a whole non-negative number is refused, unsent", async () => {
    // Each of these becomes a path segment of the press URL. A fraction is a
    // button that cannot exist; a negative or a string is text pasted into a
    // path. Refused here as well as in the action, because every caller reaches
    // Companion through this method.
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stub(() => new Response("ok", { status: 200 }));

    for (const loc of [
      { page: 1.5, row: 0, col: 0 },
      { page: -1, row: 0, col: 0 },
      { page: 1, row: -2, col: 0 },
      { page: 1, row: 0, col: Number.NaN },
      { page: 1, row: 0, col: "0/../.." as unknown as number },
    ]) {
      const r = await companionApi.press(loc);
      assert.equal(r.ok, false, `${JSON.stringify(loc)} was accepted`);
      assert.match(r.detail, /not a Companion coordinate/);
    }
    assert.equal(calls.length, 0, "an invalid coordinate reached the wire");
  });

  test("with no host configured it fails without dialling anything", async () => {
    target(null);
    const calls = stub(() => new Response("ok"));

    const r = await companionApi.press({ page: 1, row: 0, col: 0 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /not configured/);
    assert.equal(calls.length, 0);
  });
});

describe("the companion.press action", () => {
  const action = AUTOMATION_ACTIONS["companion.press"]!;

  test("reports DISPATCHED, never on — Companion confirms delivery, not effect", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stub(() => new Response("ok", { status: 200 }));

    const r = await action.run(
      { page: 17, row: 2, col: 6, label: "Projectors ON" },
      { simulate: false },
    );
    assert.equal(r.ok, true);
    assert.equal(r.detail, 'dispatched p17 r2 c6 "Projectors ON"');
    // The wording is load-bearing. "on" would be a claim about a projector
    // nothing in this chain has looked at.
    assert.equal(/\bis on\b/.test(r.detail), false);
  });

  test("the action refuses a bad coordinate with ok:false, before dialling", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stub(() => new Response("ok", { status: 200 }));

    for (const params of [
      { page: 1.5, row: 0, col: 0 },
      { page: 1, row: -1, col: 0 },
      { page: 1, row: 0, col: "2" },
    ]) {
      const r = await action.run({ ...params, label: "x" }, { simulate: false });
      // "2" is a string a JSON body can carry, and Number() takes it — a whole
      // non-negative number in a string is a coordinate, not an attack.
      if (params.col === "2") {
        assert.equal(r.ok, true);
        continue;
      }
      assert.equal(r.ok, false, `${JSON.stringify(params)} was accepted`);
      assert.match(r.detail, /not a Companion coordinate/);
    }
    assert.equal(calls.length, 1, "only the string-but-whole coordinate was sent");
  });

  test("a refused press is a failed result, with the reason", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stub(() => new Response(null, { status: 204 }));

    const r = await action.run({ page: 1, row: 0, col: 0, label: "Gone" }, { simulate: false });
    assert.equal(r.ok, false);
    assert.match(r.detail, /Companion answered 204/);
  });

  test("simulate presses nothing", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stub(() => new Response("ok"));

    const r = await action.run({ page: 1, row: 2, col: 3 }, { simulate: true });
    assert.equal(r.ok, true);
    assert.match(r.detail, /^would press/);
    assert.equal(calls.length, 0);
  });

  test("an unconfigured action fails rather than pressing p0 r0 c0", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stub(() => new Response("ok"));

    const r = await action.run({}, { simulate: false });
    assert.equal(r.ok, false);
    assert.match(r.detail, /no Companion button chosen/);
    assert.equal(calls.length, 0);
  });
});

describe("fetchExport", () => {
  test("parses, and caches — a second read does not hit Companion", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stub(() => Response.json(companionExportFixture()));

    const first = await companionApi.fetchExport();
    assert.equal(first.ok, true);
    assert.ok(first.ok && first.buttons.length === 30);

    await companionApi.fetchExport();
    assert.equal(calls.length, 1, "the second read came from the cache");

    await companionApi.fetchExport({ force: true });
    assert.equal(calls.length, 2, "force goes back to Companion");
  });

  test("unreachable returns the reason — never an empty button list", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async () => {
      throw new Error("ETIMEDOUT");
    };

    const r = await companionApi.fetchExport();
    assert.equal(r.ok, false);
    // "no buttons" and "cannot reach Companion" are different screens.
    assert.ok(!r.ok && /ETIMEDOUT/.test(r.reason));
  });

  test("a network failure names the address, not just \"fetch failed\"", async () => {
    // Node's message for every network failure is the word "fetch failed", with
    // the real reason on `cause`. Driving the picker against a dead port put
    // exactly that on screen, which tells an operator nothing.
    target({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async () => {
      throw new Error("fetch failed", { cause: new Error("connect ECONNREFUSED 10.0.0.5:8000") });
    };

    const r = await companionApi.fetchExport();
    assert.ok(!r.ok);
    assert.equal(r.reason, "connect ECONNREFUSED 10.0.0.5:8000");
  });

  test("a bare failure with no cause still names where it was going", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async () => {
      throw new Error("fetch failed");
    };

    const r = await companionApi.fetchExport();
    assert.ok(!r.ok && r.reason === "could not reach http://10.0.0.5:8000");
  });

  test("a password-protected Companion says so, rather than just 401", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stub(() => new Response("", { status: 401 }));

    const r = await companionApi.fetchExport();
    assert.ok(!r.ok && /admin password/.test(r.reason));
  });
});

/**
 * Companion's connection list, in the shape `GET /api/connections` answers.
 *
 * `status: null` on an enabled connection is deliberate and is what ten of the
 * live install's fifty-two enabled connections look like — see
 * companion-connections.test.ts.
 */
const connectionsBody = (): unknown => [
  { id: "a", label: "MA_HL_Projector", moduleId: "generic-pjlink", enabled: true, status: { category: "good", level: "ok", message: null } },
  { id: "b", label: "Bulb", moduleId: "tplink-kasasmartbulb", enabled: true, status: { category: "error", level: "Connecting", message: null } },
  { id: "c", label: "Plug", moduleId: "tplink-kasasmartplug", enabled: true, status: null },
  { id: "d", label: "Off", moduleId: "obs-studio", enabled: false, status: null },
];

/** Answer the export URL with the fixture and the connections URL with the list. */
const stubBoth = (connections: () => Response) =>
  stub((url) => (url.includes("/api/connections") ? connections() : Response.json(companionExportFixture())));

describe("testConnection", () => {
  test("reports the Companion build and the button count", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stubBoth(() => Response.json(connectionsBody()));

    const r = await companionApi.testConnection();
    assert.equal(r.ok, true);
    assert.match(r.message, /Companion 5\.0\.3/);
    assert.match(r.message, /30 button\(s\)/);
    assert.match(r.message, /6 on\/off pair\(s\)/);
  });

  test("presses nothing", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stubBoth(() => Response.json(connectionsBody()));

    await companionApi.testConnection();
    assert.equal(calls.filter((c) => c.url.includes("/press")).length, 0);
  });

  test("no host is a refusal, not a reach", async () => {
    target(null);
    const r = await companionApi.testConnection();
    assert.equal(r.ok, false);
    assert.match(r.message, /Host is required/);
  });

  // Why Test carries it at all: "Companion answered" is not the question an
  // operator presses Test to settle. A cue bound to a module variable reads
  // unknown when the CONNECTION is down, and nothing else on the page said so.
  test("carries the connection health in the same sentence", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stubBoth(() => Response.json(connectionsBody()));

    const r = await companionApi.testConnection();
    assert.match(r.message, /1 of 3 connection\(s\) in error, 1 not reporting/);
  });

  test("gear being down is not a failed test — Companion answered", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stubBoth(() => Response.json(connectionsBody()));

    const r = await companionApi.testConnection();
    assert.equal(r.ok, true);
  });

  test("forces the connection read past the cache, like the export", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stubBoth(() => Response.json(connectionsBody()));

    await companionApi.readConnections();
    await companionApi.testConnection();

    assert.equal(calls.filter((c) => c.url.endsWith("/api/connections")).length, 2);
  });

  // A 4.x Companion has no such endpoint. Saying "unavailable" on every one of
  // them would be a red sentence about a diagnostic that was never coming.
  test("a Companion too old to have the endpoint says nothing about it", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stubBoth(() => new Response("Not found", { status: 404 }));

    const r = await companionApi.testConnection();
    assert.equal(r.ok, true);
    assert.match(r.message, /6 on\/off pair\(s\)$/);
  });

  // The other way round: the export worked, so a connection list that did not
  // is a fact the operator has not been told anywhere else.
  test("a connection read that fails for any OTHER reason is said out loud", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stubBoth(() => new Response("nope", { status: 500 }));

    const r = await companionApi.testConnection();
    assert.match(r.message, /connection status unavailable: Companion answered HTTP 500/);
  });
});

describe("readConnections", () => {
  test("reads Companion's own endpoint and sums it up", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stubBoth(() => Response.json(connectionsBody()));

    const r = await companionApi.readConnections({ force: true });
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      ["GET http://10.0.0.5:8000/api/connections"],
    );
    assert.equal(r.ok, true);
    assert.ok(r.ok);
    assert.deepEqual(
      { total: r.health.total, enabled: r.health.enabled, ok: r.health.ok, unknown: r.health.unknown, error: r.health.error },
      { total: 4, enabled: 3, ok: 1, unknown: 1, error: 1 },
    );
    assert.equal(r.health.worst, "error");
  });

  // A Companion that accepts the connection and never answers holds the hourly
  // reconcile open. `instanceof AbortSignal` does NOT catch that — it was the
  // first form of this test and it stayed green against
  // `new AbortController().signal`, a signal that never fires. So this waits the
  // real three seconds and pins the constant, the way readCustomVariable's
  // timeout below does, and for the same reason: `mock.timers` cannot drive
  // `AbortSignal.timeout`. `timeout` is on the test because the red state of
  // this guard is a read that never settles.
  test("a Companion that never answers is an error, not a hang", { timeout: 10_000 }, async () => {
    target({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | null | undefined;
        assert.ok(signal instanceof AbortSignal, "the read was sent with no timeout");
        signal.addEventListener("abort", () => reject(signal.reason));
      });

    const started = Date.now();
    const r = await companionApi.readConnections({ force: true });
    const took = Date.now() - started;

    assert.equal(r.ok, false, "a hung read came back as a health summary");
    assert.match(r.ok === false ? r.reason : "", /timeout/i);
    // Not `unsupported`: a Companion that never answers is not an old one, and
    // the unsupported bucket is deliberately silent.
    assert.equal(r.ok === false ? r.unsupported : true, false);
    // The CONSTANT, not just that something aborted eventually. A timeout raised
    // to a minute would still abort, and would still be an hourly sweep held
    // open for a minute.
    assert.ok(
      took >= CONNECTIONS_TIMEOUT_MS - 100 && took < CONNECTIONS_TIMEOUT_MS + 1500,
      `the read took ${took} ms, not about ${CONNECTIONS_TIMEOUT_MS} ms`,
    );
  });

  test("404 is `unsupported`, which is not the same answer as a failure", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stubBoth(() => new Response("Not found", { status: 404 }));

    const r = await companionApi.readConnections({ force: true });
    assert.equal(r.ok, false);
    assert.ok(!r.ok);
    assert.equal(r.unsupported, true);
    assert.match(r.reason, /5\.x and later/);
  });

  test("any other status is a failure, and is NOT unsupported", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stubBoth(() => new Response("nope", { status: 500 }));

    const r = await companionApi.readConnections({ force: true });
    assert.ok(!r.ok);
    assert.equal(r.unsupported, false);
    assert.match(r.reason, /HTTP 500/);
  });

  // NEVER throws: the reconcile calls this on a timer and a rejection out of a
  // housekeeping pass takes the rest of the pass with it.
  test("a network failure comes back as a result, not a throw", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const r = await companionApi.readConnections({ force: true });
    assert.ok(!r.ok);
    assert.equal(r.unsupported, false);
  });

  test("no host configured is a result too", async () => {
    target(null);
    const r = await companionApi.readConnections({ force: true });
    assert.ok(!r.ok);
    assert.match(r.reason, /host is not configured/);
  });

  test("a second read inside the window reuses the first, so one Test is one GET", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stubBoth(() => Response.json(connectionsBody()));

    await companionApi.readConnections();
    await companionApi.readConnections();

    assert.equal(calls.filter((c) => c.url.endsWith("/api/connections")).length, 1);
  });

  // The cached list belongs to the OLD host. invalidate() runs when the
  // Companion host is changed, and a stale count from another box is worse than
  // none.
  test("invalidate drops it", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stubBoth(() => Response.json(connectionsBody()));

    await companionApi.readConnections();
    companionApi.invalidate();
    await companionApi.readConnections();

    assert.equal(calls.filter((c) => c.url.endsWith("/api/connections")).length, 2);
  });

  test("a failure is not cached — the next read asks again", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    let fail = true;
    const calls = stubBoth(() => (fail ? new Response("nope", { status: 500 }) : Response.json(connectionsBody())));

    assert.ok(!(await companionApi.readConnections()).ok);
    fail = false;
    assert.ok((await companionApi.readConnections()).ok);
    assert.equal(calls.filter((c) => c.url.endsWith("/api/connections")).length, 2);
  });
});

describe("readCustomVariable", () => {
  test("reads Companion's value endpoint and trims what comes back", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stub(() => new Response("on\n", { status: 200 }));

    const r = await companionApi.readCustomVariable("projectors_state");
    // The exact URL Companion wants. Everything downstream compares the VALUE,
    // so a trailing newline off a button expression must not read as unknown.
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      ["GET http://10.0.0.5:8000/api/custom-variable/projectors_state/value"],
    );
    assert.deepEqual(r, { value: "on" });
    // The request is TIMED. Without a signal a Companion that accepts the
    // connection and never answers hangs this read, and with it the whole batch
    // the states route is waiting on.
    assert.ok(calls[0]!.signal instanceof AbortSignal, "the read was sent with no timeout");
  });

  test("404 is its own sentence, not \"HTTP 404\"", async () => {
    // The ordinary case when somebody binds a cue before creating the variable.
    target({ host: "10.0.0.5", port: 8000 });
    stub(() => new Response("Not found", { status: 404 }));

    assert.deepEqual(await companionApi.readCustomVariable("nope"), {
      error: "no such custom variable in Companion",
    });
  });

  test("another status comes back as the status", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stub(() => new Response("", { status: 500 }));

    assert.deepEqual(await companionApi.readCustomVariable("projectors_state"), {
      error: "Companion answered HTTP 500",
    });
  });

  test("a network failure is returned, not thrown", async () => {
    // The states route reads every bound pair before it answers; a throw here
    // would be a 500 for one unplugged Companion.
    target({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async () => {
      throw new Error("fetch failed", { cause: new Error("connect ECONNREFUSED 10.0.0.5:8000") });
    };

    assert.deepEqual(await companionApi.readCustomVariable("projectors_state"), {
      error: "connect ECONNREFUSED 10.0.0.5:8000",
    });
  });

  test("a name Companion could not have is refused without a request", async () => {
    // The name is pasted into a URL path. A request that cannot succeed is not
    // sent, so nothing has to be trusted to encode its way out of trouble.
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stub(() => new Response("on", { status: 200 }));

    const r = await companionApi.readCustomVariable("../../int/export/full");
    assert.equal("error" in r && r.error.includes("not a Companion variable name"), true);
    assert.equal(calls.length, 0, "a malformed variable name reached Companion");
  });

  test("no host is a refusal, not a reach", async () => {
    target(null);
    assert.deepEqual(await companionApi.readCustomVariable("projectors_state"), {
      error: "Companion host is not configured",
    });
  });

  test("the value is NEVER cached — it is the thing that changes", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    let value = "on";
    const calls = stub(() => new Response(value, { status: 200 }));

    assert.deepEqual(await companionApi.readCustomVariable("projectors_state"), { value: "on" });
    value = "off";
    assert.deepEqual(await companionApi.readCustomVariable("projectors_state"), { value: "off" });
    assert.equal(calls.length, 2, "a cached value here would freeze every switch in Home Assistant");
  });
});

// ── The host, resolved inside the try ─────────────────────────────────────────
//
// Every one of these FOUR is documented as never throwing, and three of them
// once resolved the base URL BEFORE the try: `baseUrl()` awaits getTarget, which
// reaches the integration manager and its config store. A rejection there
// escaped all three.
//
// It matters most for the variable read, because its caller reads every bound
// pair in one batch — one rejection took out every other pair's state and the
// `GET /api/cues/states` route with it. For `press` it is worse in kind: an
// automation action that throws stops the engine. For readConnections it is the
// hourly reconcile, which now calls it as the last thing it does.
//
// readConnections is the fourth, added with the endpoint rather than after it —
// it shipped carrying the comment that names this exact bug and no case here,
// which is the three-of-four shape this repo pays for over and over.
describe("a getTarget failure", () => {
  const boom = () => {
    companionDeps.getTarget = async () => {
      throw new Error("secrets.bin is unreadable");
    };
  };

  test("readCustomVariable returns it rather than throwing", async () => {
    boom();
    stub(() => new Response("on", { status: 200 }));
    assert.deepEqual(await companionApi.readCustomVariable("projectors_state"), {
      error: "secrets.bin is unreadable",
    });
  });

  test("press returns it rather than throwing", async () => {
    boom();
    stub(() => new Response("ok", { status: 200 }));
    const r = await companionApi.press({ page: 17, row: 2, col: 6 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /secrets\.bin is unreadable/);
  });

  test("fetchExport returns it rather than throwing", async () => {
    boom();
    stub(() => new Response("{}", { status: 200 }));
    const r = await companionApi.fetchExport({ force: true });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /secrets\.bin is unreadable/);
  });

  test("readConnections returns it rather than throwing", async () => {
    boom();
    stub(() => Response.json([]));
    const r = await companionApi.readConnections({ force: true });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /secrets\.bin is unreadable/);
    // NOT `unsupported`. A config store that will not open says nothing about
    // which Companion build is on the other end, and reporting it as "this
    // Companion is too old" would put the row's one honest failure into the
    // bucket that is deliberately silent.
    assert.equal(r.ok === false ? r.unsupported : true, false);
  });
});

// ── The read's timeout ────────────────────────────────────────────────────────
//
// A Companion that accepts the connection and never answers is the failure the
// three-second timeout exists for: `GET /api/cues/states` reads every bound pair
// and answers when the slowest read does, so a read with no ceiling is a Home
// Assistant sensor hanging until its own client gives up.
//
// NO FAKE TIMER, and it is not for want of trying: `AbortSignal.timeout` is not
// driven by node:test's `mock.timers` — enabling the setTimeout mock and
// ticking past 3000 ms leaves the signal unaborted, because the timer lives in
// the runtime rather than in the JS timer queue. Driving it would mean replacing
// `AbortSignal.timeout` with a hand-rolled controller plus clearTimeout at 18
// call sites this codebase deliberately does not do that at (see the comments in
// reaper-service.ts and pvp-service.ts). So this waits the real three seconds
// and pins the constant by elapsed time. `timeout` is set on the test because
// the red state of this guard is a read that never settles.
describe("readCustomVariable's timeout", () => {
  test("a Companion that never answers is an error, not a hang", { timeout: 10_000 }, async () => {
    target({ host: "10.0.0.5", port: 8000 });
    // Never resolves on its own. It rejects with the signal's own reason, which
    // is what a real fetch does when its signal aborts.
    companionDeps.fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | null | undefined;
        assert.ok(signal instanceof AbortSignal, "the read was sent with no timeout");
        signal.addEventListener("abort", () => reject(signal.reason));
      });

    const started = Date.now();
    const r = await companionApi.readCustomVariable("projectors_state");
    const took = Date.now() - started;

    assert.equal("error" in r, true, "a hung read came back as a value");
    assert.match("error" in r ? r.error : "", /timeout/i);
    // The CONSTANT, not just that something aborted eventually: a timeout raised
    // to a minute would still abort, and would still be a sensor Home Assistant
    // gave up on.
    assert.ok(
      took >= VARIABLE_TIMEOUT_MS - 100 && took < VARIABLE_TIMEOUT_MS + 1500,
      `the read took ${took} ms, not about ${VARIABLE_TIMEOUT_MS} ms`,
    );
  });
});

// A binding may name a MODULE variable, not only a custom one.
//
// Companion serves the two at different paths — `/api/custom-variable/<name>`
// and `/api/variable/<label>/<name>` — and both were probed against a real
// Companion 5.0.3: a module variable that exists answers 200 with the value as
// text, one that does not answers 404 "Not found". A binding that dispatched to
// the wrong path would 404 forever with nothing on screen but "unknown".
describe("readVariable dispatches on the form of the binding", () => {
  test("a bare name is a CUSTOM variable, as every binding written before this meant", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stub(() => new Response("on", { status: 200 }));

    assert.deepEqual(await companionApi.readVariable("projectors_state"), { value: "on" });
    assert.deepEqual(
      calls.map((c) => c.url),
      ["http://10.0.0.5:8000/api/custom-variable/projectors_state/value"],
    );
  });

  test("`custom:` says the same thing explicitly", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stub(() => new Response("off", { status: 200 }));

    assert.deepEqual(await companionApi.readVariable("custom:projectors_state"), { value: "off" });
    assert.deepEqual(
      calls.map((c) => c.url),
      ["http://10.0.0.5:8000/api/custom-variable/projectors_state/value"],
    );
  });

  test("`<label>:<name>` reads the module variable endpoint", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stub(() => new Response("On\n", { status: 200 }));

    // The value is trimmed here too: the module endpoint answers text, and a
    // trailing newline matching neither "On" nor "Off" reads as unknown.
    assert.deepEqual(await companionApi.readVariable("VCR-Overhead-Light:power_state"), {
      value: "On",
    });
    assert.deepEqual(
      calls.map((c) => c.url),
      ["http://10.0.0.5:8000/api/variable/VCR-Overhead-Light/power_state/value"],
    );
    assert.equal(calls[0]!.signal instanceof AbortSignal, true, "the read was sent with no timeout");
  });

  test("404 on a module variable names it, rather than reading as HTTP 404", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stub(() => new Response("Not found", { status: 404 }));

    assert.deepEqual(await companionApi.readVariable("VCR-Overhead-Light:power_state"), {
      error: "no such variable VCR-Overhead-Light:power_state in Companion",
    });
  });

  test("a label Companion could not have is refused without a request", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stub(() => new Response("On", { status: 200 }));

    // Both halves land in a URL path, so neither is trusted to encode its way
    // out of trouble.
    const r = await companionApi.readVariable("../../int:power_state");
    assert.equal("error" in r && r.error.includes("not a Companion variable name"), true);
    assert.equal(calls.length, 0, "a malformed connection label reached Companion");
  });

  test("a module read that fails is returned, not thrown", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async () => {
      throw new Error("fetch failed", { cause: new Error("connect ECONNREFUSED 10.0.0.5:8000") });
    };

    assert.deepEqual(await companionApi.readVariable("VCR-Overhead-Light:power_state"), {
      error: "connect ECONNREFUSED 10.0.0.5:8000",
    });
  });
});
