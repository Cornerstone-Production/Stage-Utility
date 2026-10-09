// Guards for the two ways a stage plot failed to appear on an open display: a
// signed PCO link that expired inside its cache window (403 → "Couldn't load
// file", no retry), and two surfaces missing the disk cache at the same instant
// and writing the same file in place, so a third reader read truncated bytes.
//
// The download path is exercised for real — a stubbed global fetch, the real
// cache dir under a temp STAGE_UTILITY_DATA, and the bytes read back off disk.

import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, mock, test } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "attach-cache-"));
process.env.STAGE_UTILITY_DATA = dataDir;

// Imported only after the data dir is set — getUserDataPath() memoises on first call.
const { attachmentEtag, attachmentVersion, etagMatches, getAttachmentFile } = await import("./pco-attachment-cache.js");

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

  // Planning Center's stage-plot attachment id carries a suffix ("84892470-stage").
  // The cache names the file after the id, so the suffix has to survive the name
  // and the same id has to find the same file on the next request.
  test("a suffixed id is stored under its own name and read back from disk", async (t) => {
    t.after(() => {
      globalThis.fetch = realFetch;
    });
    const payload = Buffer.from("%PDF-1.7 stage plot");
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return resp(200, payload);
    }) as typeof fetch;

    const first = await getAttachmentFile("84892470-stage", "application/pdf", "2026.10.08 Stage Plot.pdf", async () => "https://example.invalid/signed");
    assert.ok(first);
    assert.equal(first.path, path.join(cacheDir, "84892470-stage.pdf"));
    assert.deepEqual(await fs.readFile(first.path), payload);

    const again = await getAttachmentFile("84892470-stage", "application/pdf", "2026.10.08 Stage Plot.pdf", async () => {
      throw new Error("a cached attachment must not open a new link");
    });
    assert.equal(again?.path, first.path);
    assert.equal(fetches, 1, "the second request must be served from disk");

    // The digits-only id is a different file, not the same one with the suffix dropped.
    const plain = await getAttachmentFile("84892470", "application/pdf", "other.pdf", async () => "https://example.invalid/signed");
    assert.equal(plain?.path, path.join(cacheDir, "84892470.pdf"));
  });
});

