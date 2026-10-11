// The shared download pieces: a small body under a cap, a large one streamed to a
// temporary file, the watchdog that ends a stalled transfer, and the rename that
// makes a finished file visible. Each caller (the photo cache, the video relay's
// binary, the Mac output helper) has its own tests; these hold the rules they
// share, once.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { commitPart, downloadWatchdog, readCapped, sha256OfFile, streamToPart } from "./capped-download.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-capped-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A body of the given chunks that reports when it is cancelled. */
function body(chunks: Uint8Array[], then?: "error"): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else if (then === "error") c.error(new Error("connection reset"));
      else c.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);
const names = async () => (await fs.readdir(dir)).sort();

describe("readCapped", () => {
  it("returns a body that is inside the cap, whole", async () => {
    const buf = await readCapped(new Response(body([bytes(10, 1), bytes(10, 2)]).stream), 100);
    assert.equal(buf?.byteLength, 20);
  });

  // The cap used to be checked against content-length only. A chunked response
  // has none, Number(null) is 0, and the guard passed, so the whole body was
  // materialised in a Pi's heap before its size was ever looked at.
  it("returns null past the cap, and stops the transfer", async () => {
    const b = body([bytes(60), bytes(60), bytes(60)]);
    const res = new Response(b.stream);
    assert.equal(res.headers.get("content-length"), null, "fixture must not declare a length");
    assert.equal(await readCapped(res, 100), null);
    assert.ok(b.cancelled(), "the rest of the body is not left running");
  });

  it("stops pulling rather than draining the whole body", async () => {
    let produced = 0;
    const res = new Response(
      new ReadableStream({
        pull(c) {
          produced += 1;
          if (produced > 50) return c.close();
          c.enqueue(new Uint8Array(32));
        },
      }),
    );
    assert.equal(await readCapped(res, 64), null);
    assert.ok(produced < 10, `kept pulling after the cap: ${produced} chunks`);
  });

  it("counts the bytes that arrive, at the boundary exactly", async () => {
    assert.equal((await readCapped(new Response(body([bytes(100)]).stream), 100))?.byteLength, 100);
    assert.equal(await readCapped(new Response(body([bytes(101)]).stream), 100), null);
  });

  it("answers a response with no body stream by its text", async () => {
    assert.equal((await readCapped(new Response(null), 100))?.byteLength, 0);
  });
});

describe("streamToPart", () => {
  it("writes the whole body under the part name and reports the bytes", async () => {
    const part = path.join(dir, "a.part");
    const seen: number[] = [];
    const r = await streamToPart(body([bytes(5, 1), bytes(7, 2)]).stream, part, { maxBytes: 100, onChunk: (_c, n) => seen.push(n) });
    assert.deepEqual(r, { ok: true, bytes: 12 });
    assert.deepEqual(seen, [5, 12], "onChunk sees the running total");
    assert.equal((await fs.readFile(part)).byteLength, 12);
    assert.deepEqual(await names(), ["a.part"], "complete, but still under its temporary name");
  });

  it("refuses past the cap by what arrived, cancels the transfer, and leaves no file", async () => {
    const part = path.join(dir, "b.part");
    // A fourth chunk still to come, so the stream is open when the cap is hit.
    const b = body([bytes(40), bytes(40), bytes(40), bytes(40)]);
    const r = await streamToPart(b.stream, part, { maxBytes: 100 });
    assert.equal(r.ok, false);
    assert.ok(b.cancelled());
    assert.deepEqual(await names(), []);
  });

  it("a stream that breaks part-way throws and leaves no file", async () => {
    const part = path.join(dir, "c.part");
    await assert.rejects(streamToPart(body([bytes(10)], "error").stream, part, { maxBytes: 100 }), /connection reset/);
    assert.deepEqual(await names(), []);
  });

  it("an onChunk that throws ends the download and leaves no file", async () => {
    const part = path.join(dir, "d.part");
    await assert.rejects(
      streamToPart(body([bytes(10), bytes(10)]).stream, part, {
        maxBytes: 100,
        onChunk: () => {
          throw new Error("refused by the caller");
        },
      }),
      /refused by the caller/,
    );
    assert.deepEqual(await names(), []);
  });

  it("exclusive refuses a file that is already there, and does not remove it; the default overwrites", async () => {
    const part = path.join(dir, "e.part");
    await fs.writeFile(part, "somebody else's");
    await assert.rejects(streamToPart(body([bytes(3)]).stream, part, { maxBytes: 100, exclusive: true }), /EEXIST/);
    assert.equal(await fs.readFile(part, "utf8"), "somebody else's");
    const r = await streamToPart(body([bytes(3)]).stream, part, { maxBytes: 100 });
    assert.equal(r.ok, true);
    assert.equal((await fs.readFile(part)).byteLength, 3);
  });
});

describe("commitPart", () => {
  it("makes the file visible under its real name, and the part name goes away", async () => {
    await fs.writeFile(path.join(dir, "f.part"), "done");
    await commitPart(path.join(dir, "f.part"), path.join(dir, "f"));
    assert.deepEqual(await names(), ["f"]);
  });

  it("a rename that fails removes the part and throws", async () => {
    await fs.writeFile(path.join(dir, "g.part"), "done");
    await fs.mkdir(path.join(dir, "g", "inside"), { recursive: true }); // a non-empty directory where the file goes
    await assert.rejects(commitPart(path.join(dir, "g.part"), path.join(dir, "g")));
    assert.deepEqual(await names(), ["g"], "no part left to be mistaken for a download in progress");
  });
});

describe("sha256OfFile", () => {
  it("hashes what is on disk", async () => {
    await fs.writeFile(path.join(dir, "h"), "abc");
    assert.equal(await sha256OfFile(path.join(dir, "h")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("downloadWatchdog", () => {
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("aborts after a quiet spell, with the reason", async () => {
    const w = downloadWatchdog({ idleMs: 30, totalMs: 10_000 });
    try {
      await settle(80);
      assert.ok(w.signal.aborted);
      assert.match((w.signal.reason as Error).message, /no data for 0\.03 s/);
    } finally {
      w.stop();
    }
  });

  it("a transfer that keeps moving is not aborted, however long it takes", async () => {
    const w = downloadWatchdog({ idleMs: 50, totalMs: 10_000 });
    try {
      for (let i = 0; i < 8; i++) {
        await settle(20);
        w.touch();
      }
      assert.ok(!w.signal.aborted, "160 ms of steady data against a 50 ms idle limit");
    } finally {
      w.stop();
    }
  });

  it("a transfer that trickles for ever is stopped by the ceiling", async () => {
    const w = downloadWatchdog({ idleMs: 200, totalMs: 60 });
    try {
      for (let i = 0; i < 6; i++) {
        await settle(20);
        w.touch();
      }
      assert.ok(w.signal.aborted);
      assert.match((w.signal.reason as Error).message, /still going after 0\.06 s/);
    } finally {
      w.stop();
    }
  });

  it("stop() leaves no timer live and never aborts afterwards", async () => {
    const live = new Set<NodeJS.Timeout>();
    const timers = {
      setTimeout: (fn: () => void, ms: number) => {
        const t = setTimeout(fn, ms);
        live.add(t);
        return t;
      },
      clearTimeout: (t: NodeJS.Timeout) => {
        live.delete(t);
        clearTimeout(t);
      },
    };
    const w = downloadWatchdog({ idleMs: 20, totalMs: 40, timers });
    assert.equal(live.size, 2);
    w.stop();
    assert.equal(live.size, 0);
    await settle(80);
    assert.ok(!w.signal.aborted);
  });
});
