// headers.test.ts — what every answer says about itself.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PUBLIC_STATIC_FILES } from "../../../main/types/servicecue-publish.js";
import { BASE_HEADERS, STATIC_HEADERS_FILE, SVG_CSP, htmlCsp, json, jsonText, noContent, secured, staticHeaders } from "./headers.js";

describe("the base headers", () => {
  test("are exactly these, sorted", () => {
    assert.deepEqual(
      BASE_HEADERS.map(([name, value]) => `${name}: ${value}`),
      [
        "Referrer-Policy: no-referrer",
        "Strict-Transport-Security: max-age=15552000; includeSubDomains",
        "X-Content-Type-Options: nosniff",
        "X-Robots-Tag: noindex",
      ],
    );
  });

  test("secured puts them on a response, keeping its status, body and own headers", async () => {
    const original = new Response("hello", { status: 202, headers: { "Content-Type": "text/plain", "X-Own": "1" } });
    const out = secured(original);
    assert.equal(out.status, 202);
    assert.equal(await out.text(), "hello");
    assert.equal(out.headers.get("content-type"), "text/plain");
    assert.equal(out.headers.get("x-own"), "1");
    for (const [name, value] of BASE_HEADERS) assert.equal(out.headers.get(name), value, name);
  });

  test("secured overrides a value the route set differently", () => {
    const out = secured(new Response(null, { headers: { "X-Robots-Tag": "all", "Referrer-Policy": "unsafe-url" } }));
    assert.equal(out.headers.get("x-robots-tag"), "noindex");
    assert.equal(out.headers.get("referrer-policy"), "no-referrer");
  });

  test("secured works on a response whose own headers cannot be changed", () => {
    const immutable = Response.redirect("https://x.example/", 302);
    assert.throws(() => immutable.headers.set("X-Test", "1"), "the fixture is supposed to have immutable headers");
    assert.equal(secured(immutable).headers.get("x-content-type-options"), "nosniff");
  });

  test("the answers the Worker builds itself carry the right type and are never cached", () => {
    const answer = json({ a: 1 }, 404, { Allow: "GET" });
    assert.equal(answer.status, 404);
    assert.equal(answer.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(answer.headers.get("cache-control"), "no-store");
    assert.equal(answer.headers.get("allow"), "GET");
    const none = noContent();
    assert.equal(none.status, 204);
    assert.equal(none.headers.get("cache-control"), "no-store");
  });

  test("a JSON answer made of text already is that text, not a second encoding of it", async () => {
    const text = '{"a" :  1}';
    const answer = jsonText(text);
    assert.equal(await answer.text(), text);
    assert.equal(answer.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(await json({ a: 1 }).text(), '{"a":1}');
  });
});

describe("the static files' headers", () => {
  /** The file as the asset service reads it: a path, then its indented headers, rules apart by a blank line. */
  const rules = staticHeaders()
    .trim()
    .split("\n\n")
    .map((rule) => {
      const [path, ...lines] = rule.split("\n");
      return { path: path!, headers: lines.map((l) => l.replace(/^ {2}/, "")) };
    });

  test("is named what the asset service looks for", () => {
    assert.equal(STATIC_HEADERS_FILE, "_headers");
  });

  test("has one rule for the hashed files under /assets and one for each file the build writes beside the page, and no other", () => {
    assert.deepEqual(
      rules.map((r) => r.path),
      ["/assets/*", ...PUBLIC_STATIC_FILES],
    );
  });

  test("says what the Worker says on its own answers, and each kind's caching", () => {
    const base = BASE_HEADERS.map(([name, value]) => `${name}: ${value}`);
    for (const rule of rules) {
      const cache = rule.path === "/assets/*" ? "public, max-age=31536000, immutable" : "no-cache";
      assert.deepEqual(rule.headers, [`Cache-Control: ${cache}`, ...base], rule.path);
    }
  });

  test("is exactly this text, one rule to a paragraph", () => {
    assert.equal(
      staticHeaders().split("\n\n")[0],
      [
        "/assets/*",
        "  Cache-Control: public, max-age=31536000, immutable",
        "  Referrer-Policy: no-referrer",
        "  Strict-Transport-Security: max-age=15552000; includeSubDomains",
        "  X-Content-Type-Options: nosniff",
        "  X-Robots-Tag: noindex",
      ].join("\n"),
    );
    assert.ok(staticHeaders().endsWith("\n"));
  });
});

describe("the viewer's content security policy", () => {
  test("is exactly these directives, with the socket named for the host it is served from", () => {
    assert.equal(
      htmlCsp(new URL("https://servicecue.example.workers.dev/servicecue")),
      [
        "default-src 'self'",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self' wss://servicecue.example.workers.dev",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join("; "),
    );
  });

  test("names a plain ws: socket for a page served over http, port included", () => {
    assert.match(htmlCsp(new URL("http://127.0.0.1:8811/servicecue")), /connect-src 'self' ws:\/\/127\.0\.0\.1:8811;/);
  });

  test("allows no script but the page's own files, and no inline script at all", () => {
    const csp = htmlCsp(new URL("https://x.example/servicecue"));
    assert.doesNotMatch(csp, /script-src/, "script-src falls back to default-src 'self'");
    assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline.*script|script.*unsafe-inline/);
    assert.match(csp, /(^|; )default-src 'self'(;|$)/);
  });

  test("an SVG is sandboxed with nothing allowed", () => {
    assert.equal(SVG_CSP, "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  });
});
