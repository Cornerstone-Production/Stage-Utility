// A stored credential reaches the network through ONE fetch per integration, and
// that fetch can only reach the integration's own origin.
//
// Three guards, each aimed at a different way that stops being true:
//
//   1. TYPE. Each helper takes a branded URL, so a plain string does not compile.
//      The `@ts-expect-error` lines below are checked by `npm run type-check`
//      (this file is in tsconfig's include): remove a brand and the line stops
//      being an error, which is itself a compile error.
//
//   2. RUNTIME. A URL that went round the brand by a cast is sent to the pinned
//      origin with the same path and query, and the request that would have moved
//      is logged on the integration's tag. Run through the real helpers with
//      globalThis.fetch stubbed.
//
//   3. ONE FETCH PER FILE. The TypeScript parser lists every call to `fetch` in the
//      credentialed services and the list is compared with an exact one. A
//      second raw fetch in any of them (a second door that skips the pin) changes
//      the list. Parsed, not grepped: a comment that says `fetch(` is not a call.
//
// The addresses are documentation ranges (RFC 5737). The space id is invented.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { pinToOrigin } from "./pinned-origin.js";
import { pvpFetch, pvpOrigin, pvpService, pvpUrl, type PvpOrigin, type PvpTarget, type PvpUrl } from "./pvp-service.js";
import { cloudflareFetch, cloudflareOrigin, cloudflareUrl, type CloudflareOrigin, type CloudflareUrl } from "./servicecue-cloudflare.js";
import { publishFetch, publishUrl, type PublishUrl } from "./servicecue-publish-client.js";
import { parsePublishUrl, type PublishOrigin } from "./servicecue-publish-rules.js";
import { safeSpaceFetch, safeSpaceUrl, type SafeSpaceUrl } from "./safespace-client.js";
import {
  senSourceApiUrl, senSourceAuthFetch, senSourceAuthUrl, veaFetch,
  type SenSourceApiUrl, type SenSourceAuthUrl,
} from "./sensource-service.js";

const realFetch = globalThis.fetch;

interface Sent {
  url: string;
  init: RequestInit | undefined;
}
let sent: Sent[] = [];
let errors: string[] = [];

beforeEach(() => {
  sent = [];
  errors = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  mock.method(console, "error", (line: unknown) => {
    errors.push(String(line));
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restoreAll();
});

// ── 1. The brand ────────────────────────────────────────────────────────────

// Never called: the lines exist to be compiled. A closure rather than top-level
// statements so that a stub-less run cannot send a request.
const typeLevel = (): void => {
  // @ts-expect-error a plain string is not a SenSourceApiUrl
  void veaFetch("https://vea.sensourceinc.com/api/data/space", {});
  // @ts-expect-error a plain string is not a SenSourceAuthUrl
  void senSourceAuthFetch("https://auth.sensourceinc.com/oauth/token", {});
  // @ts-expect-error a plain string is not a SafeSpaceUrl
  void safeSpaceFetch("https://app.safespace.io/api/raw-data/live-occupancy/x", {});
  // @ts-expect-error a plain string is not a PvpUrl
  void pvpFetch("http://192.0.2.10:8080" as PvpOrigin, "http://192.0.2.10:8080/api/0/x", {});
  // @ts-expect-error a plain string is not a PvpOrigin
  void pvpFetch("http://192.0.2.10:8080", "http://192.0.2.10:8080/api/0/x" as PvpUrl, {});
  // @ts-expect-error a plain string is not a PublishUrl
  void publishFetch("https://page.example" as PublishOrigin, "https://page.example/_publish/v1/status", {});
  // @ts-expect-error a plain string is not a PublishOrigin
  void publishFetch("https://page.example", "https://page.example/_publish/v1/status" as PublishUrl, {});
  // @ts-expect-error a plain string is not a CloudflareUrl
  void cloudflareFetch(cloudflareOrigin(), "https://api.cloudflare.com/client/v4/user/tokens/verify", {});
  // @ts-expect-error a plain string is not a CloudflareOrigin
  void cloudflareFetch("https://api.cloudflare.com", "https://api.cloudflare.com/client/v4/user/tokens/verify" as CloudflareUrl, {});
  // The two SenSource brands are not interchangeable: the token must not be able
  // to go to the auth host, nor the client secret to the API host.
  // @ts-expect-error an API URL is not an auth URL
  void senSourceAuthFetch(senSourceApiUrl("/x"), {});
  // @ts-expect-error an auth URL is not an API URL
  void veaFetch(senSourceAuthUrl(), {});
};

// ── 2. The pin ──────────────────────────────────────────────────────────────

it("the type-level cases are compiled, not run", () => {
  // Keeps `typeLevel` referenced. Its value is that tsc checks every line in it.
  assert.equal(typeof typeLevel, "function");
});

describe("pinToOrigin", () => {
  it("keeps the path and query and replaces the origin", () => {
    assert.equal(
      pinToOrigin("https://vendor.example", "https://evil.example/a/b?x=1&y=2", "t"),
      "https://vendor.example/a/b?x=1&y=2",
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^\[t\] BUG: .*evil\.example.*vendor\.example/);
  });

  it("does not treat a leading // in the path as a new authority", () => {
    // The bug `new URL(path, origin)` has: this candidate's origin IS the vendor's,
    // and the two-argument constructor would rebuild it on evil.example.
    const out = pinToOrigin("https://vendor.example", "https://vendor.example//evil.example/x", "t");
    assert.equal(new URL(out).origin, "https://vendor.example");
    assert.equal(new URL(out).pathname, "//evil.example/x");
    assert.deepEqual(errors, []);
  });

  it("drops credentials written into the URL, and says so", () => {
    const out = pinToOrigin("https://vendor.example", "https://user:pw@vendor.example/x", "t");
    assert.equal(out, "https://vendor.example/x");
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0], /pw/);
  });

  it("refuses a URL it cannot parse rather than sending something", () => {
    assert.throws(() => pinToOrigin("https://vendor.example", "not a url", "t"), /\[t\] a request URL could not be parsed/);
  });

  it("is silent for a URL already on the origin", () => {
    assert.equal(pinToOrigin("https://vendor.example", "https://vendor.example/a?b=c", "t"), "https://vendor.example/a?b=c");
    assert.deepEqual(errors, []);
  });
});

