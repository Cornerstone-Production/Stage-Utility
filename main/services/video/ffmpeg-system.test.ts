import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";

import { captureConsole } from "../fixtures/capture-console.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-ffmpeg-system-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
const { createFfmpegFinder, findFfmpeg, installHint, namesFfmpeg, parseFfmpegPath, publicFfmpegStatus, RECHECK_AFTER_MS, setFfmpegPath } = await import("./ffmpeg-system.js");
const { loadFfmpegPath } = await import("./ffmpeg-path-store.js");

// A fake ffmpeg is a shell script that answers the five commands the check
// runs from files beside it and appends a line to `<script>.calls` each time it
// is run, so a test can count invocations. Not on Windows (no sh).
const SKIP = process.platform === "win32" ? "needs a POSIX shell" : false;

const CAPABLE = {
  decoders: " A....D aac                  AAC (Advanced Audio Coding)\n",
  encoders: " A....D libopus              libopus Opus (codec opus)\n",
  protocols: "Supported file protocols:\nInput:\n  file\n  http\n  tcp\nOutput:\n  file\n  tcp\n",
  muxers: " E rtp             RTP output\n E rtsp            RTSP output\n",
};

interface Fake {
  version?: string;
  decoders?: string;
  encoders?: string;
  protocols?: string;
  muxers?: string;
  hang?: boolean;
  /** Ignores SIGTERM, so only SIGKILL stops it. */
  stubborn?: boolean;
}

let counter = 0;
/** Writes a fake ffmpeg into a fresh directory; returns the directory and the script. */
async function makeFake(fake: Fake = {}): Promise<{ dir: string; exe: string; calls: () => Promise<number> }> {
  const dir = path.join(TMP, `fake-${counter++}`);
  await fs.mkdir(dir, { recursive: true });
  const exe = path.join(dir, "ffmpeg");
  const files = { ...CAPABLE, ...fake };
  for (const k of ["decoders", "encoders", "protocols", "muxers"] as const) await fs.writeFile(`${exe}.${k}`, files[k]);
  const hang = fake.stubborn ? "trap '' TERM\nsleep 6\n" : fake.hang ? "exec sleep 30\n" : "";
  await fs.writeFile(
    exe,
    `#!/bin/sh\necho x >> "$0.calls"\n${hang}case "$*" in\n*-version*) echo "ffmpeg version ${fake.version ?? "9.9-fake"} Copyright (c) the fake";;\n*-decoders*) cat "$0.decoders";;\n*-encoders*) cat "$0.encoders";;\n*-protocols*) cat "$0.protocols";;\n*-muxers*) cat "$0.muxers";;\nesac\n`,
  );
  await fs.chmod(exe, 0o755);
  const calls = async (): Promise<number> => (await fs.readFile(`${exe}.calls`, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return { dir, exe, calls };
}

function finderFor(opts: { PATH?: string; configured?: string; extraDirs?: string[]; timeoutMs?: number; platform?: NodeJS.Platform } = {}) {
  return createFfmpegFinder({
    configuredPath: async () => opts.configured ?? "",
    env: () => ({ PATH: opts.PATH ?? "" }),
    platform: opts.platform ?? "linux",
    extraDirs: opts.extraDirs ?? [],
    timeoutMs: opts.timeoutMs,
  });
}

test("a capable ffmpeg on PATH is found with its path and version, and logged once", { skip: SKIP }, async (t: TestContext) => {
  const fake = await makeFake();
  const logs = captureConsole(t, "log", "warn");
  const f = finderFor({ PATH: fake.dir });
  const r = await f.find();
  assert.deepEqual(r, { ok: true, path: fake.exe, resolvedPath: await fs.realpath(fake.exe), version: "9.9-fake", source: "automatic" });
  await f.find();
  assert.equal(logs.length, 1, JSON.stringify(logs));
  assert.match(logs[0], /^\[video\] ffmpeg 9\.9-fake at /);
});

test("no ffmpeg anywhere: a returned failure saying not installed, with the platform's install command", async (t: TestContext) => {
  const empty = path.join(TMP, "empty");
  await fs.mkdir(empty, { recursive: true });
  const warns = captureConsole(t, "log", "warn");
  for (const [platform, cmd] of [
    ["linux", "sudo apt install ffmpeg (or your distribution's package)"],
    ["darwin", "brew install ffmpeg"],
    ["win32", "winget install --id Gyan.FFmpeg -e"],
  ] as const) {
    const r = await finderFor({ PATH: empty, platform }).find();
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /ffmpeg is not installed on this server/);
    assert.equal(r.hint, cmd);
    assert.equal(installHint(platform), cmd);
  }
  assert.equal(warns.filter((l) => l.startsWith("[video] ffmpeg is not installed")).length, 3);
});

test("an ffmpeg without libopus is found but incapable, and the reason names what is missing", { skip: SKIP }, async (t: TestContext) => {
  const fake = await makeFake({ encoders: " A....D aac   AAC\n" });
  const warns = captureConsole(t, "warn");
  const r = await finderFor({ PATH: fake.dir }).find();
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "ffmpeg was found but it cannot encode Opus (libopus)");
  assert.equal(r.detail, `found at ${fake.exe} but it cannot encode Opus (libopus)`);
  assert.deepEqual(warns, [`[video] ${r.detail}`]);
});

