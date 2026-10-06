import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

import type { MediaMtxAsset } from "./mediamtx-pin.js";
import { captureConsole } from "../fixtures/capture-console.js";

const execFileAsync = promisify(execFile);

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-relay-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { ensureBinary, relayArchivePresent, relayDir, VERSION_DIR_SHAPE } = await import("./acquire.js");
const { assetFor, MEDIAMTX_VERSION } = await import("./mediamtx-pin.js");

// No test here ever hits the network: every ensureBinary() call below passes
// its own fetchImpl (a spy, or one that reads bytes built in this file with
// the system tar). See mediamtx-pin.test cases in this file for the pin's own
// platform/arch lookup, unrelated to any of this.

const EXE = process.platform === "win32" ? "mediamtx.exe" : "mediamtx";
const KEY = `${process.platform}-${process.arch}`;

/** Reset the relay directory so one test's downloads/extracted binary can
 *  never be mistaken for another's — ensureBinary's very first checks are
 *  "is it already extracted" and "is there a hand-placed archive", and a file
 *  left over from a previous test would satisfy those before the behavior
 *  under test ever runs. */
async function resetRelayDir(): Promise<void> {
  await fs.rm(relayDir(), { recursive: true, force: true });
}

async function sha256File(p: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(p));
  return hash.digest("hex");
}

/** Builds a tar.gz containing one file (named `mediamtx`/`mediamtx.exe`, a
 *  small shell script) with the SYSTEM tar, exactly as a real MediaMTX
 *  release archive is laid out. Returns its path and real SHA-256. */
async function buildArchive(destDir: string, archiveName: string): Promise<{ archivePath: string; sha256: string }> {
  const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-relay-src-"));
  await fs.writeFile(path.join(srcDir, EXE), "#!/bin/sh\necho fake-mediamtx\n");
  await fs.chmod(path.join(srcDir, EXE), 0o755);
  await fs.mkdir(destDir, { recursive: true });
  const archivePath = path.join(destDir, archiveName);
  await execFileAsync("tar", ["-czf", archivePath, "-C", srcDir, EXE]);
  return { archivePath, sha256: await sha256File(archivePath) };
}

function asset(name: string, sha256: string): MediaMtxAsset {
  return { name, sha256, exe: EXE };
}

function throwIfCalled(): typeof fetch {
  return (() => {
    throw new Error("fetchImpl should not have been called");
  }) as unknown as typeof fetch;
}

test("assetFor: a known platform/arch resolves; an unknown one is null", () => {
  const known = assetFor("darwin", "arm64");
  assert.ok(known);
  assert.equal(known.name, "mediamtx_v1.21.1_darwin_arm64.tar.gz");
  assert.equal(known.exe, "mediamtx");
  assert.equal(assetFor("freebsd", "x64"), null);
  assert.equal(assetFor("win32", "arm64"), null);
});

test("no asset for this platform/arch: refused by name, no filesystem touched", async () => {
  await resetRelayDir();
  const result = await ensureBinary({ assets: new Map(), fetchImpl: throwIfCalled() });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, `Video relay is not available for ${process.platform} ${process.arch}.`);
  assert.equal(result.assetName, null, "no pinned asset exists for this platform — nothing to place by hand, ever");
  await assert.rejects(fs.access(path.join(relayDir(), "downloads")), "no filesystem touched");
});