describe("SenSource", () => {
  it("sends the API URL the code builds unchanged, without a log line", async () => {
    await veaFetch(senSourceApiUrl("/data/space?from=1&to=2"), { headers: { Authorization: "Bearer t" } });
    assert.equal(sent[0].url, "https://vea.sensourceinc.com/api/data/space?from=1&to=2");
    assert.deepEqual(sent[0].init, { headers: { Authorization: "Bearer t" } });
    assert.deepEqual(errors, []);
  });

  it("sends the token request to the auth host unchanged", async () => {
    await senSourceAuthFetch(senSourceAuthUrl(), { method: "POST", body: "{}" });
    assert.equal(sent[0].url, "https://auth.sensourceinc.com/oauth/token");
    assert.deepEqual(errors, []);
  });

  it("pins a forged API URL to the Vea API host, keeping path and query", async () => {
    await veaFetch("https://evil.example/data/space?from=1" as unknown as SenSourceApiUrl, {});
    assert.equal(sent[0].url, "https://vea.sensourceinc.com/data/space?from=1");
    assert.match(errors[0], /^\[sensource\] BUG/);
  });

  it("pins a forged auth URL to the auth host, keeping path and query", async () => {
    await senSourceAuthFetch("https://evil.example/oauth/token?x=1" as unknown as SenSourceAuthUrl, { method: "POST" });
    assert.equal(sent[0].url, "https://auth.sensourceinc.com/oauth/token?x=1");
    assert.match(errors[0], /^\[sensource\] BUG/);
  });

  it("does not let a path starting // move the bearer token", async () => {
    await veaFetch(senSourceApiUrl("//evil.example/x"), {});
    assert.equal(new URL(sent[0].url).origin, "https://vea.sensourceinc.com");
  });
});