test("each requirement is checked on its own: AAC decoder, HTTP input, RTSP muxer", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "warn");
  const cases: [Fake, string][] = [
    [{ decoders: " A....D mp3  MP3\n" }, "decode AAC"],
    // A row named aac that is not an audio codec is not an AAC decoder.
    [{ decoders: " V....D aac  not an audio row\n" }, "decode AAC"],
    [{ encoders: " V....D libopus  not an audio row\n" }, "encode Opus (libopus)"],
    // http appears only under Output: -- it must not count as an input.
    [{ protocols: "Input:\n  file\nOutput:\n  file\n  http\n" }, "read HTTP"],
    [{ muxers: " E rtp  RTP output\n D  rtsp  RTSP input only\n" }, "write RTSP"],
  ];
  for (const [fake, phrase] of cases) {
    const f = await makeFake(fake);
    const r = await finderFor({ PATH: f.dir }).find();
    assert.equal(r.ok, false, phrase);
    if (!r.ok) assert.match(r.reason, new RegExp(`cannot ${phrase.replace(/[()]/g, "\\$&")}$`));
  }
});

test("a configured path wins over PATH, and a wrong one is reported, not replaced by PATH's", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "log", "warn");
  const onPath = await makeFake({ version: "1.0-path" });
  const configured = await makeFake({ version: "2.0-configured" });
  const wins = await finderFor({ PATH: onPath.dir, configured: configured.exe }).find();
  assert.deepEqual(wins, { ok: true, path: configured.exe, resolvedPath: await fs.realpath(configured.exe), version: "2.0-configured", source: "configured" });
  assert.equal(await onPath.calls(), 0, "the PATH copy was never run");

  const missing = path.join(TMP, "nowhere", "ffmpeg");
  const wrong = await finderFor({ PATH: onPath.dir, configured: missing }).find();
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.reason, "ffmpeg was not found at the path set in Advanced");
    assert.ok(wrong.detail.includes(missing), "the log detail names the path");
  assert.equal(await onPath.calls(), 0);
});

test("the Homebrew directories are searched when PATH lacks ffmpeg", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "log");
  const brew = await makeFake({ version: "3.0-brew" });
  const r = await finderFor({ PATH: path.join(TMP, "empty"), extraDirs: [brew.dir] }).find();
  assert.deepEqual(r, { ok: true, path: brew.exe, resolvedPath: await fs.realpath(brew.exe), version: "3.0-brew", source: "homebrew" });
});

test("the answer is cached: the binary is run for its five checks once, and again only after a reset", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "log");
  const fake = await makeFake();
  const f = finderFor({ PATH: fake.dir });
  await Promise.all([f.find(), f.find(), f.find()]);
  await f.find();
  assert.equal(await fake.calls(), 5, "-version, -decoders, -encoders, -protocols, -muxers, once");
  f.reset();
  await f.find();
  assert.equal(await fake.calls(), 10);
});