test("a downloaded archive whose hash does not match is refused, deleted, and never extracted", async () => {
  await resetRelayDir();
  const downloadsDir = path.join(relayDir(), "downloads");
  const { archivePath } = await buildArchive(path.join(TMP, "src-mismatch"), "mediamtx-mismatch.tar.gz");
  const bytes = await fs.readFile(archivePath);
  const wrongSha = "0".repeat(64);
  const assets = new Map([[KEY, asset("mediamtx-mismatch.tar.gz", wrongSha)]]);

  let extractCalls = 0;
  const result = await ensureBinary({
    assets,
    fetchImpl: (async () => new Response(bytes)) as unknown as typeof fetch,
    extract: async () => {
      extractCalls++;
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /checksum mismatch for mediamtx-mismatch\.tar\.gz/);
  assert.match(result.reason, new RegExp(wrongSha));
  assert.equal(result.placeArchiveAt, downloadsDir, "the bare directory, not a path repeating the asset name");
  assert.equal(result.assetName, "mediamtx-mismatch.tar.gz", "a real asset exists — the archive can be placed by hand");
  assert.equal(extractCalls, 0, "extract must never run once the checksum fails");

  // Neither the final name nor the .part survive a failed verification.
  await assert.rejects(fs.access(path.join(downloadsDir, "mediamtx-mismatch.tar.gz")));
  await assert.rejects(fs.access(path.join(downloadsDir, "mediamtx-mismatch.tar.gz.part")));
});

// A checksum mismatch used to
// console.warn from INSIDE ensureBinary on every single call — 3 retries, 3
// (or, with the hand-placed check ALSO firing its own line, 4) lines for
// one ongoing failure. The caller (relay-lifecycle.ts) already owns "once
// per outage" logging from the returned `reason`; acquire.ts logging its
// own copy is a duplicate on every retry, not a second fact.
test("a checksum mismatch retried three times never logs from inside ensureBinary itself", async (t: TestContext) => {
  await resetRelayDir();
  const { archivePath } = await buildArchive(path.join(TMP, "src-mismatch-repeat"), "mediamtx-mismatch-repeat.tar.gz");
  const bytes = await fs.readFile(archivePath);
  const wrongSha = "0".repeat(64);
  const assets = new Map([[KEY, asset("mediamtx-mismatch-repeat.tar.gz", wrongSha)]]);
  const warns = captureConsole(t, "warn");

  for (let i = 0; i < 3; i++) {
    const result = await ensureBinary({
      assets,
      fetchImpl: (async () => new Response(bytes)) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
  }
  assert.deepEqual(warns, [], `ensureBinary itself must never log — got: ${JSON.stringify(warns)}`);
});

test("a hand-placed archive that matches is verified and extracted without calling fetchImpl", async () => {
  await resetRelayDir();
  const downloadsDir = path.join(relayDir(), "downloads");
  const { archivePath, sha256 } = await buildArchive(downloadsDir, "mediamtx-handplaced-ok.tar.gz");
  const assets = new Map([[KEY, asset("mediamtx-handplaced-ok.tar.gz", sha256)]]);

  let downloadStarts = 0;
  const result = await ensureBinary({ assets, fetchImpl: throwIfCalled(), onDownloadStart: () => downloadStarts++ });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const exePath = path.join(relayDir(), MEDIAMTX_VERSION, EXE);
  assert.equal(result.path, exePath);
  assert.equal((await fs.readFile(exePath, "utf8")), "#!/bin/sh\necho fake-mediamtx\n");
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(exePath)).mode & 0o777, 0o755);
  }
  // The archive itself is untouched — it was already in place.
  await fs.access(archivePath);
  assert.equal(downloadStarts, 0, "a verified hand-placed archive is not a download");
});

test("a hand-placed archive that does not match is refused, named in the reason, and left in place", async () => {
  await resetRelayDir();
  const downloadsDir = path.join(relayDir(), "downloads");
  const { archivePath } = await buildArchive(downloadsDir, "mediamtx-handplaced-bad.tar.gz");
  const wrongSha = "f".repeat(64);
  const assets = new Map([[KEY, asset("mediamtx-handplaced-bad.tar.gz", wrongSha)]]);

  const result = await ensureBinary({ assets, fetchImpl: throwIfCalled() });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.reason.includes(archivePath), "the operator's file path must be named in the reason");
  assert.match(result.reason, /does not match the pinned checksum/);
  assert.equal(result.placeArchiveAt, downloadsDir, "the bare directory, not a path repeating the asset name");
  assert.equal(result.assetName, "mediamtx-handplaced-bad.tar.gz");
  // The operator's file is never deleted, matched or not.
  await fs.access(archivePath);
});

test("an already-extracted binary is used as-is, with no fetch", async () => {
  await resetRelayDir();
  const versionDir = path.join(relayDir(), MEDIAMTX_VERSION);
  await fs.mkdir(versionDir, { recursive: true });
  const exePath = path.join(versionDir, EXE);
  await fs.writeFile(exePath, "#!/bin/sh\necho already-here\n");
  await fs.chmod(exePath, 0o755);
  // A deliberately bogus pin entry — must never be consulted once the binary
  // already exists.
  const assets = new Map([[KEY, asset("never-fetched.tar.gz", "a".repeat(64))]]);

  const result = await ensureBinary({ assets, fetchImpl: throwIfCalled() });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.path, exePath);
});