describe("SafeSpace", () => {
  const SPACE = "invented-space-id-0001";

  it("sends the URL the code builds unchanged, without a log line", async () => {
    await safeSpaceFetch(safeSpaceUrl(SPACE), {});
    assert.equal(sent[0].url, `https://app.safespace.io/api/raw-data/live-occupancy/${SPACE}`);
    assert.deepEqual(errors, []);
  });

  it("keeps an id with a slash, a query or an @ inside its one path segment", async () => {
    for (const id of ["a/../b", "a?b=c", "a@evil.example", "//evil.example", "a#b"]) {
      sent = [];
      await safeSpaceFetch(safeSpaceUrl(id), {});
      const u = new URL(sent[0].url);
      assert.equal(u.origin, "https://app.safespace.io", id);
      assert.equal(u.search, "", id);
      assert.equal(u.pathname, `/api/raw-data/live-occupancy/${encodeURIComponent(id)}`, id);
    }
  });

  it("pins a forged URL to app.safespace.io, and keeps the id out of the log", async () => {
    await safeSpaceFetch(`https://evil.example/api/raw-data/live-occupancy/${SPACE}` as unknown as SafeSpaceUrl, {});
    assert.equal(sent[0].url, `https://app.safespace.io/api/raw-data/live-occupancy/${SPACE}`);
    assert.match(errors[0], /^\[safespace\] BUG/);
    assert.doesNotMatch(errors[0], new RegExp(SPACE));
  });
});

describe("ProVideoPlayer", () => {
  const T: PvpTarget = { host: "192.0.2.10", port: 8080, https: false, token: "tok" };

  it("builds the origin from host and port, with the scheme's default port dropped", () => {
    assert.equal(pvpOrigin(T), "http://192.0.2.10:8080");
    assert.equal(pvpOrigin({ ...T, port: 80 }), "http://192.0.2.10");
    assert.equal(pvpOrigin({ ...T, https: true, port: 443 }), "https://192.0.2.10");
    assert.equal(pvpOrigin({ ...T, host: "pvp.local" }), "http://pvp.local:8080");
  });

  it("refuses a host that is not a bare host", () => {
    for (const host of ["192.0.2.10/x", "evil.example#", "evil.example?x=1", "u@evil.example", "evil.example\\x", "a b", "evil.example:99", ""]) {
      assert.throws(() => pvpOrigin({ ...T, host }), /ProVideoPlayer host/, JSON.stringify(host));
    }
  });

  it("sends the URL the code builds unchanged, without a log line", async () => {
    const o = pvpOrigin(T);
    await pvpFetch(o, pvpUrl(o, "/transportState/workspace"), { method: "GET" });
    assert.equal(sent[0].url, "http://192.0.2.10:8080/api/0/transportState/workspace");
    assert.deepEqual(errors, []);
  });

  it("pins a forged URL to the configured origin, keeping path and query", async () => {
    const o = pvpOrigin(T);
    await pvpFetch(o, "http://evil.example/api/0/x?y=1" as unknown as PvpUrl, {});
    assert.equal(sent[0].url, "http://192.0.2.10:8080/api/0/x?y=1");
    assert.match(errors[0], /^\[pvp\] BUG/);
  });

  it("keeps a path starting // or holding @ on the configured host", async () => {
    const o = pvpOrigin(T);
    for (const p of ["//evil.example/api", "@evil.example/api", "\\\\evil.example\\api", "/x#@evil.example"]) {
      sent = [];
      await pvpFetch(o, pvpUrl(o, p), {});
      assert.equal(new URL(sent[0].url).origin, "http://192.0.2.10:8080", p);
    }
    // And even a URL that was forged with such a path, which skips pvpUrl.
    sent = [];
    await pvpFetch(o, "http://192.0.2.10:8080//evil.example/api" as unknown as PvpUrl, {});
    assert.equal(new URL(sent[0].url).origin, "http://192.0.2.10:8080");
    assert.equal(new URL(sent[0].url).pathname, "//evil.example/api");
  });

  it("pins a forged ServiceCue publishing URL to the page's origin, so the publishing token cannot leave for another host", async () => {
    const parsed = parsePublishUrl("https://page.example");
    assert.ok(parsed.ok);
    const origin = parsed.origin;
    await publishFetch(origin, publishUrl(origin, "/_publish/v1/status"), {});
    assert.equal(sent[0].url, "https://page.example/_publish/v1/status");
    assert.deepEqual(errors, []);
    sent = [];
    await publishFetch(origin, "https://evil.example/_publish/v1/status?x=1" as unknown as PublishUrl, {});
    assert.equal(sent[0].url, "https://page.example/_publish/v1/status?x=1");
    assert.match(errors[0], /^\[publish\] BUG/);
    sent = [];
    await publishFetch(origin, publishUrl(origin, "//evil.example/x"), {});
    assert.equal(new URL(sent[0].url).origin, "https://page.example");
  });

  it("pins a forged Cloudflare URL to the API's origin, so the API token cannot leave for another host", async () => {
    const origin: CloudflareOrigin = cloudflareOrigin();
    await cloudflareFetch(origin, cloudflareUrl(origin, "/user/tokens/verify"), {});
    assert.equal(sent[0].url, "https://api.cloudflare.com/client/v4/user/tokens/verify");
    assert.deepEqual(errors, []);
    sent = [];
    await cloudflareFetch(origin, "https://evil.example/client/v4/user/tokens/verify?x=1" as unknown as CloudflareUrl, {});
    assert.equal(sent[0].url, "https://api.cloudflare.com/client/v4/user/tokens/verify?x=1");
    assert.match(errors[0], /^\[servicecue-deploy\] BUG/);
    sent = [];
    await cloudflareFetch(origin, cloudflareUrl(origin, "//evil.example/x"), {});
    assert.equal(new URL(sent[0].url).origin, "https://api.cloudflare.com");
  });

  it("sends nothing, with the token, when the configured host is not a bare host", async () => {
    // Through the real service entry the Test connection button uses.
    const out = await pvpService.test("evil.example/x#", 8080, false, "tok");
    assert.equal(out.ok, false);
    assert.deepEqual(sent, []);
  });

  it("test() reaches the configured host with the token as a bearer header", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), init });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await pvpService.test("192.0.2.10", 8080, false, "tok");
    assert.equal(sent[0].url, "http://192.0.2.10:8080/api/0/transportState/workspace");
    assert.deepEqual(sent[0].init?.headers, { Authorization: "Bearer tok" });
  });
});

