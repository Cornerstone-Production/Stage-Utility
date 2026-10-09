// The expired-link fix is a flag threaded through three files: the cache asks
// for a FRESH link after a 403, the route hands that request to the controller,
// the controller hands it to pco-service, and pco-service skips its signed-URL
// cache for it. Review deleted the route's half of the threading and the whole
// suite stayed green — the cache test stubs openUrl out, so nothing was watching
// whether "fresh" ever reached the code that gives it meaning.
//
// This drives the real route with a stubbed controller and a stubbed fetch, so
// the request the route actually makes of the controller is what is asserted.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, mock, test } from "node:test";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pco-attachment-link-"));
process.env.STAGE_UTILITY_DATA = DIR;

const { proxyRoutes } = await import("./proxy-routes.js");
const { callRoute } = await import("./route-harness.js");
const { stageController } = await import("../stage-controller.js");
const { pcoService } = await import("../pco-service.js");
const { attachmentEtag, attachmentVersion } = await import("../pco-attachment-cache.js");

after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

const realFetch = globalThis.fetch;

describe("/api/pco/attachment on a link Planning Center has already expired", () => {
  test("asks the controller for a fresh link, and only after the cached one is rejected", async (t) => {
    const opened: (unknown | undefined)[] = [];
    mock.method(stageController, "findPlanAttachment", async () => ({
      id: "att-1", filename: "Stage Plot.pdf", contentType: "application/pdf", sourceLabel: null,
    }));
    mock.method(stageController, "openPlanAttachment", async (_id: string, opts?: unknown) => {
      opened.push(opts);
      return { url: opened.length === 1 ? "https://s3.invalid/stale" : "https://s3.invalid/fresh", contentType: "application/pdf" };
    });
    const payload = Buffer.from("%PDF-1.4 fresh bytes");
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/stale")
        ? new Response("expired", { status: 403 })
        : new Response(payload, { status: 200 })) as typeof fetch;
    t.after(() => {
      globalThis.fetch = realFetch;
      mock.restoreAll();
    });

    const r = await callRoute(proxyRoutes, "/api/pco/attachment?match=stage%20plot");

    assert.equal(r.status, 200, `the route gave up on the expired link: ${r.status} ${r.body}`);
    assert.equal(r.body, payload.toString(), "the bytes served are not the fresh download");
    assert.deepEqual(
      opened,
      [undefined, { fresh: true }],
      "the second open must ask for a FRESH link — anything else re-reads the cached, expired one",
    );
  });
});

// Planning Center lists the plan's stage plot under a suffixed id. Everything from
// the route down to the credentialed URL is real here (the controller's list is the
// only stub, and its open goes to the real pcoService.openAttachment); only fetch
// is faked, so the id that reaches Planning Center is the one asserted.
describe("/api/pco/attachment for the plan's stage plot", () => {
  test("serves a file whose Planning Center id is suffixed", async (t) => {
    const stagePlot = { id: "84892470-stage", filename: "2026.10.08 Stage Plot.pdf", contentType: "application/pdf", sourceLabel: "Plan file" };
    mock.method(stageController, "listPlanAttachments", async () => [
      { id: "84892001", filename: "Lyrics.pdf", contentType: "application/pdf", sourceLabel: "Item" },
      stagePlot,
    ]);
    mock.method(stageController, "openPlanAttachment", (id: string, opts?: { fresh?: boolean }) =>
      pcoService.openAttachment("app", "secret", "11", "21", id, opts),
    );
    pcoService.clearCache();
    const payload = Buffer.from("%PDF-1.4 stage plot bytes");
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      if (String(input).includes("/open")) {
        const body = { data: { id: "84892470-stage", type: "Attachment", attributes: { attachment_url: "https://s3.invalid/plot" } } };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(payload, { status: 200 });
    }) as typeof fetch;
    t.after(() => {
      globalThis.fetch = realFetch;
      pcoService.clearCache();
      mock.restoreAll();
    });

    const r = await callRoute(proxyRoutes, "/api/pco/attachment?match=stage%20plot");

    assert.equal(r.status, 200, `the stage plot was not served: ${r.status} ${r.body}`);
    assert.equal(r.body, payload.toString());
    assert.ok(
      requested.some((u) => u.endsWith("/plans/21/all_attachments/84892470-stage/open")),
      `Planning Center was never asked to open the suffixed id: ${requested.join(", ")}`,
    );
  });
});