// A binary is trusted only once it is there to run: a version directory left
// half-written (the server stopped mid-extract) or holding a file that lost
// its mode is removed and extracted again, and an extract lands in place in
// one rename, so a crash can never leave a partial one under the real name.

test("a version directory with no usable binary is removed and extracted again", async () => {
  await resetRelayDir();
  const downloadsDir = path.join(relayDir(), "downloads");
  const { sha256 } = await buildArchive(downloadsDir, "mediamtx-partial.tar.gz");
  const assets = new Map([[KEY, asset("mediamtx-partial.tar.gz", sha256)]]);
  const versionDir = path.join(relayDir(), MEDIAMTX_VERSION);
  await fs.mkdir(versionDir, { recursive: true });
  const exePath = path.join(versionDir, EXE);
  await fs.writeFile(exePath, ""); // a crash mid-extract: the name, no bytes
  await fs.writeFile(path.join(versionDir, "stray"), "left by the interrupted extract");

  const result = await ensureBinary({ assets, fetchImpl: throwIfCalled() });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await fs.readFile(exePath, "utf8"), "#!/bin/sh\necho fake-mediamtx\n");
  await assert.rejects(fs.access(path.join(versionDir, "stray")), "the partial extract must be removed, not merged into");
});

test(
  "a binary that is there but not executable is not trusted",
  { skip: process.platform === "win32" ? "no execute bit on win32" : false },
  async () => {
    await resetRelayDir();
    const downloadsDir = path.join(relayDir(), "downloads");
    const { sha256 } = await buildArchive(downloadsDir, "mediamtx-nox.tar.gz");
    const assets = new Map([[KEY, asset("mediamtx-nox.tar.gz", sha256)]]);
    const versionDir = path.join(relayDir(), MEDIAMTX_VERSION);
    await fs.mkdir(versionDir, { recursive: true });
    const exePath = path.join(versionDir, EXE);
    await fs.writeFile(exePath, "#!/bin/sh\necho lost-its-mode\n");
    await fs.chmod(exePath, 0o644);

    const result = await ensureBinary({ assets, fetchImpl: throwIfCalled() });
    assert.equal(result.ok, true, JSON.stringify(result));
    // One handle for both reads, so the mode and the contents are of the same file.
    const exe = await fs.open(exePath);
    try {
      assert.equal((await exe.stat()).mode & 0o777, 0o755);
      assert.equal(await exe.readFile("utf8"), "#!/bin/sh\necho fake-mediamtx\n");
    } finally {
      await exe.close();
    }
  },
);

test("an extract that fails partway leaves nothing under the version's name", async () => {
  await resetRelayDir();
  const downloadsDir = path.join(relayDir(), "downloads");
  const { sha256 } = await buildArchive(downloadsDir, "mediamtx-midway.tar.gz");
  const assets = new Map([[KEY, asset("mediamtx-midway.tar.gz", sha256)]]);
  const result = await ensureBinary({
    assets,
    fetchImpl: throwIfCalled(),
    extract: async (_archive, destDir, member) => {
      await fs.mkdir(destDir, { recursive: true });
      await fs.writeFile(path.join(destDir, member), "#!/bin/sh\n"); // half the file
      throw new Error("tar: Unexpected EOF in archive");
    },
  });
  assert.equal(result.ok, false);
  await assert.rejects(fs.access(path.join(relayDir(), MEDIAMTX_VERSION)), "a failed extract left a version directory behind");
  const leftovers = (await fs.readdir(relayDir())).filter((n) => n !== "downloads");
  assert.deepEqual(leftovers, [], `a failed extract left its staging behind: ${leftovers.join(", ")}`);
});

