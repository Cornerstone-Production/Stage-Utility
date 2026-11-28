// hash16 names stored files and fingerprints published documents. A stored
// file's name IS its hash, so the value must never drift: a change would orphan
// every image already on disk.

import assert from "node:assert/strict";
import { test } from "node:test";

import { contentName, hash16 } from "./image-files.js";
import { docHash } from "./servicecue-publish-docs.js";

test("hash16 is the first 16 hex digits of the SHA-256, for text and for bytes", () => {
  assert.equal(hash16("abc"), "ba7816bf8f01cfea");
  assert.equal(hash16(Buffer.from("abc")), "ba7816bf8f01cfea");
});

test("a stored file's name and a published document's fingerprint are that same hash", () => {
  assert.equal(contentName(Buffer.from("abc"), "png"), "ba7816bf8f01cfea.png");
  assert.equal(docHash("abc"), "ba7816bf8f01cfea");
});
