// pco-service caches the signed download link it gets from `open`. A caller that
// has just watched that link come back 403 must be able to get past the cache —
// otherwise "re-open and retry" re-reads the same dead URL and fails identically.
// Review removed the bypass and 4145 tests stayed green; this is the guard.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { pcoService } from "./pco-service.js";

let posts = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  posts = 0;
  pcoService.clearCache();
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") posts += 1;
    const body = { data: { id: "a1", type: "Attachment", attributes: { attachment_url: `https://s3.invalid/link-${posts}` } } };
    return {
      ok: true, status: 200, statusText: "OK", headers: new Headers(),
      json: async () => body, text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  pcoService.clearCache();
});

describe("openAttachment's signed-link cache", () => {
  test("serves a repeat from cache, but a fresh request goes back to Planning Center", async () => {
    const first = await pcoService.openAttachment("app", "secret", "st", "plan", "a1");
    const again = await pcoService.openAttachment("app", "secret", "st", "plan", "a1");
    assert.equal(posts, 1, "a repeat inside the TTL must not POST again");
    assert.equal(again.url, first.url);

    const fresh = await pcoService.openAttachment("app", "secret", "st", "plan", "a1", { fresh: true });
    assert.equal(posts, 2, "fresh: true was answered from the cache — the expired link is handed straight back");
    assert.notEqual(fresh.url, first.url, "a fresh open must return the new link, not the cached one");

    // And the fresh result replaces the cached one for the next ordinary caller.
    const after = await pcoService.openAttachment("app", "secret", "st", "plan", "a1");
    assert.equal(posts, 2);
    assert.equal(after.url, fresh.url, "the fresh link was not cached for the next caller");
  });
});
