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
const { ensureBinary, relayArchivePresent, relayDir } = await import("./acquire.js");
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