// ensureBinary's contract is "every failure returns, never throws" — the
// relay's status is built from what it returns.
test("a filesystem failure outside the steps with their own handling is returned, not thrown", async () => {
  await resetRelayDir();
  await fs.mkdir(relayDir(), { recursive: true });
  await fs.writeFile(path.join(relayDir(), "downloads"), "a file where the downloads folder goes");
  const assets = new Map([[KEY, asset("mediamtx-nodir.tar.gz", "b".repeat(64))]]);
  const result = await ensureBinary({ assets, fetchImpl: (async () => new Response("x")) as unknown as typeof fetch });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /could not set up MediaMTX/);
  assert.equal(result.assetName, "mediamtx-nodir.tar.gz");
});

test("a failing extract step is reported, not thrown, and leaves no binary behind", async () => {
  await resetRelayDir();
  const downloadsDir = path.join(relayDir(), "downloads");
  const { sha256 } = await buildArchive(downloadsDir, "mediamtx-extract-fails.tar.gz");
  const assets = new Map([[KEY, asset("mediamtx-extract-fails.tar.gz", sha256)]]);

  const result = await ensureBinary({
    assets,
    fetchImpl: throwIfCalled(),
    extract: async () => {
      throw new Error("tar exploded");
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /extracting mediamtx-extract-fails\.tar\.gz failed: tar exploded/);
  assert.equal(result.placeArchiveAt, downloadsDir, "the bare directory, not a path repeating the asset name");
  await assert.rejects(fs.access(path.join(relayDir(), MEDIAMTX_VERSION, EXE)));
});

test(
  "a failing chmod is reported, not thrown",
  { skip: process.platform === "win32" ? "chmod is never run on win32" : false },
  async () => {
    await resetRelayDir();
    const downloadsDir = path.join(relayDir(), "downloads");
    const { sha256 } = await buildArchive(downloadsDir, "mediamtx-chmod-fails.tar.gz");
    const assets = new Map([[KEY, asset("mediamtx-chmod-fails.tar.gz", sha256)]]);

    const result = await ensureBinary({
      assets,
      fetchImpl: throwIfCalled(),
      // Resolves without writing the exe — the same seam as the extract-failure
      // test above, used here to put chmod's target path in a state (missing)
      // that makes the REAL chmod() reject with ENOENT, rather than adding a
      // chmod seam nothing else in this file needs.
      extract: async () => {},
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /could not make .*mediamtx.* executable/);
  },
);

test("a fresh download that matches the pin is verified, extracted, and made executable", async () => {
  await resetRelayDir();
  const downloadsDir = path.join(relayDir(), "downloads");
  const { archivePath, sha256 } = await buildArchive(path.join(TMP, "src-happy"), "mediamtx-happy.tar.gz");
  const bytes = await fs.readFile(archivePath);
  const assets = new Map([[KEY, asset("mediamtx-happy.tar.gz", sha256)]]);

  const progress: Array<[number, number]> = [];
  let downloadStarts = 0;
  const result = await ensureBinary({
    assets,
    fetchImpl: (async (url: string) => {
      assert.ok(url.includes("mediamtx-happy.tar.gz"));
      return new Response(bytes);
    }) as unknown as typeof fetch,
    onProgress: (received, total) => progress.push([received, total]),
    onDownloadStart: () => downloadStarts++,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const exePath = path.join(relayDir(), MEDIAMTX_VERSION, EXE);
  assert.equal(result.path, exePath);
  assert.equal((await fs.readFile(exePath, "utf8")), "#!/bin/sh\necho fake-mediamtx\n");
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(exePath)).mode & 0o777, 0o755);
  }
  // The verified archive is left behind under its real name; no .part survives.
  assert.equal(await sha256File(path.join(downloadsDir, "mediamtx-happy.tar.gz")), sha256);
  await assert.rejects(fs.access(path.join(downloadsDir, "mediamtx-happy.tar.gz.part")));
  assert.ok(progress.length > 0, "onProgress must fire at least once");
  assert.equal(progress[progress.length - 1][0], bytes.byteLength);
  assert.equal(downloadStarts, 1, "onDownloadStart must fire exactly once for a real download");
});

/** A fetch whose body arrives in `pieces` slices, one every `gapMs`, erroring
 *  when the request's signal aborts, as a real one does. With `stallAfter`
 *  the body goes quiet after that many slices and never ends; with `forever`
 *  it keeps handing out the first slice's size without end. */
function slowFetch(
  bytes: Buffer,
  { pieces, gapMs, stallAfter, forever }: { pieces: number; gapMs: number; stallAfter?: number; forever?: boolean },
): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    const size = Math.ceil(bytes.byteLength / pieces);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason));
      },
      async pull(controller) {
        if (sent === stallAfter) return new Promise<void>(() => {});
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        if (signal?.aborted) return;
        if (!forever && sent * size >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(forever ? new Uint8Array(size) : bytes.subarray(sent * size, (sent + 1) * size));
        sent++;
      },
    });
    return new Response(stream);
  }) as unknown as typeof fetch;
}

