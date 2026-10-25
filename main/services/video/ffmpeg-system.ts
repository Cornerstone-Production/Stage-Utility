// main/services/video/ffmpeg-system.ts — finding the operating system's own
// ffmpeg, and knowing whether it can do what the Video relay's audio features
// need of it: decode AAC, encode Opus, read HTTP and write RTSP.
//
// The server never downloads ffmpeg: the OS package manager patches it with
// ordinary system updates. It is looked for in this order:
//   1. the path set in Advanced (and only that, when one is set: a wrong path
//      is reported, not quietly replaced by another ffmpeg);
//   2. every ABSOLUTE directory on PATH (a relative or empty entry would be
//      searched relative to the server's working directory, so it is skipped);
//   3. /opt/homebrew/bin and /usr/local/bin on macOS and Linux, because a
//      launchd service starts with a PATH that has no Homebrew in it.
//
// What the server will run is limited, because the path comes from a settings
// write. A candidate, from any of the three, is used only if:
//   - its file name is exactly `ffmpeg` (`ffmpeg.exe` on Windows, any case);
//   - the file it RESOLVES to (realpath) is named the same, so a link called
//     ffmpeg that points at some other program is refused, while Homebrew's
//     link into its Cellar is not;
//   - on macOS and Linux, that resolved file is not writable by group or other
//     and its directory is not writable by other (so /tmp and /var/tmp are out).
// On Windows a configured path, and the file it resolves to, must be on a drive
// (`C:\...`): a network share or device path (`\\host\share\`, `\\?\`) would
// run a file from another machine. Not checked: who can write to the file's
// folder on Windows, and the folders above the immediate one on macOS and Linux.
//
// The candidate must then pass the capability check. It runs once per
// configured path and the answer, good or bad, is kept until the path setting is
// saved again (setFfmpegPath), so nothing here costs a spawn per caller.
//
// Failures are returned. Nothing here throws for a missing or broken ffmpeg.

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { FfmpegStatus } from "../../types/video.js";
import { errorMessage } from "../errors.js";
import { scrub } from "../scrub.js";
import { ffmpegPathStore, loadFfmpegPath } from "./ffmpeg-path-store.js";

/** Long enough for a cold start of a 80 MB binary on a slow disk; short enough
 *  that a hung one cannot hold up whatever asked. */
const CHECK_TIMEOUT_MS = 10_000;

const EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** Whether `p` names an ffmpeg executable: a basename of exactly `ffmpeg`, or
 *  `ffmpeg.exe` on Windows (any case there). A setting must never be able to
 *  point the server at some other program on the machine. */
export function namesFfmpeg(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (/[\\/]$/.test(p)) return false; // basename() ignores a trailing separator
  return platform === "win32" ? path.win32.basename(p).toLowerCase() === "ffmpeg.exe" : path.posix.basename(p) === "ffmpeg";
}

/** A Windows path on a local drive: `C:\...` or `C:/...`. Not drive-relative
 *  (`C:ffmpeg.exe`), not rooted (`\x`), not UNC or a `\\?\` device path. */
function isDriveLetterPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p);
}

function isAbsoluteFor(p: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? isDriveLetterPath(p) : path.posix.isAbsolute(p);
}

/** Why `p` cannot be the configured path, or null when it can. Existence is not
 *  looked at here. */
export function configuredPathProblem(p: string, platform: NodeJS.Platform = process.platform): string | null {
  // eslint-disable-next-line no-control-regex
  if (p.length > 1024 || /[\u0000-\u001f\u007f]/.test(p)) return "That path is not valid.";
  if (platform === "win32" && /^[\\/]{2}/.test(p)) return "Use a path on a local drive, like C:\\tools\\ffmpeg.exe, not a network share or device path.";
  if (!namesFfmpeg(p, platform)) return "The path must name an ffmpeg executable.";
  if (!isAbsoluteFor(p, platform)) {
    return platform === "win32"
      ? "Enter the full path on a drive, like C:\\tools\\ffmpeg.exe, or leave it empty to find it automatically."
      : "Enter the full path to the ffmpeg program, or leave it empty to find it automatically.";
  }
  return null;
}

/** The install command for a platform, as the status line says it. */
export function installHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "brew install ffmpeg";
  if (platform === "win32") return "winget install --id Gyan.FFmpeg -e";
  return "sudo apt install ffmpeg (or your distribution's package)";
}

/** A failure as two sentences: `reason` is safe to send to a browser (it names
 *  no folder and quotes no error text), `detail` is for the [video] log, which
 *  has the full paths. */
interface Why {
  reason: string;
  detail: string;
}

type RunResult = { ok: true; stdout: string } | ({ ok: false } & Why);