// A display asks again for a file it could not get, so one failing attachment
// wrote a line (with a stack, for a thrown error) per request per display. It is
// now one line per distinct failure, naming the file and the reason.
describe("attachment cache logging", () => {
  function capture(t: { after: (fn: () => void) => void }) {
    const errors: string[] = [];
    const logs: string[] = [];
    const warns: string[] = [];
    mock.method(console, "error", (...a: unknown[]) => { errors.push(a.map(String).join(" ")); });
    mock.method(console, "log", (...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    mock.method(console, "warn", (...a: unknown[]) => { warns.push(a.map(String).join(" ")); });
    t.after(() => {
      mock.restoreAll();
      globalThis.fetch = realFetch;
    });
    return { errors, logs, warns };
  }

  test("a refused id is one line naming the file and why, however many displays ask", async (t) => {
    const out = capture(t);
    const refuse = async () => {
      throw new Error("attachmentId is not a Planning Center attachment id");
    };
    for (let i = 0; i < 8; i++) {
      const file = await getAttachmentFile("log-refused", "application/pdf", "Stage Plot.pdf", refuse);
      assert.equal(file, null);
    }
    assert.equal(out.errors.length, 1, `expected one line for eight identical failures, got:\n${out.errors.join("\n")}`);
    assert.match(out.errors[0], /^\[attachment-cache\] could not get "Stage Plot\.pdf" \(attachment log-refused\): attachmentId is not a Planning Center attachment id$/);
    assert.doesNotMatch(out.errors[0], /\n\s+at /, "a stack on every request is what this replaced");
  });

  test("a different reason for the same file is a new line, the same HTTP failure is not", async (t) => {
    const out = capture(t);
    globalThis.fetch = (async () => resp(500)) as typeof fetch;
    const open = async () => "https://example.invalid/signed";
    for (let i = 0; i < 5; i++) await getAttachmentFile("log-http", "application/pdf", "plot.pdf", open);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0], /"plot\.pdf" \(attachment log-http\): the download link answered HTTP 500/);

    await getAttachmentFile("log-http", "application/pdf", "plot.pdf", async () => { throw new Error("PCO did not return a download URL for this attachment"); });
    assert.equal(out.errors.length, 2, "a new reason must be said");
    assert.match(out.errors[1], /PCO did not return a download URL/);
  });

  test("a link that is dead every time says so once, not on every request", async (t) => {
    const out = capture(t);
    globalThis.fetch = (async () => resp(403)) as typeof fetch;
    for (let i = 0; i < 5; i++) {
      await getAttachmentFile("log-dead-link", "application/pdf", "plot.pdf", async () => "https://example.invalid/signed");
    }
    assert.equal(out.errors.length, 1, `errors: ${out.errors.join(" | ")}`);
    assert.equal(out.warns.length, 1, `five requests on a dead link wrote ${out.warns.length} re-open warnings`);
  });

  test("an attachment id with a newline cannot forge a second line either", async (t) => {
    const out = capture(t);
    globalThis.fetch = (async () => resp(403)) as typeof fetch;
    await getAttachmentFile("log-id\n[pco] forged", "application/pdf", "plot.pdf", async () => "https://example.invalid/signed");
    assert.equal(out.errors.length, 1);
    assert.equal(out.warns.length, 1);
    for (const line of [...out.errors, ...out.warns]) {
      assert.ok(!line.includes("\n"), `the attachment id reached the log unescaped: ${JSON.stringify(line)}`);
    }
  });

  test("two attachments failing are two outages, each said once", async (t) => {
    const out = capture(t);
    const refuse = async () => { throw new Error("same reason for both"); };
    for (let i = 0; i < 4; i++) {
      await getAttachmentFile("log-iso-a", "application/pdf", "a.pdf", refuse);
      await getAttachmentFile("log-iso-b", "application/pdf", "b.pdf", refuse);
    }
    assert.equal(out.errors.length, 2, `expected one line per attachment, got:\n${out.errors.join("\n")}`);
    assert.ok(out.errors.some((l) => l.includes("log-iso-a") && l.includes('"a.pdf"')));
    assert.ok(out.errors.some((l) => l.includes("log-iso-b") && l.includes('"b.pdf"')));
  });

  test("a file name with a newline cannot forge a second line", async (t) => {
    const out = capture(t);
    await getAttachmentFile("log-forge", "application/pdf", "a\n[pco] forged.pdf", async () => { throw new Error("nope"); });
    assert.equal(out.errors.length, 1);
    assert.ok(!out.errors[0].includes("\n"), "the file name reached the log unescaped");
  });

  test("says once when a failing file downloads again", async (t) => {
    const out = capture(t);
    mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    t.after(() => mock.timers.reset());
    const open = async () => "https://example.invalid/signed";

    globalThis.fetch = (async () => resp(403)) as typeof fetch;
    await getAttachmentFile("log-recover", "application/pdf", "plot.pdf", open);
    assert.equal(out.errors.length, 1);

    // The recovery is announced only after the success has held for the settle
    // window, so a flapping link is one outage; the first success inside it is quiet.
    globalThis.fetch = (async () => resp(200, Buffer.from("%PDF-1.7 ok"))) as typeof fetch;
    mock.timers.tick(5_000);
    await getAttachmentFile("log-recover", "application/pdf", "plot.pdf", open);
    assert.deepEqual(out.logs.filter((l) => l.includes("downloading again")), [], "announced a recovery inside the settle window");
    // The file stays on disk, so every later request is a cache hit that never
    // reaches the download. A hit has to be what ends the run.
    assert.ok(await fs.stat(path.join(cacheDir, "log-recover.pdf")));
    globalThis.fetch = (async () => { throw new Error("a cached file must not be fetched"); }) as typeof fetch;
    mock.timers.tick(3 * 60_000);
    await getAttachmentFile("log-recover", "application/pdf", "plot.pdf", async () => { throw new Error("a cached file must not open a link"); });
    const said = out.logs.filter((l) => l.includes("downloading again"));
    assert.equal(said.length, 1, `expected one recovery line, got ${said.length}`);
    assert.match(said[0], /"plot\.pdf" \(attachment log-recover\) is downloading again/);
  });
});