// ── 3. One fetch per file ───────────────────────────────────────────────────

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The nearest enclosing function's name: a declaration, a method, or the variable
 *  or property an arrow or function expression is assigned to. */
function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
    if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
      const p = n.parent;
      if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) return p.name.getText();
    }
  }
  return "<module>";
}

/** Every call to `fetch` or `globalThis.fetch` in `text`, as `<file>:<function>`. */
function fetchCallsIn(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const c = node.expression;
      const isFetch =
        (ts.isIdentifier(c) && c.text === "fetch") ||
        (ts.isPropertyAccessExpression(c) && c.name.text === "fetch" && ts.isIdentifier(c.expression) && c.expression.text === "globalThis");
      if (isFetch) out.push(`${file}:${enclosingName(node)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const fetchCalls = (file: string): string[] => fetchCallsIn(file, readFileSync(path.join(REPO, file), "utf8"));

const CREDENTIALED = [
  "main/services/pco-service.ts",
  "main/services/pvp-service.ts",
  "main/services/safespace-client.ts",
  "main/services/sensource-service.ts",
  "main/services/servicecue-cloudflare.ts",
  "main/services/servicecue-publish-client.ts",
];

// One entry per line, sorted: two branches adding different entries merge without
// a conflict, and an add plus a remove is not the same as no change.
const EXPECTED = `
main/services/pco-service.ts:pcoFetch
main/services/pvp-service.ts:pvpFetch
main/services/safespace-client.ts:safeSpaceFetch
main/services/sensource-service.ts:senSourceAuthFetch
main/services/sensource-service.ts:veaFetch
main/services/servicecue-cloudflare.ts:cloudflareFetch
main/services/servicecue-publish-client.ts:publishFetch
`.trim().split("\n");

describe("the credentialed fetches", () => {
  it("are exactly the pinned helpers, one per vendor origin", () => {
    const found = CREDENTIALED.flatMap(fetchCalls).sort();
    assert.deepEqual(found, EXPECTED);
  });

  it("the scan sees a call in every shape it claims to", () => {
    // The scan over these files proves nothing if it cannot see a call, so it
    // is run on source that has each shape and one that only mentions fetch.
    const shapes = `
      export function a() { return fetch("x"); }
      export const b = async () => globalThis.fetch("x");
      class C { async m() { return await fetch("x"); } }
      // fetch("in a comment")
      const s = 'fetch("in a string")';
      const notACall = fetch;
    `;
    const names = fetchCallsIn("shapes.ts", shapes).map((e) => e.split(":")[1]);
    assert.deepEqual(names.sort(), ["a", "b", "m"]);
  });
});
