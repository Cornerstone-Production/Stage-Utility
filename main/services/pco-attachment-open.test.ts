// pco-service caches the signed download link it gets from `open`. A caller that
// has just watched that link come back 403 must be able to get past the cache —
// otherwise "re-open and retry" re-reads the same dead URL and fails identically.
// Review removed the bypass and 4145 tests stayed green; this is the guard.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { PcoUrlRefused } from "./pco-path.js";
import { pcoService } from "./pco-service.js";

let posts = 0;
let urls: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  posts = 0;
  urls = [];
  pcoService.clearCache();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
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
    const first = await pcoService.openAttachment("app", "secret", "11", "21", "31");
    const again = await pcoService.openAttachment("app", "secret", "11", "21", "31");
    assert.equal(posts, 1, "a repeat inside the TTL must not POST again");
    assert.equal(again.url, first.url);

    const fresh = await pcoService.openAttachment("app", "secret", "11", "21", "31", { fresh: true });
    assert.equal(posts, 2, "fresh: true was answered from the cache — the expired link is handed straight back");
    assert.notEqual(fresh.url, first.url, "a fresh open must return the new link, not the cached one");

    // And the fresh result replaces the cached one for the next ordinary caller.
    const after = await pcoService.openAttachment("app", "secret", "11", "21", "31");
    assert.equal(posts, 2);
    assert.equal(after.url, fresh.url, "the fresh link was not cached for the next caller");
  });
});

// Planning Center issues the plan's stage plot an all_attachments id with a word
// on the end, "84892470-stage". v1.25.0 refused it, so the stage plot never opened.
describe("openAttachment's attachment id", () => {
  test("opens a suffixed stage-plot id at exactly that path", async () => {
    await pcoService.openAttachment("app", "secret", "11", "21", "84892470-stage");
    assert.deepEqual(urls, [
      "https://api.planningcenteronline.com/services/v2/service_types/11/plans/21/all_attachments/84892470-stage/open",
    ]);
  });

  test("still opens a plain numeric id", async () => {
    await pcoService.openAttachment("app", "secret", "11", "21", "84892470");
    assert.match(urls[0], /\/all_attachments\/84892470\/open$/);
  });

  test("refuses anything that could leave the path segment, and sends nothing", async () => {
    const tooLong = `84892470-${"a".repeat(21)}`;
    for (const bad of ["../x", "84892470-stage/../../x", "abc", "", tooLong, "84892470-stage?x=1"]) {
      await assert.rejects(
        pcoService.openAttachment("app", "secret", "11", "21", bad),
        PcoUrlRefused,
        `openAttachment accepted ${JSON.stringify(bad)}`,
      );
    }
    assert.deepEqual(urls, [], "a refused id must not reach the network");
  });

  test("a suffixed id is not accepted where a plan id belongs", async () => {
    await assert.rejects(pcoService.openAttachment("app", "secret", "11", "21-stage", "31"), PcoUrlRefused);
  });
});

// The signed link is cached per attachment id AND version. Keyed by id alone, a file
// replaced under the same id was answered with the OLD file's link for the TTL, and
// the disk cache then stored the old bytes under the new version's name.
describe("openAttachment's signed-link cache and a replaced file", () => {
  test("a new version of the same id gets its own link; the same version is cached", async () => {
    const v1 = await pcoService.openAttachment("app", "secret", "11", "21", "84892470-stage", { version: "t1000" });
    const again = await pcoService.openAttachment("app", "secret", "11", "21", "84892470-stage", { version: "t1000" });
    assert.equal(posts, 1);
    assert.equal(again.url, v1.url);

    const v2 = await pcoService.openAttachment("app", "secret", "11", "21", "84892470-stage", { version: "t2000" });
    assert.equal(posts, 2, "a replaced file was answered from the old file's cached link");
    assert.notEqual(v2.url, v1.url);
  });
});

describe("listPlanAttachments carries updated_at", () => {
  test("updatedAt is Planning Center's updated_at, or null when it is absent", async () => {
    globalThis.fetch = (async () => {
      const body = {
        data: [
          { id: "1", type: "Attachment", attributes: { filename: "a.pdf", file_size: 10, updated_at: "2026-10-08T14:00:00Z" } },
          { id: "2-stage", type: "Attachment", attributes: { filename: "b.pdf" } },
        ],
        links: {},
      };
      return {
        ok: true, status: 200, statusText: "OK", headers: new Headers(),
        json: async () => body, text: async () => JSON.stringify(body),
      } as unknown as Response;
    }) as typeof fetch;
    const list = await pcoService.listPlanAttachments("app", "secret", "11", "21");
    assert.deepEqual(list.map((a) => [a.id, a.updatedAt, a.fileSizeBytes]), [
      ["1", "2026-10-08T14:00:00Z", 10],
      ["2-stage", null, null],
    ]);
  });
});