function run(file: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (!err) return resolve({ ok: true, stdout });
      const e = err as { killed?: boolean; code?: unknown };
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ ok: false, reason: "printed more than 8 MB", detail: "printed more than 8 MB" });
      if (e.killed === true) {
        const t = `did not answer within ${timeoutMs / 1000} s`;
        return resolve({ ok: false, reason: t, detail: t });
      }
      // errorMessage() quotes the command line, which holds the path.
      resolve({ ok: false, reason: "it exited with an error", detail: errorMessage(err) });
    });
  });
}

async function isRunnableFile(p: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return false;
    if (platform !== "win32") await fs.access(p, 1 /* X_OK */);
    return true;
  } catch {
    return false;
  }
}

type Vetted = { ok: true; resolved: string } | ({ ok: false } & Why);

/** File-system seams for tests; the real ones by default. */
interface FsOps {
  realpath: (p: string) => Promise<string>;
  isRunnable: (p: string, platform: NodeJS.Platform) => Promise<boolean>;
}
const REAL_FS: FsOps = { realpath: (p) => fs.realpath(p), isRunnable: isRunnableFile };

/** The rules in the header, applied to one candidate that exists. */
async function vet(candidate: string, platform: NodeJS.Platform, ops: FsOps): Promise<Vetted> {
  const refuse = (why: string, detail: string): Vetted => ({
    ok: false,
    reason: `the ffmpeg found was refused: ${why}`,
    detail: `found at ${candidate} but it was refused: ${detail}`,
  });
  if (!namesFfmpeg(candidate, platform)) return refuse("its file name is not ffmpeg", "its file name is not ffmpeg");
  let resolved: string;
  try {
    resolved = await ops.realpath(candidate);
  } catch (err) {
    return refuse("it could not be resolved", `it could not be resolved: ${errorMessage(err)}`);
  }
  if (!namesFfmpeg(resolved, platform)) {
    return refuse("the file it points to is not named ffmpeg", `it resolves to ${resolved}, whose file name is not ffmpeg`);
  }
  // A junction or link can lead off the machine: judged on where it ends up,
  // not on what was typed.
  if (platform === "win32" && !isDriveLetterPath(resolved)) {
    return refuse("it is on a network share or device path, not a local drive", `it resolves to ${resolved}, which is not on a local drive`);
  }
  if (!(await ops.isRunnable(resolved, platform))) return refuse("it is not a runnable file", `${resolved} is not a runnable file`);
  if (platform !== "win32") {
    try {
      const file = await fs.stat(resolved);
      if ((file.mode & 0o022) !== 0) return refuse("the file is writable by group or other users", `${resolved} is writable by group or other users`);
      const dir = path.dirname(resolved);
      if (((await fs.stat(dir)).mode & 0o002) !== 0) return refuse("it is in a folder anyone can write to", `${dir} is writable by any user`);
    } catch (err) {
      return refuse("its permissions could not be read", `its permissions could not be read: ${errorMessage(err)}`);
    }
  }
  return { ok: true, resolved };
}

/** Where a found ffmpeg came from, as a class (never a folder). */
export type FfmpegSource = "automatic" | "homebrew" | "configured";

/** The first ffmpeg on PATH, then in the Homebrew directories, that passes
 *  vet(). `refused` names each one that was found and turned away. */
async function searchPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  extraDirs: readonly string[],
  ops: FsOps,
): Promise<{ found: { candidate: string; resolved: string; source: FfmpegSource } | null; refused: Why[] }> {
  const name = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const dirs: { dir: string; source: FfmpegSource }[] = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((d) => d !== "" && isAbsoluteFor(d, platform))
    .map((dir) => ({ dir, source: "automatic" as const }));
  if (platform !== "win32") for (const d of extraDirs) if (!dirs.some((x) => x.dir === d)) dirs.push({ dir: d, source: "homebrew" });
  const refused: Why[] = [];
  for (const { dir, source } of dirs) {
    const candidate = path.join(dir, name);
    if (!(await ops.isRunnable(candidate, platform))) continue;
    const v = await vet(candidate, platform, ops);
    if (v.ok) return { found: { candidate, resolved: v.resolved, source }, refused };
    refused.push(v);
  }
  return { found: null, refused };
}

/** Whether `output` (an `ffmpeg -decoders`-style listing) names `name` on a row
 *  whose flag column satisfies `flag`. Rows read `<flags> <name[,name]> <text>`. */
function listed(output: string, flag: (flags: string) => boolean, name: string): boolean {
  for (const line of output.split("\n")) {
    const [flags, names] = line.trim().split(/\s+/);
    if (flags && names && flag(flags) && names.split(",").includes(name)) return true;
  }
  return false;
}

