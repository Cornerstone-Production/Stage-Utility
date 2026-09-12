// The three things that can go wrong reading a bare integer off a public URL.
//
// EMPTY IS NOT ZERO. One SafeSpace sample in six comes back with no body at all.
// `Number("")` is 0, so the obvious parser reports an empty building — and a
// confident 0 is worse than a stale number, because an automation rule with an
// occupancy threshold acts on it and a display shows it without a hint that
// anything is wrong.
//
// THE QUOTA IS THE SERVER'S TO STATE. Responses carry `X-RateLimit-Limit: 40`
// and a request was measured to spend 2, refilling in about twenty seconds — but
// those are one afternoon's observations, and the Planning Center client has just
// had exactly this class of assumption taken out of it. So the cost is measured
// from consecutive `X-RateLimit-Remaining` values and the hold-off comes from
// `X-RateLimit-Reset`, and both of those are asserted here.
//
// THE SPACE ID IS THE CREDENTIAL. It is the whole of the URL's authority: no key,
// no token, no account check. Anything this module can put in front of a human
// goes through redact().

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import { redact, resetDelayMs, SafeSpaceClient } from "./safespace-client.js";

const T0 = 1_700_000_000_000;
const SPACE = "abc123-space-id";

const realFetch = globalThis.fetch;

/** Requests the stub saw, so a case can prove one did NOT go out. */
let urls: string[] = [];

/** Answer every read with one body + headers. */
function stub(
  body: string | (() => string),
  init: ResponseInit | (() => ResponseInit) = {},
): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const b = typeof body === "function" ? body() : body;
    const i = typeof init === "function" ? init() : init;
    return new Response(b, i);
  }) as typeof fetch;
}