// Not known: whether Planning Center keeps an attachment's id when a stage plot is
// re-uploaded. The cache is keyed by id AND version so that, if it does, the
// replaced file is downloaded rather than served from the old bytes.
describe("attachment cache and a replaced file", () => {
  const open = async () => "https://example.invalid/signed";
  const serve = (bytes: Buffer) => {
    let fetches = 0;
    globalThis.fetch = (async () => { fetches += 1; return resp(200, bytes); }) as typeof fetch;
    return () => fetches;
  };
  const files = async (prefix: string) => (await fs.readdir(cacheDir)).filter((n) => n.startsWith(prefix)).sort();

  test("the same id at a newer version is downloaded fresh, and the old version is removed", async (t) => {
    t.after(() => { globalThis.fetch = realFetch; });
    const v1 = attachmentVersion("2026-10-08T14:00:00Z", 10);
    const v2 = attachmentVersion("2026-10-08T15:30:00Z", 12);
    assert.notEqual(v1, v2);

    const fetches = serve(Buffer.from("old plot"));
    const first = await getAttachmentFile("rep-1", "application/pdf", "plot.pdf", open, v1);
    assert.deepEqual(await fs.readFile(first!.path), Buffer.from("old plot"));
    await getAttachmentFile("rep-1", "application/pdf", "plot.pdf", open, v1);
    assert.equal(fetches(), 1, "the same version must be served from disk");

    serve(Buffer.from("new plot"));
    const second = await getAttachmentFile("rep-1", "application/pdf", "plot.pdf", open, v2);
    assert.notEqual(second!.path, first!.path);
    assert.deepEqual(await fs.readFile(second!.path), Buffer.from("new plot"), "a replaced file was served from the old bytes");
    assert.deepEqual(await files("rep-1"), [path.basename(second!.path)], "the old version was left on disk");
  });

  test("removing old versions leaves other ids alone, including one that shares a prefix", async (t) => {
    t.after(() => { globalThis.fetch = realFetch; });
    serve(Buffer.from("x"));
    await getAttachmentFile("pre-1", "application/pdf", "a.pdf", open, "t1");
    await getAttachmentFile("pre-1-stage", "application/pdf", "b.pdf", open, "t1");
    await getAttachmentFile("pre-12", "application/pdf", "c.pdf", open, "t1");
    await getAttachmentFile("pre-1", "application/pdf", "a.pdf", open, "t2");
    assert.deepEqual(await files("pre-1"), ["pre-1-stage.t1.pdf", "pre-1.t2.pdf", "pre-12.t1.pdf"]);
  });

  test("a v1.25.0 file (<id>.<ext>, no version) is replaced by the versioned download and pruned in the same call", async (t) => {
    t.after(() => { globalThis.fetch = realFetch; });
    await fs.writeFile(path.join(cacheDir, "legacy-1.pdf"), "legacy bytes");
    const fetches = serve(Buffer.from("versioned bytes"));
    const file = await getAttachmentFile("legacy-1", "application/pdf", "plot.pdf", open, "t5");
    assert.equal(fetches(), 1, "the unversioned file was served for a versioned request");
    assert.deepEqual(await fs.readFile(file!.path), Buffer.from("versioned bytes"));
    assert.deepEqual(await files("legacy-1"), ["legacy-1.t5.pdf"], "the legacy file was left on disk");
  });

  test("failing to look for older copies does not fail the download", async (t) => {
    t.after(() => { globalThis.fetch = realFetch; mock.restoreAll(); syncBuiltinESMExports(); });
    const warns: string[] = [];
    mock.method(console, "warn", (...a: unknown[]) => { warns.push(a.map(String).join(" ")); });
    serve(Buffer.from("bytes"));
    const realReaddir = fsp.readdir;
    mock.method(fsp, "readdir", async (...args: Parameters<typeof realReaddir>) => {
      if (String(args[0]) === cacheDir) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return realReaddir(...args);
    });
    syncBuiltinESMExports();
    const file = await getAttachmentFile("prune-fail-1", "application/pdf", "plot.pdf", open, "t1");
    assert.ok(file, "a prune failure turned a good download into a failure");
    assert.deepEqual(await fs.readFile(file.path), Buffer.from("bytes"));
    assert.equal(warns.length, 1);
    assert.match(warns[0], /could not look for older copies .*EACCES.* of "plot\.pdf"/);
  });

  test("a version cannot put anything but a name in the file name", async (t) => {
    t.after(() => { globalThis.fetch = realFetch; });
    serve(Buffer.from("x"));
    const file = await getAttachmentFile("safe-1", "application/pdf", "a.pdf", open, "../../x/..");
    assert.equal(path.dirname(file!.path), cacheDir);
  });

  test("version: updated_at, else size, else nothing; only [a-z0-9]", () => {
    assert.equal(attachmentVersion("2026-10-08T14:00:00Z", 10), `t${Date.parse("2026-10-08T14:00:00Z")}`);
    assert.equal(attachmentVersion(null, 10), "s10");
    assert.equal(attachmentVersion("not a date", 10), "s10");
    assert.equal(attachmentVersion(null, null), "");
    assert.match(attachmentVersion("2026-10-08T14:00:00.123Z", null), /^[a-z0-9]+$/);
  });

  test("etag names the id and version; If-None-Match matches it, a weak copy of it and *", () => {
    const e = attachmentEtag("84892470-stage", "t1");
    assert.equal(e, '"84892470-stage.t1"');
    assert.equal(attachmentEtag("1", ""), '"1"');
    assert.notEqual(attachmentEtag("1", "t1"), attachmentEtag("1", "t2"));
    assert.equal(etagMatches(e, e), true);
    assert.equal(etagMatches(`W/${e}`, e), true);
    assert.equal(etagMatches(`"other", ${e}`, e), true);
    assert.equal(etagMatches("*", e), true);
    assert.equal(etagMatches('"84892470-stage.t0"', e), false);
    assert.equal(etagMatches(undefined, e), false);
    assert.equal(etagMatches("", e), false);
  });
});
