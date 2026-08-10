// The route body limits, checked against the limits they have to clear.
//
// The 8 MB JSON cap sat below the app's own 12 MB image limit, and a config
// snapshot embeds every stored image base64'd — about a third larger again. So
// the app could export a backup it then refused to import, and answer 413 to an
// image the image store would have accepted. Two numbers, in two files, that
// nobody had ever compared.
//
// Compared against the REAL exported constants, not copies. A test carrying its
// own `12 * 1024 * 1024` would go on passing after someone raised the store's
// limit, which is exactly the drift being guarded.
//
// Also covers readBody's decoding: it used to decode each chunk as it arrived,
// so a multi-byte character split across a chunk boundary became U+FFFD.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PassThrough } from "node:stream";
import type * as http from "node:http";

import { MAX_IMAGE_BYTES } from "../image-files.js";
import { MAX_LAYOUT_IMAGE_BYTES } from "../layout-image-store.js";
import {
  MAX_CONFIG_BODY_BYTES,
  MAX_IMAGE_BODY_BYTES,
  MAX_JSON_BODY_BYTES,
  BodyTooLargeError,
  readBody,
} from "./context.js";

/** base64 is 4 bytes out for every 3 in, plus the data-URL prefix and the JSON
 *  envelope around it. A body limit has to clear that, not just the raw size. */
const BASE64_EXPANSION = 4 / 3;

/** A request whose body arrives as the given chunks. */
function request(chunks: (string | Buffer)[]): http.IncomingMessage {
  const stream = new PassThrough();
  const req = stream as unknown as http.IncomingMessage;
  req.headers = {};
  queueMicrotask(() => {
    for (const c of chunks) stream.write(typeof c === "string" ? Buffer.from(c, "utf8") : c);
    stream.end();
  });
  return req;
}

describe("route body limits", () => {
  it("the image routes accept anything the image stores accept", () => {
    for (const [what, storeLimit] of [
      ["image-files", MAX_IMAGE_BYTES],
      ["layout images", MAX_LAYOUT_IMAGE_BYTES],
    ] as const) {
      assert.ok(
        MAX_IMAGE_BODY_BYTES > storeLimit * BASE64_EXPANSION,
        `the image body limit (${MAX_IMAGE_BODY_BYTES}) must clear ${what}'s own ` +
          `${storeLimit} once base64'd — otherwise the route 413s an image the store would take`,
      );
    }
  });

  it("the config import accepts a bundle carrying several images", () => {
    // A snapshot is not one image: it is every config file plus every stored
    // image at once. Two at the store's ceiling is a modest real install.
    assert.ok(
      MAX_CONFIG_BODY_BYTES > MAX_IMAGE_BYTES * BASE64_EXPANSION * 2,
      "a config bundle with two full-size images must be importable",
    );
  });

  it("keeps the ordinary JSON cap small — it is what bounds an unauthenticated POST", () => {
    // The fix is per-route headroom, NOT a bigger global number. If this ever
    // rises to meet the others, the cap has stopped doing its job.
    assert.ok(MAX_JSON_BODY_BYTES < MAX_IMAGE_BODY_BYTES);
    assert.ok(MAX_JSON_BODY_BYTES <= 8 * 1024 * 1024);
  });
});

describe("readBody", () => {
  it("decodes UTF-8 split across a chunk boundary", async () => {
    // The exact failure: one character, two chunks. Decoding per chunk yields
    // two replacement characters and the JSON either breaks or carries mojibake.
    const json = Buffer.from(JSON.stringify({ title: "Amazing Grace — Verse 2 (Café)" }), "utf8");
    const cut = json.indexOf(Buffer.from("—", "utf8")) + 1; // mid-character
    const body = (await readBody(request([json.subarray(0, cut), json.subarray(cut)]))) as {
      title: string;
    };
    assert.equal(body.title, "Amazing Grace — Verse 2 (Café)");
    assert.ok(!body.title.includes("�"), "a character was mangled at the chunk boundary");
  });

  it("still refuses an over-limit body", async () => {
    await assert.rejects(
      () => readBody(request(["x".repeat(200)]), 100),
      BodyTooLargeError,
      "the streaming size check must survive the decoding change",
    );
  });

  it("reads an ordinary body whole", async () => {
    const body = await readBody(request(['{"a":', "1}"]));
    assert.deepEqual(body, { a: 1 });
  });

  it("treats an empty body as an empty object", async () => {
    assert.deepEqual(await readBody(request([])), {});
  });
});