/** The names on the Input: part of `ffmpeg -protocols`. */
function inputProtocols(output: string): string[] {
  const out: string[] = [];
  let inInput = false;
  for (const line of output.split("\n")) {
    const t = line.trim();
    if (/^Input:/.test(t)) inInput = true;
    else if (/^Output:/.test(t)) inInput = false;
    else if (inInput && t !== "") out.push(t);
  }
  return out;
}

/** What `candidate` cannot do; an empty list is a capable ffmpeg. */
async function check(candidate: string, runPath: string, timeoutMs: number): Promise<{ ok: true; version: string } | ({ ok: false } & Why)> {
  const [version, decoders, encoders, protocols, muxers] = await Promise.all([
    run(runPath, ["-hide_banner", "-version"], timeoutMs),
    run(runPath, ["-hide_banner", "-decoders"], timeoutMs),
    run(runPath, ["-hide_banner", "-encoders"], timeoutMs),
    run(runPath, ["-hide_banner", "-protocols"], timeoutMs),
    run(runPath, ["-hide_banner", "-muxers"], timeoutMs),
  ]);
  const broken = [version, decoders, encoders, protocols, muxers].find((r) => !r.ok);
  if (broken && !broken.ok) {
    return {
      ok: false,
      reason: `ffmpeg was found but it would not run: ${broken.reason}`,
      detail: `found at ${candidate} but it would not run: ${broken.detail}`,
    };
  }
  const text = (r: RunResult): string => (r.ok ? r.stdout : "");
  const missing: string[] = [];
  if (!listed(text(decoders), (f) => f.startsWith("A"), "aac")) missing.push("decode AAC");
  if (!listed(text(encoders), (f) => f.startsWith("A"), "libopus")) missing.push("encode Opus (libopus)");
  if (!inputProtocols(text(protocols)).includes("http")) missing.push("read HTTP");
  if (!listed(text(muxers), (f) => f.includes("E"), "rtsp")) missing.push("write RTSP");
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `ffmpeg was found but it cannot ${missing.join(", or ")}`,
      detail: `found at ${candidate} but it cannot ${missing.join(", or ")}`,
    };
  }
  const first = text(version).split("\n")[0] ?? "";
  return { ok: true, version: first.replace(/^ffmpeg version\s+/, "").split(/\s+/)[0] || "unknown" };
}

/** What the server knows about its ffmpeg. `path`, `resolvedPath` and `detail`
 *  hold folders: they are for the server (the log, and PR 2's spawn of
 *  `resolvedPath`) and are never sent to a browser; see publicFfmpegStatus. */
export type FfmpegResult =
  | { ok: true; path: string; resolvedPath: string; version: string; source: FfmpegSource }
  | { ok: false; reason: string; detail: string; hint: string };

/** The result as a browser may see it: the version and where it came from as a
 *  class, or a reason that names no folder. The log has the paths. */
export function publicFfmpegStatus(r: FfmpegResult): FfmpegStatus {
  return r.ok ? { ok: true, version: r.version, source: r.source } : { ok: false, reason: r.reason, hint: r.hint };
}

export interface FfmpegFinderDeps {
  configuredPath: () => Promise<string>;
  env: () => NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Directories searched after PATH. Defaults to the Homebrew ones. */
  extraDirs?: readonly string[];
  /** How long each of the five checks may take. Defaults to 10 s. */
  timeoutMs?: number;
  /** Test seams for the file system (realpath, and "is a runnable file"). */
  fs?: Partial<FsOps>;
}

/** A finder with its own cache. The server uses the one at the bottom of this
 *  file; a test builds its own with a fake PATH. */