test("a changed configured path is checked afresh without a reset", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "log");
  const a = await makeFake({ version: "a" });
  const b = await makeFake({ version: "b" });
  let configured = a.exe;
  const f = createFfmpegFinder({ configuredPath: async () => configured, env: () => ({ PATH: "" }), platform: "linux", extraDirs: [] });
  assert.equal((await f.find()).ok && (await f.find()).ok, true);
  assert.equal(await a.calls(), 5);
  configured = b.exe;
  const r = await f.find();
  assert.equal(r.ok && r.version, "b");
});

test("a binary that never answers times out into a returned failure", { skip: SKIP }, async (t: TestContext) => {
  const fake = await makeFake({ hang: true });
  const warns = captureConsole(t, "warn");
  const started = Date.now();
  const r = await finderFor({ PATH: fake.dir, timeoutMs: 300 }).find();
  assert.ok(Date.now() - started < 5000, "did not wait for the 30 s sleep");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /^ffmpeg was found but it would not run: did not answer within 0\.3 s$/);
  assert.match(r.detail, /found at .* but it would not run: did not answer within 0\.3 s/);
  assert.equal(warns.length, 1);
});

test("a file that is not runnable is skipped on PATH", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "log", "warn");
  const fake = await makeFake();
  await fs.chmod(fake.exe, 0o644);
  const r = await finderFor({ PATH: fake.dir }).find();
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /not installed/);
});

test("parseFfmpegPath: empty is automatic; otherwise one absolute line", () => {
  assert.deepEqual(parseFfmpegPath({ path: "  " }, "linux"), { ok: true, path: "" });
  assert.deepEqual(parseFfmpegPath({ path: " /opt/x/ffmpeg " }, "linux"), { ok: true, path: "/opt/x/ffmpeg" });
  assert.deepEqual(parseFfmpegPath({ path: "C:\\ffmpeg\\ffmpeg.exe" }, "win32"), { ok: true, path: "C:\\ffmpeg\\ffmpeg.exe" });
  for (const bad of [{}, null, { path: 5 }, { path: "ffmpeg" }, { path: "/a\n/b" }, { path: "/" + "a".repeat(1100) }, { path: "relative/ffmpeg" }]) {
    assert.equal(parseFfmpegPath(bad, "linux").ok, false, JSON.stringify(bad)?.slice(0, 40));
  }
});

test("setFfmpegPath saves the path, checks it, and findFfmpeg then answers for it", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "log", "warn");
  const fake = await makeFake({ version: "4.0-saved" });
  const r = await setFfmpegPath({ path: fake.exe });
  assert.deepEqual(r, { ok: true, result: { ok: true, path: fake.exe, resolvedPath: await fs.realpath(fake.exe), version: "4.0-saved", source: "configured" } });
  assert.equal((await loadFfmpegPath()), fake.exe);
  assert.deepEqual(await findFfmpeg(), { ok: true, path: fake.exe, resolvedPath: await fs.realpath(fake.exe), version: "4.0-saved", source: "configured" });
  const callsAfterFirst = await fake.calls();

  // Saving the same path inside the window reuses the check; after it, it is "check again".
  await setFfmpegPath({ path: fake.exe }, () => Date.now());
  assert.equal(await fake.calls(), callsAfterFirst, "an unchanged path inside the window ran nothing");
  const later = await setFfmpegPath({ path: fake.exe }, () => Date.now() + RECHECK_AFTER_MS + 1);
  assert.equal(later.ok, true);
  assert.equal(await fake.calls(), callsAfterFirst * 2, "after the window the same path is checked again");

  const bad = await setFfmpegPath({ path: "ffmpeg" });
  assert.equal(bad.ok, false);
  assert.equal((await loadFfmpegPath()), fake.exe, "a refused path is not saved");
  await setFfmpegPath({ path: "" });
  assert.equal((await loadFfmpegPath()), "");
});

test("the real system ffmpeg, when there is one, passes the check", async (t: TestContext) => {
  // The system's PATH and the Homebrew directories, exactly as the server sees them.
  const real = await createFfmpegFinder({ configuredPath: async () => "", env: () => process.env, platform: process.platform }).find();
  if (!real.ok && /not installed/.test(real.reason)) {
    t.skip(`no system ffmpeg on this machine: ${real.reason}`);
    return;
  }
  captureConsole(t, "log", "warn");
  assert.equal(real.ok, true, real.ok ? "" : real.reason);
  if (real.ok) assert.match(real.version, /\d/);
});

