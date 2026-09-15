// The Services API version pin.
//
// PCO resolves a request's API version from the `X-PCO-API-Version` header and,
// when there is no header, from a per-app default configured in a web console
// this repository cannot see. This client sent no header at all, so the version
// it was served was a property of one org's console rather than of the code, and
// a PCO deprecation would land without a line of code changing.
//
// These drive the REAL client with a stubbed fetch rather than reading the
// source: a source scan is satisfied by the constant existing, and the bug this
// guards is a fetch site that does not use it. All THREE fetch sites are
// exercised, because "fixed in one of three copies" is the failure mode this
// repository keeps repeating.

import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";

import { CALENDAR_API_VERSION, CALENDAR_API_VERSIONS } from "./pco-calendar-service.js";
import { PCO_API_VERSION, SERVICES_API_VERSIONS, pcoService, resolvePcoApiVersion } from "./pco-service.js";

/** The pinned version, restated here so a bump has to be deliberate in two places. */
const EXPECTED_VERSION = "2018-11-01";

interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

let seen: SeenRequest[] = [];
const realFetch = globalThis.fetch;

/** A fetch that records the request and replays `body` as a JSON:API response. */
function stubFetch(body: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url: String(input), method: init?.method ?? "GET", headers: { ...headers } });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;
}

describe("X-PCO-API-Version", () => {
  beforeEach(() => {
    seen = [];
    pcoService.clearCache();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    pcoService.clearCache();
  });

  test("a GET carries the pinned version", async () => {
    stubFetch({ data: [], included: [] });
    await pcoService.listTeamMembers("app-id", "secret", "st", "plan");

    assert.equal(seen.length, 1, "expected exactly one request");
    assert.equal(seen[0].headers["X-PCO-API-Version"], EXPECTED_VERSION);
  });

  test("the Live control POST carries the pinned version", async () => {
    stubFetch({ data: { id: "live-1", type: "Live", attributes: {}, links: {} } });
    await pcoService.controlLive("app-id", "secret", "st", "plan", "next");

    // A GET to resolve the Live session, then the POST that drives it.
    assert.equal(seen.length, 2, `expected a GET then a POST, got ${seen.length}`);
    assert.equal(seen[1].method, "POST");
    for (const req of seen) {
      assert.equal(
        req.headers["X-PCO-API-Version"],
        EXPECTED_VERSION,
        `${req.method} ${req.url} was sent without the version header`,
      );
    }
  });

  test("the attachment-open POST carries the pinned version", async () => {
    stubFetch({
      data: { id: "a1", type: "Attachment", attributes: { attachment_url: "https://example.invalid/f.pdf" } },
    });
    await pcoService.openAttachment("app-id", "secret", "st", "plan", "a1");

    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].headers["X-PCO-API-Version"], EXPECTED_VERSION);
  });

  test("a call to ANOTHER PCO product sends the version IT asked for", async () => {
    // Not the Services pin. PCO versions each product on its own date line, so
    // the Calendar client states its own — and the header it states has to
    // survive the whole way to the wire.
    //
    // Written because it nearly did not. Merging the multiview work onto this
    // branch replaced the one fetch site with the shared `pcoFetch`, which built
    // the headers from PCO_API_VERSION alone; `apiVersion` was still threaded
    // from requestProduct down to requestInner and then quietly discarded. It
    // compiled, every other test here stayed green, and the Calendar client
    // would have been served whatever the app's console default happens to be.
    // Drop the `apiVersion` argument from the pcoFetch call in requestInner and
    // this test goes red -- verified in that session.
    stubFetch({ data: [] });
    await pcoService.requestProduct(
      "https://api.planningcenteronline.com/calendar/v2/calendars",
      "app-id",
      "secret",
      "2021-06-01",
    );

    assert.equal(seen.length, 1, "expected exactly one request");
    assert.equal(seen[0].headers["X-PCO-API-Version"], "2021-06-01");
  });

  test("the pin is an exact date, never a floating 'latest'", async () => {
    stubFetch({ data: [], included: [] });
    await pcoService.listServiceTypes("app-id", "secret");

    const sent = seen[0].headers["X-PCO-API-Version"];
    assert.match(
      sent,
      /^\d{4}-\d{2}-\d{2}$/,
      `the version must be a pinned YYYY-MM-DD date so a PCO release cannot change ` +
        `response shapes under a running install; got "${sent}"`,
    );
    assert.equal(sent, EXPECTED_VERSION);
  });

  test("the Authorization header survived being folded into the shared builder", async () => {
    stubFetch({ data: [], included: [] });
    await pcoService.listServiceTypes("app-id", "secret");

    const expected = `Basic ${Buffer.from("app-id:secret").toString("base64")}`;
    assert.equal(seen[0].headers.Authorization, expected);
    assert.equal(seen[0].headers["Content-Type"], "application/json");
  });

  test("the POSTs still POST — the shared builder did not eat the method", async () => {
    stubFetch({
      data: { id: "a1", type: "Attachment", attributes: { attachment_url: "https://example.invalid/f.pdf" } },
    });
    await pcoService.openAttachment("app-id", "secret", "st", "plan", "a1");
    assert.equal(seen[0].method, "POST", "pcoFetch spreads init before headers; a swap would drop the method");
  });
});