describe("SafeSpace live occupancy", () => {
  beforeEach(() => {
    urls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reads a bare integer", async () => {
    stub("417");
    const r = await new SafeSpaceClient().read(SPACE, T0);
    assert.equal(r.kind, "ok");
    assert.equal(r.kind === "ok" && r.occupancy, 417);
    assert.match(urls[0], /live-occupancy\//, "the reading did not go to the live-occupancy endpoint");
  });

  it("reads an EMPTY body as unknown, never as zero", async () => {
    // THE bug this file exists for. One sample in six looks like this.
    stub("");
    const r = await new SafeSpaceClient().read(SPACE, T0);
    // Named before the assertion narrows it, so the failure message can say what
    // the naive parser produced rather than just "not empty".
    const got = r.kind === "ok" ? `occupancy ${r.occupancy}` : r.kind;
    assert.equal(r.kind, "empty", `an empty response parsed as ${got} — an empty building`);
  });

  it("reads whitespace and non-numeric text as unknown too", async () => {
    // `Number("  ")` and `Number("\n")` are both 0, and an HTML error page is not
    // a count. Each of these would have published a number.
    for (const body of ["   ", "\n", "<html>502</html>", "n/a", "NaN"]) {
      stub(body);
      const r = await new SafeSpaceClient().read(SPACE, T0);
      assert.notEqual(r.kind, "ok", `${JSON.stringify(body)} was read as a count`);
    }
  });

  it("accepts a genuine zero", async () => {
    // The building really can be empty, and unknown must not swallow that.
    stub("0");
    const r = await new SafeSpaceClient().read(SPACE, T0);
    assert.equal(r.kind, "ok", "a real zero was discarded as unknown");
    assert.equal(r.kind === "ok" && r.occupancy, 0);
  });

  it("returns an HTTP failure with its status rather than throwing", async () => {
    stub("", { status: 503 });
    const r = await new SafeSpaceClient().read(SPACE, T0);
    assert.equal(r.kind, "failed");
    assert.equal(r.kind === "failed" && r.status, 503);
  });

  it("measures what a request costs from the headers instead of assuming", async () => {
    // 40 and 2 were measured once; the server is the one that knows. Two
    // responses is all it takes to learn the cost, and nothing here hard-codes it.
    let remaining = 40;
    stub("100", () => ({
      headers: { "X-RateLimit-Limit": "40", "X-RateLimit-Remaining": String((remaining -= 2)) },
    }));
    const c = new SafeSpaceClient();
    await c.read(SPACE, T0);
    assert.equal(c.quota().cost, null, "a cost was claimed from a single observation");
    await c.read(SPACE, T0 + 10_000);
    assert.deepEqual(c.quota(), { limit: 40, remaining: 36, cost: 2 });
  });

  it("stops asking once the server says the bucket cannot pay for a request", async () => {
    let remaining = 4;
    stub("100", () => ({
      headers: {
        "X-RateLimit-Limit": "40",
        "X-RateLimit-Remaining": String((remaining -= 2)),
        "X-RateLimit-Reset": "20",
      },
    }));
    const c = new SafeSpaceClient();
    await c.read(SPACE, T0); // remaining 2, no cost known yet
    await c.read(SPACE, T0 + 10_000); // remaining 0, cost 2 → below cost, hold
    const sent = urls.length;

    const held = await c.read(SPACE, T0 + 15_000);
    assert.equal(held.kind, "held", "a read went out with the bucket empty");
    assert.equal(urls.length, sent, "a held read still hit the endpoint");

    // ...and it resumes once the reset the SERVER named has passed.
    remaining = 40;
    const after = await c.read(SPACE, T0 + 31_000);
    assert.equal(after.kind, "ok", `still held ${after.kind === "held" ? after.why : ""}`);
  });

  it("honours Retry-After on a 429", async () => {
    stub("", { status: 429, headers: { "Retry-After": "45" } });
    const c = new SafeSpaceClient();
    const first = await c.read(SPACE, T0);
    assert.equal(first.kind, "failed");
    const sent = urls.length;
    assert.equal((await c.read(SPACE, T0 + 30_000)).kind, "held", "asked again inside Retry-After");
    assert.equal(urls.length, sent, "a held read still hit the endpoint");
  });

  it("forgets the quota, because a different space may be a different bucket", async () => {
    stub("", { status: 429, headers: { "Retry-After": "45" } });
    const c = new SafeSpaceClient();
    await c.read(SPACE, T0);
    c.forget();
    stub("7");
    assert.equal((await c.read("a-different-space", T0 + 1000)).kind, "ok");
    assert.deepEqual(c.quota(), { limit: null, remaining: null, cost: null });
  });

  describe("redact", () => {
    it("takes the space id out of a message that quotes the URL", () => {
      const url = `https://app.safespace.io/api/raw-data/live-occupancy/${SPACE}`;
      const out = redact(`TypeError: fetch failed for ${url}`, SPACE);
      assert.ok(!out.includes(SPACE), `the space id survived redaction: ${out}`);
      assert.match(out, /<space id>/, "the redaction left nothing to show something was removed");
    });

    it("takes every occurrence, not the first", () => {
      const out = redact(`${SPACE} then ${SPACE} again`, SPACE);
      assert.ok(!out.includes(SPACE), out);
    });

    it("takes the PERCENT-ENCODED form too, which is what the URL carries", () => {
      // The id goes into the URL through encodeURIComponent, and a fetch error
      // quotes the URL. An id holding a space, a slash or a non-ASCII character
      // therefore reaches the log in a form a raw-string split walks straight
      // past — which would make the file header's "never in a URL" untrue.
      for (const id of ["space one", "a/b", "caf\u00e9-space"]) {
        const url = `https://app.safespace.io/api/raw-data/live-occupancy/${encodeURIComponent(id)}`;
        const out = redact(`TypeError: fetch failed for ${url}`, id);
        assert.ok(
          !out.includes(encodeURIComponent(id)),
          `the encoded space id survived redaction: ${out}`,
        );
      }
    });

    it("still flattens a forged log line when no id is configured", () => {
      // redact() is also the scrub() choke point: /log is one record per line, so
      // a value carrying a newline forges an entry whether or not an id is set.
      const out = redact("ok\n[sensource] all clear", null);
      assert.ok(!out.includes("\n"), "a real newline reached the log through redact");
      assert.match(out, /\\n/, "the newline vanished instead of being shown as escaped");
    });
  });

  describe("resetDelayMs", () => {
    it("reads a delta in seconds", () => {
      assert.equal(resetDelayMs("20", T0), 20_000);
    });
    it("reads a Unix instant", () => {
      assert.equal(resetDelayMs(String(Math.floor(T0 / 1000) + 30), T0), 30_000);
    });
    it("reads the HTTP-date form", () => {
      assert.equal(resetDelayMs(new Date(T0 + 60_000).toUTCString(), T0), 60_000);
    });
    it("clamps a value that would take the count off the air", () => {
      // A quota reading that is wrong, or a box with a bad clock, must not park
      // the occupancy for the rest of a service.
      assert.equal(resetDelayMs("86400", T0), 5 * 60_000);
    });
    it("is null when the header is absent or nonsense", () => {
      assert.equal(resetDelayMs(null, T0), null);
      assert.equal(resetDelayMs("soon", T0), null);
    });
  });
});
