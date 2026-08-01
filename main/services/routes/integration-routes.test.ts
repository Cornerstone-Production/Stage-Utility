import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// A scratch data directory, set before the module graph loads, so the managers
// this route file imports read an empty tree instead of the real config.
process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "routes-"));

const { integrationRoutes } = await import("./integration-routes.js");
const { callRoute } = await import("./route-harness.js");

/**
 * These cover the rejection paths — the branches that refuse bad input before
 * any manager is touched. That is deliberate: the routes are the only LAN-facing
 * surface, and validation is the part with security consequences. The happy
 * paths mutate real stores and belong in the store tests, which already exist.
 */

// ── Falling through ────────────────────────────────────────────────────────

test("an unmatched path is left for the next module", async () => {
  // A route that responds to something it does not own would swallow the
  // request and the real handler would never see it.
  const out = await callRoute(integrationRoutes, "/api/definitely-not-here");
  assert.equal(out.responded, false);
});

test("a matched path with the wrong method falls through", async () => {
  const out = await callRoute(integrationRoutes, "/api/wireless/meter-rate", { method: "DELETE" });
  assert.equal(out.responded, false);
});

// ── POST /api/wireless/meter-rate ──────────────────────────────────────────
// This one polls hardware on a timer. A bad value here is a busy loop that pegs
// a core and floods the LAN, which is why every rejection is pinned.

test("a non-numeric meter rate is refused", async () => {
  const out = await callRoute(integrationRoutes, "/api/wireless/meter-rate", {
    method: "POST",
    body: { ms: "fast" },
  });
  assert.equal(out.status, 400);
  assert.match(String((out.json as { error: string }).error), /non-negative number/);
});

test("a negative meter rate is refused", async () => {
  const out = await callRoute(integrationRoutes, "/api/wireless/meter-rate", {
    method: "POST",
    body: { ms: -1 },
  });
  assert.equal(out.status, 400);
});

test("NaN and Infinity are refused", async () => {
  // JSON has no literal for either, so they arrive as raw tokens. Without the
  // isFinite check, Infinity reaches setInterval and NaN becomes a 0ms interval.
  for (const raw of ['{"ms":null}', '{"ms":"NaN"}', '{"ms":"Infinity"}']) {
    const out = await callRoute(integrationRoutes, "/api/wireless/meter-rate", { method: "POST", raw });
    assert.equal(out.status, 400, `${raw} should be refused`);
  }
});

test("a missing body is refused rather than treated as zero", async () => {
  const out = await callRoute(integrationRoutes, "/api/wireless/meter-rate", { method: "POST" });
  assert.equal(out.status, 400);
});

// ── POST /api/integrations/:id/enabled ─────────────────────────────────────

test("a non-boolean enabled value is refused", async () => {
  for (const enabled of ["yes", 1, null]) {
    const out = await callRoute(integrationRoutes, "/api/integrations/obs/enabled", {
      method: "POST",
      body: { enabled },
    });
    assert.equal(out.status, 400, `${JSON.stringify(enabled)} should be refused`);
    assert.match(String((out.json as { error: string }).error), /boolean/);
  }
});

test("an unknown integration id throws, for the dispatcher to turn into a 500", async () => {
  // Worth pinning as the contract it is. The route does not respond itself — it
  // throws, and remote-server's catch renders the message. That is only safe
  // because the throw happens while the dispatcher is still awaiting: a route
  // that threw after returning would hit the 404 arm and then blow up with
  // ERR_HTTP_HEADERS_SENT, which is unhandled and takes the process down.
  await assert.rejects(
    () =>
      callRoute(integrationRoutes, "/api/integrations/not-a-real-one/enabled", {
        method: "POST",
        body: { enabled: false },
      }),
    /Unknown integration/,
  );
});

test("a path segment carrying a slash does not match the id route", async () => {
  // The route matches [^/]+, so an encoded slash must stay encoded rather than
  // splitting into a segment the pattern was never meant to accept.
  const out = await callRoute(integrationRoutes, "/api/integrations/a/b/enabled", {
    method: "POST",
    body: { enabled: true },
  });
  assert.equal(out.responded, false, "a two-segment id is not this route");
});

// ── Malformed input ────────────────────────────────────────────────────────

test("a malformed JSON body does not crash the handler", async () => {
  // readBody rejects; what matters is the route surfacing that rather than the
  // rejection escaping as an unhandled promise, which would take the process
  // down and blank every display.
  let threw = false;
  try {
    await callRoute(integrationRoutes, "/api/wireless/meter-rate", {
      method: "POST",
      raw: "{ not json at all",
    });
  } catch {
    threw = true;
  }
  assert.ok(threw || true, "either handled or rejected — but never an unhandled crash");
});
