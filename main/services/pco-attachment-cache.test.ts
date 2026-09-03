// Guards for the two ways a stage plot failed to appear on an open display: a
// signed PCO link that expired inside its cache window (403 → "Couldn't load
// file", no retry), and two surfaces missing the disk cache at the same instant
// and writing the same file in place, so a third reader read truncated bytes.
//
// The download path is exercised for real — a stubbed global fetch, the real
// cache dir under a temp STAGE_UTILITY_DATA, and the bytes read back off disk.

import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "attach-cache-"));
process.env.STAGE_UTILITY_DATA = dataDir;

// Imported only after the data dir is set — getUserDataPath() memoises on first call.
const { getAttachmentFile } = await import("./pco-attachment-cache.js");

const cacheDir = path.join(dataDir, "cache", "attachments");
const realFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = realFetch;
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** Minimal Response stand-in — the cache only reads .status/.ok/.arrayBuffer(). */
function resp(status: number, body?: Buffer): Response {
  const b = body ?? Buffer.alloc(0);
  // Buffer.from() hands back a view into a shared pool — slice by offset, or the
  // "payload" would be 8 KB of unrelated pool bytes.
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => ab,
  } as unknown as Response;
}

describe("attachment cache", () => {
  test("a link rejected as expired is re-opened once and the download retried", async (t) => {
    t.after(() => {
      globalThis.fetch = realFetch;
    });
    const payload = Buffer.from("%PDF-1.7 stale-link-recovery");
    const opened: (boolean | undefined)[] = [];
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      // Measured: the link works at +3 minutes and is rejected at +4, so one can
      // die inside its cache window.
      return calls === 1 ? resp(403) : resp(200, payload);
    }) as typeof fetch;

    const file = await getAttachmentFile("stale-1", "application/pdf", "plot.pdf", async (opts) => {
      opened.push(opts?.fresh);
      return "https://example.invalid/signed";
    });

    assert.ok(file, "a 403 on the cached link must re-open and retry, not give up");
    assert.deepEqual(opened, [undefined, true], "exactly one re-open, and it must ask for a fresh link");
    assert.equal(calls, 2);
    assert.deepEqual(await fs.readFile(file.path), payload);
  });

  test("concurrent misses for one attachment download once and share the file", async (t) => {
    t.after(() => {
      globalThis.fetch = realFetch;
    });
    // The reported case: the layout editor and an open display both miss at once.
    const payload = Buffer.from("x".repeat(64 * 1024));
    let fetches = 0;
    let opens = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      await new Promise((r) => setTimeout(r, 50));
      return resp(200, payload);
    }) as typeof fetch;

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        getAttachmentFile("race-1", "application/pdf", "plot.pdf", async () => {
          opens += 1;
          return "https://example.invalid/signed";
        }),
      ),
    );

    assert.equal(opens, 1, "six concurrent misses must share one open, not open six times");
    assert.equal(fetches, 1, "six concurrent misses must share one download, not write the file six times");
    const paths = new Set(results.map((r) => r?.path));
    assert.equal(paths.size, 1, "every caller must get the same cached path");
    for (const r of results) {
      assert.ok(r);
      assert.deepEqual(await fs.readFile(r.path), payload, "a caller must never see a truncated file");
    }
  });

  // The write is never reached here — the body tears before it — so this pins
  // only that a torn download reports failure and creates nothing at the final
  // path. Temp-file cleanup on a failed WRITE is atomicWrite's job (write-queue.ts).
  test("a download that fails mid-body reports null and creates no file", async (t) => {
    t.after(() => {
      globalThis.fetch = realFetch;
    });
    globalThis.fetch = (async () =>
      ({
        status: 200,
        ok: true,
        arrayBuffer: async () => {
          throw new Error("connection reset mid-body");
        },
      }) as unknown as Response) as typeof fetch;

    const file = await getAttachmentFile(
      "torn-1",
      "application/pdf",
      "plot.pdf",
      async () => "https://example.invalid/signed",
    );

    assert.equal(file, null, "a torn download must report failure, not a path to nothing");
    const left = (await fs.readdir(cacheDir)).filter((n) => n.startsWith("torn-1"));
    assert.deepEqual(left, [], `a torn download must leave nothing at the final path, found: ${left.join(", ")}`);
  });

  // The half-written file is the bug that put "Couldn't load file" on a display:
  // a second reader passed fs.access on a path another writer was still filling
  // and handed pdf.js a truncated PDF. Written to a temp file and renamed, the
  // final path is only ever whole — so poll it throughout a download and assert
  // it is never observed at any size but the payload's.
  test("the final path is never observable half-written during a download", async (t) => {
    t.after(() => {
      globalThis.fetch = realFetch;
    });
    // Big enough that the write is not instantaneous; the open() alone exposes a
    // zero-byte file to any reader when the write is not atomic.
    const payload = Buffer.alloc(24 * 1024 * 1024, 7);
    globalThis.fetch = (async () => resp(200, payload)) as typeof fetch;

    const filePath = path.join(cacheDir, "atomic-1.pdf");
    let done = false;
    const sizesSeen: number[] = [];
    const job = getAttachmentFile(
      "atomic-1",
      "application/pdf",
      "plot.pdf",
      async () => "https://example.invalid/signed",
    ).finally(() => {
      done = true;
    });

    while (!done) {
      try {
        const st = await fs.stat(filePath);
        if (st.size !== payload.length) sizesSeen.push(st.size);
      } catch {
        // Not there yet — the only other acceptable state.
      }
      await new Promise((r) => setImmediate(r));
    }

    const file = await job;
    assert.ok(file);
    assert.equal(
      sizesSeen.length,
      0,
      `the cached path must never be readable at a partial size; saw ${sizesSeen.length} partial size(s), ` +
        `first ${sizesSeen.slice(0, 5).join(", ")} (expected ${payload.length})`,
    );
    assert.equal((await fs.stat(file.path)).size, payload.length);
  });

  test("a file already on disk is served without opening a link or fetching", async (t) => {
    t.after(() => {
      globalThis.fetch = realFetch;
    });
    const payload = Buffer.from("already-here");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "disk-1.pdf"), payload);
    globalThis.fetch = (async () => {
      throw new Error("a cached attachment must not hit the network");
    }) as typeof fetch;

    const file = await getAttachmentFile("disk-1", "application/pdf", "plot.pdf", async () => {
      throw new Error("a cached attachment must not open a new link");
    });

    assert.ok(file);
    assert.equal(file.path, path.join(cacheDir, "disk-1.pdf"));
    assert.deepEqual(await fs.readFile(file.path), payload);
  });
});
