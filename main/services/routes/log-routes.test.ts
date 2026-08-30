// The token gate on /log, /logs and /api/log, driven through the real handler.
//
// /logs is an ALIAS. An alias that renders the page without the check the
// canonical path enforces is an unauthenticated log viewer on a public-repo
// appliance, and it is precisely the kind of thing that reads correct in a diff
// — the two paths are three lines apart — so it is tested by running it.
//
// route-harness gives the real logRoutes a fake socket, so these are the bytes a
// client gets, not a description of them.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

// The route pulls in the integration manager, which resolves the data directory
// at import. Point it somewhere disposable BEFORE that happens — never at the
// operator's real ~/.stage-utility.
process.env.STAGE_UTILITY_DATA = await fsp.mkdtemp(path.join(os.tmpdir(), "log-routes-"));

const { logRoutes } = await import("./log-routes.js");
const { LOG_PAGE_PATHS, CANONICAL_LOG_PATH } = await import("./log-paths.js");
const { callRoute } = await import("./route-harness.js");
const { addLogLine } = await import("../log-buffer.js");

const TOKEN = "gate-token-for-the-test";

afterEach(() => {
  delete process.env.STAGE_UTILITY_LOG_TOKEN;
});

describe("with no token configured the log is LAN-open, as it always has been", () => {
  test("every log path answers", async () => {
    for (const p of LOG_PAGE_PATHS) {
      const r = await callRoute(logRoutes, p);
      assert.ok(r.status === 200 || r.status === 302, `${p} answered ${r.status}`);
    }
    assert.equal((await callRoute(logRoutes, "/api/log")).status, 200);
  });
});

describe("the token gate applies identically to every log path", () => {
  test("no token, or the wrong one, is 401 on ALL of them", async () => {
    process.env.STAGE_UTILITY_LOG_TOKEN = TOKEN;
    // Built from LOG_PAGE_PATHS, not written out: a third spelling added later is
    // covered the moment it is routed, which is the only way this stays true.
    for (const p of [...LOG_PAGE_PATHS, "/api/log"]) {
      assert.equal((await callRoute(logRoutes, p)).status, 401, `${p} with no token`);
      assert.equal(
        (await callRoute(logRoutes, `${p}?token=wrong`)).status,
        401,
        `${p} with the wrong token`,
      );
    }
  });

  test("the right token opens all of them", async () => {
    process.env.STAGE_UTILITY_LOG_TOKEN = TOKEN;
    for (const p of LOG_PAGE_PATHS) {
      const r = await callRoute(logRoutes, `${p}?token=${TOKEN}`);
      assert.ok(r.status === 200 || r.status === 302, `${p} answered ${r.status}`);
    }
    assert.equal((await callRoute(logRoutes, `/api/log?token=${TOKEN}`)).status, 200);
  });

  test("the 401 on the alias is a 401, not a redirect into one", async () => {
    // The gate runs BEFORE the redirect. Answering an unauthorised /logs with a
    // 302 would be indistinguishable, from outside, from an alias that skips the
    // check — and a client that does not follow redirects would read it as open.
    process.env.STAGE_UTILITY_LOG_TOKEN = TOKEN;
    const r = await callRoute(logRoutes, "/logs");
    assert.equal(r.status, 401);
    assert.equal(r.headers.Location, undefined, "an unauthorised alias must not hand out a Location");
  });
});

describe("/logs is an alias for /log", () => {
  test("it redirects to the canonical path", async () => {
    const r = await callRoute(logRoutes, "/logs");
    assert.equal(r.status, 302);
    assert.equal(r.headers.Location, CANONICAL_LOG_PATH);
  });

  test("the redirect keeps the query string, token and all", async () => {
    // Dropping it turns a working /logs?token=… into a 401 on /log, which reads
    // as a bad token rather than as a broken redirect.
    process.env.STAGE_UTILITY_LOG_TOKEN = TOKEN;
    const r = await callRoute(logRoutes, `/logs?token=${TOKEN}&filter=pco`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.Location, `/log?token=${TOKEN}&filter=pco`);
  });

  test("the canonical path serves the page rather than redirecting to itself", async () => {
    const r = await callRoute(logRoutes, CANONICAL_LOG_PATH);
    assert.equal(r.status, 200);
    assert.match(r.headers["Content-Type"], /text\/html/);
    assert.match(r.body, /Server log/);
  });
});

describe("every path this module serves is reserved against display slugs", () => {
  test("a slug matching a log path is refused", async () => {
    // Both halves run for real: the route is called to prove the path IS served,
    // and the validator is called to prove the slug IS refused. A display slugged
    // "logs" would resolve to the redirect and never render — the failure mode
    // that put OPERATOR_PATHS behind a derived list in the first place.
    const { validateSlug } = await import("../reserved-slugs.js");
    for (const p of LOG_PAGE_PATHS) {
      const served = await callRoute(logRoutes, p);
      assert.ok(
        served.status === 200 || served.status === 302,
        `${p} is not served, so this test is asserting nothing`,
      );
      const slug = p.replace(/^\//, "");
      assert.equal(
        validateSlug(slug, []).ok,
        false,
        `the server serves "${p}" but a display may still be slugged "${slug}"`,
      );
    }
  });
});

describe("/api/log", () => {
  test("carries the health checks alongside the lines", async () => {
    const r = await callRoute(logRoutes, "/api/log");
    const body = r.json as { lines: unknown[]; reset: boolean; latestSeq: number; checks: Record<string, unknown> };
    assert.ok(Array.isArray(body.lines));
    assert.equal(body.reset, true, "no cursor means replace");
    assert.ok(body.checks, "the page's health strip has nothing to draw without this");
    assert.equal(typeof body.checks.version, "string");
    assert.equal(typeof body.checks.timeZone, "string");
    assert.ok(Array.isArray(body.checks.integrations));
  });

  test("?since= returns only newer lines", async () => {
    const first = (await callRoute(logRoutes, "/api/log")).json as { latestSeq: number };
    addLogLine("log", "[log-routes-test] a line after the cursor");
    const next = (await callRoute(logRoutes, `/api/log?since=${first.latestSeq}`)).json as {
      lines: { msg: string }[];
      reset: boolean;
    };
    assert.equal(next.reset, false);
    assert.deepEqual(
      next.lines.map((l) => l.msg),
      ["[log-routes-test] a line after the cursor"],
    );
  });

  test("an empty or unparseable ?since= falls back to the whole buffer", async () => {
    // The page sends since= with nothing after it on its very first load.
    for (const q of ["?since=", "?since=banana"]) {
      const body = (await callRoute(logRoutes, `/api/log${q}`)).json as { reset: boolean };
      assert.equal(body.reset, true, `${q} must not be trusted as a position`);
    }
  });
});