test("a slow but steady download finishes: only a stall counts, not the total time", async () => {
  await resetRelayDir();
  const { archivePath, sha256 } = await buildArchive(path.join(TMP, "src-slow"), "mediamtx-slow.tar.gz");
  const bytes = await fs.readFile(archivePath);
  const assets = new Map([[KEY, asset("mediamtx-slow.tar.gz", sha256)]]);

  // 8 slices 60 ms apart is ~480 ms in all, far past the 200 ms idle limit,
  // yet never quiet for as long as it.
  const result = await ensureBinary({
    assets,
    fetchImpl: slowFetch(bytes, { pieces: 8, gapMs: 60 }),
    downloadTimeouts: { idleMs: 200, totalMs: 10_000 },
  });
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
});

test("a download that returns leaves neither watchdog timer running, on success or failure", async () => {
  // The ceiling timer is an hour long. If stop() is skipped it is the only thing
  // holding the process open, which showed up as the suite HANGING rather than
  // failing. Counting the live timers turns that into an assertion.
  const live = new Set<NodeJS.Timeout>();
  const timers = {
    setTimeout: (fn: () => void, ms: number): NodeJS.Timeout => {
      const handle: NodeJS.Timeout = setTimeout(() => {
        live.delete(handle);
        fn();
      }, ms);
      live.add(handle);
      return handle;
    },
    clearTimeout: (handle: NodeJS.Timeout): void => {
      live.delete(handle);
      clearTimeout(handle);
    },
  };

  await resetRelayDir();
  const { archivePath, sha256 } = await buildArchive(path.join(TMP, "src-timers"), "mediamtx-timers.tar.gz");
  const bytes = await fs.readFile(archivePath);
  const assets = new Map([[KEY, asset("mediamtx-timers.tar.gz", sha256)]]);

  try {
    const ok = await ensureBinary({
      assets,
      fetchImpl: slowFetch(bytes, { pieces: 3, gapMs: 5 }),
      downloadTimeouts: { idleMs: 5_000, totalMs: 3_600_000, timers },
    });
    assert.equal(ok.ok, true, ok.ok ? "" : ok.reason);
    assert.equal(live.size, 0, `a finished download left ${live.size} watchdog timer(s) running`);

    await resetRelayDir();
    const failed = await ensureBinary({
      assets: new Map([[KEY, asset("mediamtx-timers-stall.tar.gz", "d".repeat(64))]]),
      fetchImpl: slowFetch(bytes, { pieces: 3, gapMs: 5, stallAfter: 1 }),
      downloadTimeouts: { idleMs: 100, totalMs: 3_600_000, timers },
    });
    assert.equal(failed.ok, false);
    assert.equal(live.size, 0, `an abandoned download left ${live.size} watchdog timer(s) running`);
  } finally {
    for (const handle of live) clearTimeout(handle); // a failing run must not hold the process either
  }
});