test("only a path whose basename is ffmpeg is accepted: /bin/sh and ffmpeg-evil are refused", () => {
  for (const bad of ["/bin/sh", "/tmp/x/ffmpeg-evil", "/tmp/x/ffmpeg.sh", "/tmp/x/ffmpeg/", "/tmp/x/xffmpeg", "/tmp/x/FFMPEG"]) {
    const r = parseFfmpegPath({ path: bad }, "linux");
    assert.equal(r.ok, false, bad);
    if (!r.ok) assert.equal(r.error, "The path must name an ffmpeg executable.", bad);
  }
  assert.deepEqual(parseFfmpegPath({ path: "/opt/x/ffmpeg" }, "linux"), { ok: true, path: "/opt/x/ffmpeg" });
  assert.deepEqual(parseFfmpegPath({ path: "/opt/x/ffmpeg" }, "darwin"), { ok: true, path: "/opt/x/ffmpeg" });
});

test("on Windows the name is ffmpeg.exe in any case; on POSIX the same path is refused", () => {
  assert.deepEqual(parseFfmpegPath({ path: "C:\\x\\FFMPEG.EXE" }, "win32"), { ok: true, path: "C:\\x\\FFMPEG.EXE" });
  assert.equal(parseFfmpegPath({ path: "C:\\x\\ffmpeg" }, "win32").ok, false, "no .exe");
  assert.equal(parseFfmpegPath({ path: "C:\\x\\cmd.exe" }, "win32").ok, false);
  assert.equal(parseFfmpegPath({ path: "C:\\x\\FFMPEG.EXE" }, "linux").ok, false);
  assert.equal(namesFfmpeg("C:\\x\\FFMPEG.EXE", "win32"), true);
  assert.equal(namesFfmpeg("/x/FFMPEG", "linux"), false);
});

test("a saved path that does not name ffmpeg (a hand-edited or restored file) is refused by the finder too, and never run", { skip: SKIP }, async (t: TestContext) => {
  const warns = captureConsole(t, "warn");
  const evil = await makeFake();
  const renamed = path.join(evil.dir, "ffmpeg-evil");
  await fs.rename(evil.exe, renamed);
  const r = await finderFor({ configured: renamed }).find();
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /must name an ffmpeg executable/);
  assert.equal(await fs.access(`${evil.exe}.calls`).then(() => true, () => false), false, "the file was never run");
  assert.equal(warns.length, 1);
});

test("a Homebrew-style symlink (bin/ffmpeg into a Cellar bin/ffmpeg) is followed, and the log names where it resolves to", { skip: SKIP }, async (t: TestContext) => {
  const real = await makeFake({ version: "5.0-linked" });
  const linkDir = path.join(TMP, "linkdir");
  await fs.mkdir(linkDir, { recursive: true });
  const link = path.join(linkDir, "ffmpeg");
  await fs.rm(link, { force: true });
  await fs.symlink(real.exe, link);
  const logs = captureConsole(t, "log", "warn");
  const r = await finderFor({ PATH: linkDir }).find();
  assert.deepEqual(r, { ok: true, path: link, resolvedPath: await fs.realpath(real.exe), version: "5.0-linked", source: "automatic" });
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes(`at ${link} (resolves to ${await fs.realpath(real.exe)})`), logs[0]);
  assert.equal(await real.calls(), 5, "the target was what ran");
});

test("a dangling symlink is a returned failure, not a throw", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "warn");
  const dir = path.join(TMP, "dangling");
  await fs.mkdir(dir, { recursive: true });
  await fs.rm(path.join(dir, "ffmpeg"), { force: true });
  await fs.symlink(path.join(TMP, "gone", "ffmpeg"), path.join(dir, "ffmpeg"));
  const r = await finderFor({ PATH: dir }).find();
  assert.equal(r.ok, false);
});

