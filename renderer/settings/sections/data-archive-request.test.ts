// The archive panel read the reply as JSON before it looked at the status, and
// waited for ever. A proxy's HTML 502 surfaced as "Unexpected token <", and a
// stalled upload left the panel busy until the page was reloaded.

import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";

import { postArchive } from "./data-archive-request.js";

afterEach(() => mock.restoreAll());

const BYTES = new ArrayBuffer(4);

describe("postArchive", () => {
  test("a non-JSON error answer reports its status, not a parse error", async () => {
    mock.method(globalThis, "fetch", async () => new Response("<html>Bad Gateway</html>", { status: 502 }));
    await assert.rejects(
      postArchive("/api/archive/inspect", BYTES, { failure: "Could not read that archive." }),
      (e: Error) => e.message === "Could not read that archive. (HTTP 502)",
    );
  });

  test("the route's own error text wins when it sent one", async () => {
    mock.method(globalThis, "fetch", async () => Response.json({ error: "That is not an archive." }, { status: 400 }));
    await assert.rejects(postArchive("/api/archive/import", BYTES, { failure: "Import failed." }), /That is not an archive\./);
  });

  test("a stalled request ends, and says it ran out of time", async () => {
    mock.method(globalThis, "fetch", (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    );
    await assert.rejects(
      postArchive("/api/archive/import", BYTES, { failure: "Import failed.", timeoutMs: 20 }),
      /Import failed\. The server did not answer in time/,
    );
  });

  test("a good answer is returned parsed", async () => {
    mock.method(globalThis, "fetch", async () => Response.json({ added: [] }));
    assert.deepEqual(await postArchive("/api/archive/import", BYTES, { failure: "x" }), { added: [] });
  });
});
