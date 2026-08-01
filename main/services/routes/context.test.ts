import { strict as assert } from "node:assert";
import { test } from "node:test";

import { error, json, readBody, readRawBody } from "./context.js";
import { callRoute } from "./route-harness.js";

// ── The harness itself ─────────────────────────────────────────────────────
// If these fail every route test below is meaningless, so they come first.

test("the harness reports a handler that responded", async () => {
  const out = await callRoute(async ({ res }) => json(res, { ok: true }), "/x");
  assert.equal(out.responded, true);
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { ok: true });
});

test("the harness reports a handler that fell through", async () => {
  // The dispatcher reads headersSent to decide whether to try the next module.
  const out = await callRoute(async () => {}, "/x");
  assert.equal(out.responded, false, "an untouched response must not look handled");
  assert.equal(out.status, null);
});

test("headersSent flips only once the handler writes", async () => {
  await callRoute(async ({ res }) => {
    assert.equal(res.headersSent, false, "not sent before writing");
    json(res, {});
    assert.equal(res.headersSent, true, "sent after writing");
  }, "/x");
});

// ── json / error ───────────────────────────────────────────────────────────

test("json defaults to 200 and declares its content type", async () => {
  const out = await callRoute(async ({ res }) => json(res, { a: 1 }), "/x");
  assert.equal(out.status, 200);
  assert.equal(out.headers["Content-Type"], "application/json");
  assert.deepEqual(out.json, { a: 1 });
});

test("json carries an explicit status", async () => {
  const out = await callRoute(async ({ res }) => json(res, { a: 1 }, 201), "/x");
  assert.equal(out.status, 201);
});

test("error is a 400 by default, shaped { error }", async () => {
  const out = await callRoute(async ({ res }) => error(res, "nope"), "/x");
  assert.equal(out.status, 400);
  assert.deepEqual(out.json, { error: "nope" });
});

test("error carries an explicit status", async () => {
  const out = await callRoute(async ({ res }) => error(res, "gone", 404), "/x");
  assert.equal(out.status, 404);
  assert.deepEqual(out.json, { error: "gone" });
});

test("a null body serialises rather than throwing", async () => {
  const out = await callRoute(async ({ res }) => json(res, null), "/x");
  assert.equal(out.status, 200);
  assert.equal(out.body, "null");
});

// ── readBody ───────────────────────────────────────────────────────────────

test("a JSON body round-trips", async () => {
  const out = await callRoute(
    async ({ req, res }) => json(res, await readBody(req)),
    "/x",
    { method: "POST", body: { name: "display-1", n: 2 } },
  );
  assert.deepEqual(out.json, { name: "display-1", n: 2 });
});

test("an empty body reads as {} rather than throwing", async () => {
  // Routes check `typeof body.x`, so this must be an object, not undefined.
  const out = await callRoute(
    async ({ req, res }) => json(res, await readBody(req)),
    "/x",
    { method: "POST" },
  );
  assert.deepEqual(out.json, {});
});

test("malformed JSON rejects, and does so before any handler logic runs", async () => {
  // The route's own try/catch turns this into a 400; what matters here is that
  // readBody refuses rather than handing back a half-parsed object.
  const out = await callRoute(
    async ({ req, res }) => {
      try {
        await readBody(req);
        json(res, { reached: true });
      } catch (e) {
        error(res, (e as Error).message);
      }
    },
    "/x",
    { method: "POST", raw: "{ not json" },
  );
  assert.equal(out.status, 400);
  assert.match(String((out.json as { error: string }).error), /Invalid JSON/);
});

test("a JSON array body is preserved as an array", async () => {
  const out = await callRoute(
    async ({ req, res }) => json(res, await readBody(req)),
    "/x",
    { method: "POST", body: [1, 2, 3] },
  );
  assert.deepEqual(out.json, [1, 2, 3]);
});

test("a __proto__ payload reaches a route as an own key, without polluting", async () => {
  // Both halves matter, and the second is the surprising one.
  //
  // JSON.parse does not run the __proto__ setter, so Object.prototype is safe —
  // parsing a hostile body cannot itself pollute anything.
  //
  // But the key IS an own property of the result. So any route that forwards a
  // parsed body onward — spreading it, or using its keys to index a map — hands
  // "__proto__" to whatever it calls. That is exactly how POST /api/slots reached
  // slotsStore, and why the guard lives at the store rather than here.
  const out = await callRoute(
    async ({ req, res }) => {
      const body = (await readBody(req)) as Record<string, unknown>;
      json(res, {
        polluted: ({} as Record<string, unknown>).injected ?? null,
        ownKeys: Object.keys(body),
        hasOwnProto: Object.prototype.hasOwnProperty.call(body, "__proto__"),
      });
    },
    "/x",
    { method: "POST", raw: '{"__proto__":{"injected":"yes"},"a":1}' },
  );
  const got = out.json as { polluted: unknown; ownKeys: string[]; hasOwnProto: boolean };
  assert.equal(got.polluted, null, "Object.prototype must be untouched by parsing");
  assert.equal(got.hasOwnProto, true, "but __proto__ does arrive as an own key");
  assert.deepEqual(got.ownKeys.sort(), ["__proto__", "a"]);
});

// ── readRawBody ────────────────────────────────────────────────────────────

test("raw bytes survive unparsed, for uploads", async () => {
  const out = await callRoute(
    async ({ req, res }) => {
      const bytes = await readRawBody(req);
      json(res, { length: bytes.length, first: bytes[0] });
    },
    "/x",
    { method: "POST", raw: "PNG-ish" },
  );
  assert.deepEqual(out.json, { length: 7, first: "P".charCodeAt(0) });
});

test("an empty raw body is a zero-length array, not a throw", async () => {
  const out = await callRoute(
    async ({ req, res }) => json(res, { length: (await readRawBody(req)).length }),
    "/x",
    { method: "POST" },
  );
  assert.deepEqual(out.json, { length: 0 });
});

// ── The context the dispatcher builds ──────────────────────────────────────

test("pathname excludes the query string, and url carries it", async () => {
  const out = await callRoute(
    async ({ pathname, url, res }) => json(res, { pathname, q: url.searchParams.get("token") }),
    "/log?token=abc123",
  );
  assert.deepEqual(out.json, { pathname: "/log", q: "abc123" });
});

test("the method reaches the handler upper-cased", async () => {
  const out = await callRoute(
    async ({ method, res }) => json(res, { method }),
    "/x",
    { method: "post" },
  );
  assert.deepEqual(out.json, { method: "POST" });
});

test("an encoded path segment is not decoded into a new path", async () => {
  // %2F must not become a separator, or a route regex could match a segment the
  // client never actually asked for.
  const out = await callRoute(
    async ({ pathname, res }) => json(res, { pathname }),
    "/api/integrations/a%2Fb/enabled",
  );
  assert.equal((out.json as { pathname: string }).pathname, "/api/integrations/a%2Fb/enabled");
});