test("on Windows a UNC, device or drive-relative path is refused; only a drive path is accepted", () => {
  for (const unc of [
    "\\\\evil\\share\\ffmpeg.exe",
    "//evil/share/ffmpeg.exe",
    "\\\\?\\UNC\\evil\\share\\ffmpeg.exe",
    "\\\\?\\C:\\x\\ffmpeg.exe",
    "\\\\.\\C:\\x\\ffmpeg.exe",
    "//?/C:/x/ffmpeg.exe",
    "\\x\\ffmpeg.exe",
    "C:ffmpeg.exe",
  ]) {
    const r = parseFfmpegPath({ path: unc }, "win32");
    assert.equal(r.ok, false, unc);
  }
  assert.deepEqual(parseFfmpegPath({ path: "C:\\Tools\\ffmpeg.exe" }, "win32"), { ok: true, path: "C:\\Tools\\ffmpeg.exe" });
  assert.deepEqual(parseFfmpegPath({ path: "D:/Tools/ffmpeg.exe" }, "win32"), { ok: true, path: "D:/Tools/ffmpeg.exe" });
  const r = parseFfmpegPath({ path: "\\\\evil\\share\\ffmpeg.exe" }, "win32");
  if (!r.ok) assert.match(r.error, /local drive/);
});

test("a saved UNC path is refused by the finder on Windows, and never touched", async (t: TestContext) => {
  const warns = captureConsole(t, "warn");
  const r = await finderFor({ configured: "\\\\evil\\share\\ffmpeg.exe", platform: "win32" }).find();
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /local drive/);
  assert.equal(warns.length, 1);
});

test("a link named ffmpeg that points at another program is refused", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "warn");
  const other = await makeFake();
  const target = path.join(other.dir, "not-the-one");
  await fs.rename(other.exe, target);
  const linkDir = path.join(TMP, "evil-link");
  await fs.mkdir(linkDir, { recursive: true });
  const link = path.join(linkDir, "ffmpeg");
  await fs.rm(link, { force: true });
  await fs.symlink(target, link);
  for (const f of [finderFor({ PATH: linkDir }), finderFor({ configured: link })]) {
    const r = await f.find();
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /the file it points to is not named ffmpeg/);
  }
  assert.equal(await fs.access(`${target}.calls`).then(() => true, () => false), false, "the target was never run");
});

test("an ffmpeg in a directory anyone can write to (/tmp-style) is refused, on PATH and configured", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "warn");
  const fake = await makeFake();
  await fs.chmod(fake.dir, 0o777);
  try {
    for (const f of [finderFor({ PATH: fake.dir }), finderFor({ configured: fake.exe }), finderFor({ PATH: path.join(TMP, "empty"), extraDirs: [fake.dir] })]) {
      const r = await f.find();
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.reason, /it is in a folder anyone can write to/);
    }
    assert.equal(await fake.calls(), 0, "never run");
  } finally {
    await fs.chmod(fake.dir, 0o755);
  }
});

test("an ffmpeg file that group or other can write is refused", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "warn");
  for (const mode of [0o775, 0o757]) {
    const fake = await makeFake();
    await fs.chmod(fake.exe, mode);
    const r = await finderFor({ PATH: fake.dir }).find();
    assert.equal(r.ok, false, mode.toString(8));
    if (!r.ok) assert.match(r.reason, /the file is writable by group or other users/);
    assert.equal(await fake.calls(), 0);
  }
});

test("a refused ffmpeg does not stop the search: a later, acceptable one on PATH is used", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "log", "warn");
  const bad = await makeFake({ version: "bad" });
  await fs.chmod(bad.dir, 0o777);
  const good = await makeFake({ version: "good" });
  try {
    const r = await finderFor({ PATH: [bad.dir, good.dir].join(path.delimiter) }).find();
    assert.equal(r.ok && r.version, "good");
  } finally {
    await fs.chmod(bad.dir, 0o755);
  }
});

