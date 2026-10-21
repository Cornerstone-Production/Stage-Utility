// body.test.ts — a body is read up to its cap and no further.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BodyTooLarge, readCappedBody } from "./body.js";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://x.example/", { method: "POST", body, headers, duplex: "half" } as RequestInit);

/** A body that arrives in `chunks` pieces with no Content-Length: how a chunked upload reads. */
function streamed(total: number, chunks: number): Request {
  const piece = Math.ceil(total / chunks);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      const n = Math.min(piece, total - sent);
      controller.enqueue(new Uint8Array(n).fill(97));
      sent += n;
    },
  });
  return post(body);
}

describe("readCappedBody", () => {
  test("returns a body under the cap exactly as it came", async () => {
    const bytes = await readCappedBody(post('{"a":1}'), 100);
    assert.equal(new TextDecoder().decode(bytes), '{"a":1}');
  });

  test("returns a body of exactly the cap", async () => {
    const bytes = await readCappedBody(post("a".repeat(100)), 100);
    assert.equal(bytes.byteLength, 100);
  });

  test("a request with no body is empty", async () => {
    const bytes = await readCappedBody(new Request("https://x.example/", { method: "PUT" }), 100);
    assert.equal(bytes.byteLength, 0);
  });

  test("a body one byte over the cap is refused", async () => {
    await assert.rejects(() => readCappedBody(post("a".repeat(101)), 100), BodyTooLarge);
  });

  test("a Content-Length over the cap is refused before anything is read", async () => {
    let pulled = false;
    // A high-water mark of 0 means nothing is pulled until somebody reads: with the
    // default of 1 the stream pulls once on its own, and this would pass or fail on
    // that and not on what readCappedBody did.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array(10));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    await assert.rejects(() => readCappedBody(post(body, { "content-length": "101" }), 100), BodyTooLarge);
    assert.equal(pulled, false, "the body was read although its declared length was already too much");
  });

  test("a body that does not declare its length is counted as it arrives", async () => {
    await assert.rejects(() => readCappedBody(streamed(10_000, 50), 1000), BodyTooLarge);
    const bytes = await readCappedBody(streamed(1000, 7), 1000);
    assert.equal(bytes.byteLength, 1000);
  });

  test("a Content-Length that LIES low does not get past the cap", async () => {
    // Declares 5 bytes and sends 5000. What decides is what arrives. A stand-in for
    // the request, because a real Request may correct the header to the true length,
    // which would turn this into the test above.
    const lying = {
      headers: new Headers({ "content-length": "5" }),
      body: new Blob([new Uint8Array(5000).fill(97)]).stream(),
    } as unknown as Request;
    await assert.rejects(() => readCappedBody(lying, 1000), BodyTooLarge);
  });

  test("stops reading once it is over the cap", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(400));
      },
    });
    await assert.rejects(() => readCappedBody(post(body), 1000), BodyTooLarge);
    assert.ok(pulls <= 4, `kept pulling an endless body: ${pulls} chunks`);
  });
});
