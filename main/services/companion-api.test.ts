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

const { companionApi, companionDeps } = await import("./companion-api.js");
const { AUTOMATION_ACTIONS } = await import("./automation-actions.js");
const { companionExportFixture } = await import("./fixtures/companion-export.js");

const realFetch = companionDeps.fetch;
const realTarget = companionDeps.getTarget;

interface Call {
  url: string;
  method: string;
  body: string;
}

/** Record every request and answer it however the case needs. */
function stub(answer: (url: string) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  companionDeps.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
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
    assert.ok(first.ok && first.buttons.length === 12);

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

describe("testConnection", () => {
  test("reports the Companion build and the button count", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    stub(() => Response.json(companionExportFixture()));

    const r = await companionApi.testConnection();
    assert.equal(r.ok, true);
    assert.match(r.message, /Companion 5\.0\.3/);
    assert.match(r.message, /12 button\(s\)/);
    assert.match(r.message, /4 on\/off pair\(s\)/);
  });

  test("presses nothing", async () => {
    target({ host: "10.0.0.5", port: 8000 });
    const calls = stub(() => Response.json(companionExportFixture()));

    await companionApi.testConnection();
    assert.equal(calls.filter((c) => c.url.includes("/press")).length, 0);
  });

  test("no host is a refusal, not a reach", async () => {
    target(null);
    const r = await companionApi.testConnection();
    assert.equal(r.ok, false);
    assert.match(r.message, /Host is required/);
  });
});