// A stage plot replaced on the same plan. The display revalidates what it is showing
// with If-None-Match; an unchanged file is a 304 with no download, a changed one is
// fetched fresh even though the attachment id is the same.
describe("/api/pco/attachment and a file that changes", () => {
  function setup(t: { after: (fn: () => void) => void }, id: string) {
    const att = { id, filename: "Revisit Stage Plot.pdf", contentType: "application/pdf", sourceLabel: "Plan file", fileSizeBytes: 20, updatedAt: "2026-10-08T14:00:00Z" };
    mock.method(stageController, "listPlanAttachments", async () => [att]);
    mock.method(stageController, "openPlanAttachment", (id: string, opts?: { fresh?: boolean; version?: string }) =>
      pcoService.openAttachment("app", "secret", "11", "21", id, opts),
    );
    pcoService.clearCache();
    const seen = { opens: 0, downloads: 0, bytes: Buffer.from("first upload") };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/open")) {
        seen.opens += 1;
        const body = { data: { id: "x", type: "Attachment", attributes: { attachment_url: `https://s3.invalid/link-${seen.opens}` } } };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
      seen.downloads += 1;
      return new Response(seen.bytes, { status: 200 });
    }) as typeof fetch;
    t.after(() => {
      globalThis.fetch = realFetch;
      pcoService.clearCache();
      mock.restoreAll();
    });
    return { att, seen };
  }
  // The disk cache outlives a test, so each test names its own attachment.
  const get = (inm?: string) => callRoute(proxyRoutes, "/api/pco/attachment?match=revisit", inm ? { headers: { "if-none-match": inm } } : {});

  test("a 200 carries an ETag, and If-None-Match with it is a 304 with no download", async (t) => {
    const { seen } = setup(t, "84892470-stage");
    const first = await get();
    assert.equal(first.status, 200);
    const etag = first.headers["ETag"];
    assert.match(etag, /^"84892470-stage\.t\d+"$/);
    assert.match(first.headers["Cache-Control"], /max-age=300/);
    assert.equal(seen.downloads, 1);

    const again = await get(etag);
    assert.equal(again.status, 304, "an unchanged file was sent again");
    assert.equal(again.body, "");
    assert.equal(again.headers["ETag"], etag);
    assert.equal(seen.downloads, 1, "a 304 must not download");
    assert.equal(seen.opens, 1, "a 304 must not open a new link");
  });

  test("the same id with a newer updated_at is downloaded fresh and served, under a new ETag", async (t) => {
    const { att, seen } = setup(t, "84892471-stage");
    const first = await get();
    const oldTag = first.headers["ETag"];
    assert.equal(first.body, "first upload");

    att.updatedAt = "2026-10-08T15:30:00Z";
    seen.bytes = Buffer.from("second upload");
    const r = await get(oldTag);
    assert.equal(r.status, 200, "the old ETag answered 304 for a replaced file");
    assert.equal(r.body, "second upload", "the replaced file was served from the old bytes or the old link");
    assert.notEqual(r.headers["ETag"], oldTag);
    assert.equal(seen.opens, 2, "a replaced file reused the old file's signed link");
  });

  test("a 304 is answered before anything is downloaded, with nothing on disk", async (t) => {
    // The test above warms the disk first, so it cannot tell a 304 sent before the
    // download from one sent after it. Here the id and version have never been fetched.
    const { att, seen } = setup(t, "84892472-stage");
    const etag = attachmentEtag(att.id, attachmentVersion(att.updatedAt, att.fileSizeBytes));
    const r = await get(etag);
    assert.equal(r.status, 304);
    assert.equal(seen.downloads, 0, "a 304 downloaded the file first");
    assert.equal(seen.opens, 0, "a 304 opened a signed link first");
  });
});