test("a download that goes quiet is abandoned, and no .part is left", { timeout: 5000 }, async () => {
  await resetRelayDir();
  const downloadsDir = path.join(relayDir(), "downloads");
  const { archivePath, sha256 } = await buildArchive(path.join(TMP, "src-stall"), "mediamtx-stall.tar.gz");
  const bytes = await fs.readFile(archivePath);
  const assets = new Map([[KEY, asset("mediamtx-stall.tar.gz", sha256)]]);

  const result = await ensureBinary({
    assets,
    fetchImpl: slowFetch(bytes, { pieces: 8, gapMs: 10, stallAfter: 3 }),
    downloadTimeouts: { idleMs: 150, totalMs: 10_000 },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /no data for 0\.15 s/);
  await assert.rejects(fs.access(path.join(downloadsDir, "mediamtx-stall.tar.gz.part")));
});

test("a download that never idles still ends at the overall ceiling", { timeout: 5000 }, async () => {
  await resetRelayDir();
  const assets = new Map([[KEY, asset("mediamtx-endless.tar.gz", "c".repeat(64))]]);

  const result = await ensureBinary({
    assets,
    fetchImpl: slowFetch(Buffer.alloc(1024), { pieces: 1, gapMs: 20, forever: true }),
    downloadTimeouts: { idleMs: 1000, totalMs: 300 },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /still going after 0\.3 s/);
});

test("a download over 64 MB is refused by actual bytes received, not a spoofed Content-Length", async () => {
  await resetRelayDir();
  const downloadsDir = path.join(relayDir(), "downloads");
  const assets = new Map([[KEY, asset("mediamtx-oversized.tar.gz", "b".repeat(64))]]);

  const CHUNK = 8 * 1024 * 1024;
  let cancelled = false;
  // pull(), not start(): the source keeps handing over 8 MB chunks for as
  // long as the reader keeps asking, and never closes on its own — the shape
  // of a run-away or malicious response. That is what makes reader.cancel()
  // below a real assertion: a source that had already closed itself (as a
  // start()-enqueued-and-closed stream would, after 9 reads) would not call
  // this cancel() at all, so the test could pass with no cancel ever wired.
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(CHUNK));
    },
    cancel() {
      cancelled = true;
    },
  });

  const result = await ensureBinary({
    assets,
    fetchImpl: (async () =>
      // Content-Length lies (well under the cap) — the guard must not trust it.
      new Response(stream, { status: 200, headers: { "content-length": "1000" } })) as unknown as typeof fetch,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /exceeded 67108864 bytes/);
  assert.equal(cancelled, true, "the over-cap stream must be cancelled, not read to completion");
  await assert.rejects(fs.access(path.join(downloadsDir, "mediamtx-oversized.tar.gz")));
  await assert.rejects(fs.access(path.join(downloadsDir, "mediamtx-oversized.tar.gz.part")));
});

test("relayArchivePresent: the pinned archive in video-relay/downloads, whether or not it is extracted", async (t) => {
  await resetRelayDir();
  const pinned = assetFor(process.platform, process.arch);
  if (!pinned) {
    t.skip("no pinned asset for this platform");
    return;
  }
  assert.equal(await relayArchivePresent(), false);
  await fs.mkdir(path.join(relayDir(), "downloads"), { recursive: true });
  await fs.writeFile(path.join(relayDir(), "downloads", pinned.name), "placed by hand");
  assert.equal(await relayArchivePresent(), true);
});

// A pin bump leaves the earlier version's directory and archive behind. Once
// the pinned binary is in place they are removed, and nothing else is.

async function seedOldRelay(): Promise<{ oldVersionDir: string; oldArchive: string; keep: string[] }> {
  const root = relayDir();
  const oldVersionDir = path.join(root, "v0.0.1");
  await fs.mkdir(oldVersionDir, { recursive: true });
  await fs.writeFile(path.join(oldVersionDir, EXE), "x".repeat(2048));
  const downloads = path.join(root, "downloads");
  await fs.mkdir(downloads, { recursive: true });
  const oldArchive = path.join(downloads, "mediamtx_v0.0.1_linux_amd64.tar.gz");
  await fs.writeFile(oldArchive, "y".repeat(4096));
  const keep = [
    path.join(root, "mediamtx.yml"),
    path.join(root, "relay.pid"),
    path.join(root, "notes.txt"),
    path.join(downloads, "README.txt"),
    path.join(root, "v0.0.2.partial", "stray"),
    path.join(root, "logs", "relay.log"),
  ];
  for (const f of keep) {
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, "operator");
  }
  return { oldVersionDir, oldArchive, keep };
}

test("the pin's version string has the shape the old-version sweep matches", () => {
  assert.match(MEDIAMTX_VERSION, VERSION_DIR_SHAPE, "a pin the sweep cannot recognise would leave every old version in place");
});

