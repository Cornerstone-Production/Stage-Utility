// Uploads stream to disk. They are never held in memory.
//
// readRawBody, which every other upload route uses, accumulates chunks and then
// Buffer.concats them — so peak memory is roughly twice the body. Its own
// comment says a body past 128 MB "wants streaming to a temp file, not a bigger
// number", and a 200 MB video is exactly that case. Raising the constant instead
// would put an unauthenticated ~400 MB allocation one curl away on a Pi, which
// is the OOM that cap exists to prevent.
//
// So the three properties worth pinning are: the cap bites MID-STREAM rather
// than after the body has arrived, the temp file is gone on every exit path
// including the refusal, and the stored name is the hash of what actually
// arrived rather than anything the sender claimed.

import { strict as assert } from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { after, describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-utility-signage-upload-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
process.env.HOME = path.join(TMP, "home");

const { streamUploadToMedia, UploadTooLargeError } = await import("./signage-upload.js");
const { SIGNAGE_MEDIA_DIR } = await import("./signage-media-store.js");

const MEDIA_DIR = path.join(TMP, "data", SIGNAGE_MEDIA_DIR);

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

/** A request body delivered in realistic chunks rather than one buffer. */
function body(bytes: Buffer, chunk = 64 * 1024): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunk) parts.push(bytes.subarray(i, i + chunk));
  return Readable.from(parts.length ? parts : [Buffer.alloc(0)]);
}

const sha16 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);

async function tempFiles(): Promise<string[]> {
  const all = await fs.readdir(MEDIA_DIR).catch(() => [] as string[]);
  return all.filter((f) => f.endsWith(".tmp"));
}

describe("streaming an upload", () => {
  test("names the file after its own bytes", async () => {
    const bytes = Buffer.from("pretend png");
    const r = await streamUploadToMedia(body(bytes), "image/png");
    assert.equal(r.file, `${sha16(bytes)}.png`);
    assert.equal(r.bytes, bytes.length);
    assert.equal(r.existed, false);
    assert.deepEqual(await fs.readFile(path.join(MEDIA_DIR, r.file)), bytes);
  });

  test("the same bytes twice writes once and says so", async () => {
    const bytes = Buffer.from("pretend png");
    const r = await streamUploadToMedia(body(bytes), "image/png");
    assert.equal(r.existed, true);
    assert.equal(r.file, `${sha16(bytes)}.png`);
  });

  test("different bytes are a different file", async () => {
    const bytes = Buffer.from("a different pretend png");
    const r = await streamUploadToMedia(body(bytes), "image/png");
    assert.equal(r.existed, false);
    assert.equal(r.file, `${sha16(bytes)}.png`);
  });

  test("a video is stored under its own extension", async () => {
    const bytes = Buffer.from("pretend mp4");
    const r = await streamUploadToMedia(body(bytes), "video/mp4");
    assert.match(r.file, /\.mp4$/);
  });

  test("stops at the per-mime cap", async () => {
    const big = Buffer.alloc(13 * 1024 * 1024, 7); // over the 12 MB image cap
    await assert.rejects(() => streamUploadToMedia(body(big), "image/png"), UploadTooLargeError);
  });

  test("the same body is fine under the video cap", async () => {
    // Proves the cap is per-mime rather than one global number.
    const big = Buffer.alloc(13 * 1024 * 1024, 7);
    const r = await streamUploadToMedia(body(big), "video/mp4");
    assert.equal(r.bytes, big.length);
  });

  test("leaves no temp file behind when it refuses", async () => {
    // A 200 MB orphan per aborted upload fills an SD card in an afternoon.
    const big = Buffer.alloc(13 * 1024 * 1024, 7);
    await streamUploadToMedia(body(big), "image/png").catch(() => {});
    assert.deepEqual(await tempFiles(), [], "an aborted upload left a temp file");
  });

  test("leaves no temp file behind when the stream itself fails", async () => {
    const failing = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("connection reset"));
      },
    });
    await assert.rejects(() => streamUploadToMedia(failing, "image/png"), /connection reset/);
    assert.deepEqual(await tempFiles(), [], "a broken connection left a temp file");
  });

  test("refuses a mime that is not on the allowlist", async () => {
    await assert.rejects(
      () => streamUploadToMedia(body(Buffer.from("<svg/>")), "image/svg+xml"),
      /not accepted/i,
    );
  });

  test("refuses an unknown mime without writing anything", async () => {
    const before = (await fs.readdir(MEDIA_DIR).catch(() => [])).length;
    await streamUploadToMedia(body(Buffer.from("x")), "application/zip").catch(() => {});
    assert.equal((await fs.readdir(MEDIA_DIR).catch(() => [])).length, before);
  });

  test("refuses an empty body", async () => {
    await assert.rejects(() => streamUploadToMedia(body(Buffer.alloc(0)), "image/png"), /empty/i);
  });

  test("a body exactly at the cap is accepted, not rejected off by one", async () => {
    const exact = Buffer.alloc(12 * 1024 * 1024, 3);
    const r = await streamUploadToMedia(body(exact), "image/png");
    assert.equal(r.bytes, exact.length);
  });
});