test("a relative or empty PATH entry is never searched: an ffmpeg in the working directory is not used", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "log", "warn");
  const here = await makeFake({ version: "in-cwd" });
  const elsewhere = path.join(TMP, "abs-empty");
  await fs.mkdir(elsewhere, { recursive: true });
  const before = process.cwd();
  process.chdir(here.dir);
  try {
    for (const PATH of [`.${path.delimiter}${elsewhere}`, `${path.delimiter}${elsewhere}`, `bin${path.delimiter}..${path.delimiter}${elsewhere}`]) {
      const r = await finderFor({ PATH }).find();
      assert.equal(r.ok, false, PATH);
    }
    assert.equal(await here.calls(), 0, "the working directory's ffmpeg was never run");
    // An absolute entry in the same PATH still works.
    const good = await makeFake({ version: "abs" });
    const r = await finderFor({ PATH: `.${path.delimiter}${good.dir}` }).find();
    assert.equal(r.ok && r.version, "abs");
  } finally {
    process.chdir(before);
  }
});

test("output past the buffer is reported as that, not as a timeout", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "warn");
  const fake = await makeFake({ decoders: `${CAPABLE.decoders}${"x".repeat(9 * 1024 * 1024)}\n` });
  const r = await finderFor({ PATH: fake.dir }).find();
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /would not run: printed more than 8 MB/);
    assert.doesNotMatch(r.reason, /did not answer/);
  }
});

test("a binary that ignores SIGTERM is still stopped at the timeout (SIGKILL)", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "warn");
  const fake = await makeFake({ stubborn: true });
  const started = Date.now();
  const r = await finderFor({ PATH: fake.dir, timeoutMs: 300 }).find();
  assert.ok(Date.now() - started < 3000, `waited ${Date.now() - started} ms, so it was not killed at the timeout`);
  assert.equal(r.ok, false);
});

test("simultaneous saves of one path share a single check", { skip: SKIP }, async (t: TestContext) => {
  captureConsole(t, "log", "warn");
  const fake = await makeFake({ version: "6.0-burst" });
  // A path nothing has saved yet, from three clients at once.
  const results = await Promise.all([1, 2, 3].map(() => setFfmpegPath({ path: fake.exe })));
  for (const r of results) assert.equal(r.ok && r.result.ok && r.result.version, "6.0-burst");
  assert.equal(await fake.calls(), 5, "-version, -decoders, -encoders, -protocols, -muxers, once for all three");
  await setFfmpegPath({ path: "" });
});

test("a resolved path off the machine is refused on Windows, whatever was typed", async (t: TestContext) => {
  const warns = captureConsole(t, "warn");
  const probed: string[] = [];
  for (const target of ["\\\\host\\share\\ffmpeg.exe", "\\\\?\\UNC\\host\\share\\ffmpeg.exe", "//host/share/ffmpeg.exe"]) {
    const f = createFfmpegFinder({
      configuredPath: async () => "C:\\tools\\ffmpeg.exe",
      env: () => ({ PATH: "" }),
      platform: "win32",
      fs: { realpath: async () => target, isRunnable: async (p) => { probed.push(p); return true; } },
    });
    const r = await f.find();
    assert.equal(r.ok, false, target);
    if (!r.ok) {
      assert.match(r.reason, /network share or device path/, target);
      assert.doesNotMatch(r.reason, /would not run/);
    }
  }
  assert.deepEqual([...new Set(probed)], ["C:\\tools\\ffmpeg.exe"], "the resolved path was never probed or run");
  assert.equal(warns.length, 3);
});

test("a resolved local drive path on Windows passes the resolved-path rule", async (t: TestContext) => {
  captureConsole(t, "warn");
  const f = createFfmpegFinder({
    configuredPath: async () => "C:\\tools\\ffmpeg.exe",
    env: () => ({ PATH: "" }),
    platform: "win32",
    fs: { realpath: async () => "D:\\real\\ffmpeg.exe", isRunnable: async () => true },
  });
  const r = await f.find();
  // It then fails to RUN here (there is no such file), which is past the rule under test.
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /would not run/);
});

test("what a browser is sent names no folder", async () => {
  const internal = { ok: true as const, path: "/opt/x/ffmpeg", resolvedPath: "/opt/x/Cellar/ffmpeg", version: "9", source: "homebrew" as const };
  assert.deepEqual(publicFfmpegStatus(internal), { ok: true, version: "9", source: "homebrew" });
  const failed = { ok: false as const, reason: "r", detail: "found at /secret/ffmpeg", hint: "h" };
  assert.deepEqual(publicFfmpegStatus(failed), { ok: false, reason: "r", hint: "h" });
});