// ── A pin has to be in ITS OWN product's version list ──────────────────────
//
// The bug this exists for: CALENDAR_API_VERSION was "2018-11-01", copied from
// Services because "one app, one stated contract date" sounded right. Calendar
// has never published 2018-11-01. PCO resolves an unpublished date DOWN to the
// newest published one at or before it, silently, so every Calendar request in
// this app was served 2018-08-01 — Calendar's first version, five revisions
// behind current — while the identical string on Services resolved to Services'
// newest. Nothing failed. Nothing logged.
//
// So the check is not "is this a date" and not "is this string in a list". It
// RUNS PCO's own resolution rule over each product's own list and asserts the pin
// resolves to ITSELF. A pin that resolves to something else is a pin that is not
// in force, which is precisely the state this repository shipped in.
//
// The type system catches the same mistake first (PCO_API_VERSION is typed
// ServicesApiVersion, CALENDAR_API_VERSION is typed CalendarApiVersion, both
// unions of their own list), so a copy-across does not compile either. Both,
// because tsc catches the copy-across and this catches a list that has drifted
// from what PCO publishes.
describe("each product's pin is in that product's own version list", () => {
  const products = [
    { name: "Services", pin: PCO_API_VERSION as string, published: SERVICES_API_VERSIONS as readonly string[] },
    { name: "Calendar", pin: CALENDAR_API_VERSION as string, published: CALENDAR_API_VERSIONS as readonly string[] },
  ];

  for (const { name, pin, published } of products) {
    test(`${name}: the pin resolves to itself`, () => {
      const served = resolvePcoApiVersion(published, pin);
      assert.equal(
        served,
        pin,
        `${name} is pinned to "${pin}", but PCO publishes [${published.join(", ")}] for ${name} and ` +
          `resolves an unpublished date to the newest one at or before it. This pin is silently served ` +
          `"${served}". A version string is PER PRODUCT — take it from ${name}'s own version list, never ` +
          `from another PCO product's.`,
      );
    });

    test(`${name}: the pin is the newest published version`, () => {
      const newest = [...published].sort().at(-1);
      assert.equal(
        pin,
        newest,
        `${name}'s newest published version is "${newest}" but the pin is "${pin}". Bumping is a ` +
          `deliberate act — read the new version's changelog entry, then move the pin and this list together.`,
      );
    });
  }

  test("resolvePcoApiVersion models PCO's documented downgrade", () => {
    // The exact historical bug, as data: Calendar's real list, Services' date.
    assert.equal(
      resolvePcoApiVersion(CALENDAR_API_VERSIONS, "2018-11-01"),
      "2018-08-01",
      "Services' 2018-11-01 must resolve to Calendar's 2018-08-01 — that downgrade is the whole bug",
    );
    // Before a product's first version PCO answers 400 rather than serving one.
    assert.equal(resolvePcoApiVersion(CALENDAR_API_VERSIONS, "2017-01-01"), null);
    // Newest at or before, not nearest.
    assert.equal(resolvePcoApiVersion(CALENDAR_API_VERSIONS, "2029-01-01"), "2026-06-22");
    assert.equal(resolvePcoApiVersion(CALENDAR_API_VERSIONS, "2021-07-20"), "2021-07-20");
  });
});

// ── The pin cannot be missed by a NEW endpoint ─────────────────────────────
//
// The three assertions above cover the three call sites that exist. They would
// all stay green if a fourth endpoint were added with its own hand-written
// `fetch`, which is exactly how this repository has shipped a fix applied to one
// of three copies before.
//
// So the guarantee is structural rather than tested-per-site: every request goes
// through `pcoFetch`, which is the only thing in the file that calls `fetch`, and
// it applies the headers itself. This asserts an EXACT count of executable
// `fetch(` call sites — not a floor — with comments and the prose that mentions
// `fetch()` stripped first, so a comment cannot satisfy it and a fourth real call
// site cannot hide in one.
//
// pco-link-safety.test.ts pins the same count for a different reason (every
// network call must take a URL the origin guard checked). Both go red on a fourth
// site, which is the point; neither is redundant with the other.
describe("pco-service has exactly one fetch call site", () => {
  test("a new endpoint cannot reach the network without the version header", async () => {
    const fs = await import("node:fs/promises");
    const url = new URL("./pco-service.ts", import.meta.url);
    const src = await fs.readFile(url, "utf8");

    // Strip block comments, then line comments. Deliberately crude and
    // deliberately CONSERVATIVE: over-stripping would hide a real call site, so
    // the count below is asserted exactly rather than as a maximum, and any
    // stripping bug shows up as a failure rather than as silence.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

    const sites = code.match(/\bfetch\s*\(/g) ?? [];
    assert.equal(
      sites.length,
      1,
      `pco-service.ts must reach the network through pcoFetch alone, so that every ` +
        `request carries X-PCO-API-Version and the Authorization header by ` +
        `construction. Found ${sites.length} fetch( call sites in executable code. ` +
        `If you added an endpoint, route it through this.pcoFetch instead.`,
    );
    // And prove the stripping did not simply eat everything.
    assert.ok(code.includes("pcoFetch"), "comment stripping removed real code");
  });
});