export function createFfmpegFinder(deps: FfmpegFinderDeps): { find: () => Promise<FfmpegResult>; reset: () => void } {
  let cached: { configured: string; result: Promise<FfmpegResult> } | null = null;
  const ops: FsOps = { ...REAL_FS, ...deps.fs };

  async function locate(configured: string): Promise<FfmpegResult> {
    const hint = installHint(deps.platform);
    const fail = (reason: string, detail: string = reason): FfmpegResult => {
      console.warn(`[video] ${scrub(detail)}`);
      return { ok: false, reason, detail, hint };
    };
    let candidate: string;
    let resolved: string;
    let source: FfmpegSource;
    if (configured !== "") {
      // The saved value is checked again as it is used, not only when it was
      // saved: the file can be hand-edited.
      const problem = configuredPathProblem(configured, deps.platform);
      if (problem) return fail(`the path set in Advanced cannot be used: ${problem}`);
      if (!(await ops.isRunnable(configured, deps.platform))) {
        return fail("ffmpeg was not found at the path set in Advanced", `ffmpeg was not found at the path set in Advanced (${configured})`);
      }
      const v = await vet(configured, deps.platform, ops);
      if (!v.ok) return fail(v.reason, v.detail);
      candidate = configured;
      resolved = v.resolved;
      source = "configured";
    } else {
      const { found, refused } = await searchPath(deps.env(), deps.platform, deps.extraDirs ?? EXTRA_DIRS, ops);
      if (!found) {
        if (refused.length > 0) return fail(refused.map((w) => w.reason).join("; "), refused.map((w) => w.detail).join("; "));
        return fail("ffmpeg is not installed on this server", "ffmpeg is not installed on this server (not on PATH, nor in /opt/homebrew/bin or /usr/local/bin)");
      }
      ({ candidate, resolved, source } = found);
    }
    const checked = await check(candidate, resolved, deps.timeoutMs ?? CHECK_TIMEOUT_MS);
    if (!checked.ok) return fail(checked.reason, checked.detail);
    console.log(`[video] ffmpeg ${scrub(checked.version)} at ${scrub(candidate)}${resolved === candidate ? "" : ` (resolves to ${scrub(resolved)})`}`);
    return { ok: true, path: candidate, resolvedPath: resolved, version: checked.version, source };
  }

  return {
    async find() {
      const configured = await deps.configuredPath();
      if (cached?.configured !== configured) cached = { configured, result: locate(configured) };
      return cached.result;
    },
    reset() {
      cached = null;
    },
  };
}

export type FfmpegFinder = ReturnType<typeof createFfmpegFinder>;

/** The server's own finder, and its cache. The video service asks it, and resets
 *  it when the file it found has gone (a Homebrew upgrade moves the Cellar path). */
export const systemFfmpegFinder: FfmpegFinder = createFfmpegFinder({
  configuredPath: loadFfmpegPath,
  env: () => process.env,
  platform: process.platform,
});

/** The server's ffmpeg, or why there is none and the command that installs it.
 *  Checked once; see the top of this file.
 *
 *  A caller that RUNS ffmpeg spawns `resolvedPath`, the file the checks were run
 *  against, not `path` (which may be a link that now points elsewhere). Never
 *  send this to a browser as it is: use publicFfmpegStatus. */
export function findFfmpeg(): Promise<FfmpegResult> {
  return systemFfmpegFinder.find();
}

export type ParsedFfmpegPath = { ok: true; path: string } | { ok: false; error: string };

/** A PATCH /api/video/ffmpeg body: `{ path }`, empty for "find it yourself",
 *  otherwise an absolute path on one line named ffmpeg (see
 *  configuredPathProblem). Existence is not checked here; the check reports a
 *  path that does not run. */
export function parseFfmpegPath(body: unknown, platform: NodeJS.Platform = process.platform): ParsedFfmpegPath {
  const raw = typeof body === "object" && body !== null ? (body as Record<string, unknown>).path : undefined;
  if (typeof raw !== "string") return { ok: false, error: "path must be text." };
  const p = raw.trim();
  if (p === "") return { ok: true, path: "" };
  const problem = configuredPathProblem(p, platform);
  return problem ? { ok: false, error: problem } : { ok: true, path: p };
}

/** An unchanged path saved again within this long reuses the last check. */
export const RECHECK_AFTER_MS = 10_000;

let lastSet: { path: string; at: number; result: FfmpegResult } | null = null;
let setQueue: Promise<unknown> = Promise.resolve();

async function applyFfmpegPath(body: unknown, now: () => number): Promise<{ ok: true; result: FfmpegResult } | { ok: false; error: string }> {
  const parsed = parseFfmpegPath(body);
  if (!parsed.ok) return parsed;
  // Each save runs five checks. Saves go one at a time, and an unchanged path
  // saved again inside the window reuses the answer, so a client cannot turn
  // the button into a stream of spawns, and concurrent saves share one check.
  if (lastSet && lastSet.path === parsed.path && now() - lastSet.at < RECHECK_AFTER_MS) return { ok: true, result: lastSet.result };
  await ffmpegPathStore.save({ path: parsed.path });
  systemFfmpegFinder.reset();
  const result = await systemFfmpegFinder.find();
  lastSet = { path: parsed.path, at: now(), result };
  return { ok: true, result };
}

/** Saves the Advanced path, forgets the kept answer and checks again. Saving
 *  the same path again after RECHECK_AFTER_MS is the "check again" button.
 *  `now` is a test seam. */
export function setFfmpegPath(body: unknown, now: () => number = Date.now): Promise<{ ok: true; result: FfmpegResult } | { ok: false; error: string }> {
  const run = setQueue.then(() => applyFfmpegPath(body, now));
  setQueue = run.catch(() => undefined);
  return run;
}