test("once the pinned binary is in place, an old version directory and archive are removed and nothing else", async (t: TestContext) => {
  await resetRelayDir();
  const { oldVersionDir, oldArchive, keep } = await seedOldRelay();
  const downloadsDir = path.join(relayDir(), "downloads");
  const { sha256 } = await buildArchive(downloadsDir, "mediamtx-current.tar.gz");
  const assets = new Map([[KEY, asset("mediamtx-current.tar.gz", sha256)]]);
  const logs = captureConsole(t, "log", "warn");

  const result = await ensureBinary({ assets, fetchImpl: throwIfCalled() });

  assert.equal(result.ok, true, JSON.stringify(result));
  await assert.rejects(fs.access(oldVersionDir), "the old version directory is removed");
  await assert.rejects(fs.access(oldArchive), "the old archive is removed");
  await fs.access(path.join(relayDir(), MEDIAMTX_VERSION, EXE));
  await fs.access(path.join(downloadsDir, "mediamtx-current.tar.gz")); // the current pin's own archive stays
  for (const f of keep) await fs.access(f); // config, pid, logs, a staging dir, an unrelated file
  assert.equal(logs.length, 1, JSON.stringify(logs));
  assert.match(logs[0] ?? "", /^\[video\] removed old relay files \(v0\.0\.1, downloads[\\/]mediamtx_v0\.0\.1_linux_amd64\.tar\.gz\), freeing 6 kB$/);
});

test("the sweep also runs when the pinned binary was already extracted, and says nothing when there is nothing to remove", async (t: TestContext) => {
  await resetRelayDir();
  const versionDir = path.join(relayDir(), MEDIAMTX_VERSION);
  await fs.mkdir(versionDir, { recursive: true });
  const exePath = path.join(versionDir, EXE);
  await fs.writeFile(exePath, "#!/bin/sh\necho already-here\n");
  await fs.chmod(exePath, 0o755);
  const assets = new Map([[KEY, asset("never-fetched.tar.gz", "a".repeat(64))]]);
  const logs = captureConsole(t, "log", "warn");

  assert.equal((await ensureBinary({ assets, fetchImpl: throwIfCalled() })).ok, true);
  assert.deepEqual(logs, [], "nothing old to remove: no log line");

  const { oldVersionDir } = await seedOldRelay();
  assert.equal((await ensureBinary({ assets, fetchImpl: throwIfCalled() })).ok, true);
  await assert.rejects(fs.access(oldVersionDir));
  assert.equal(logs.length, 1, JSON.stringify(logs));
});

test("a failed acquire removes nothing", async () => {
  await resetRelayDir();
  const { oldVersionDir, oldArchive } = await seedOldRelay();
  const downloadsDir = path.join(relayDir(), "downloads");
  await buildArchive(downloadsDir, "mediamtx-wrong-sum.tar.gz");
  const assets = new Map([[KEY, asset("mediamtx-wrong-sum.tar.gz", "0".repeat(64))]]);

  const result = await ensureBinary({ assets, fetchImpl: throwIfCalled() });

  assert.equal(result.ok, false);
  await fs.access(oldVersionDir);
  await fs.access(oldArchive);
});

test("a removal that fails is logged, the rest are still removed, and ensureBinary still succeeds", async (t: TestContext) => {
  await resetRelayDir();
  const { oldVersionDir, oldArchive } = await seedOldRelay();
  const downloadsDir = path.join(relayDir(), "downloads");
  const { sha256 } = await buildArchive(downloadsDir, "mediamtx-current.tar.gz");
  const assets = new Map([[KEY, asset("mediamtx-current.tar.gz", sha256)]]);
  const logs = captureConsole(t, "log", "warn");

  const result = await ensureBinary({
    assets,
    fetchImpl: throwIfCalled(),
    remove: async (p) => {
      if (p === oldVersionDir) throw new Error("EBUSY: in use");
      await fs.rm(p, { recursive: true, force: true });
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  await fs.access(oldVersionDir); // could not be removed
  await assert.rejects(fs.access(oldArchive)); // was
  assert.equal(logs.length, 2, JSON.stringify(logs));
  assert.match(logs[0] ?? "", /^\[video\] could not remove old relay file v0\.0\.1: EBUSY: in use$/);
  assert.match(logs[1] ?? "", /^\[video\] removed old relay files \(downloads[\\/]mediamtx_v0\.0\.1_linux_amd64\.tar\.gz\)/);
});
