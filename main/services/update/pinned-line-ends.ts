// pinned-line-ends.ts — put back a pinned file that differs from git only in its
// line ends.
//
// .gitattributes marks some files `-text`: checked out as their exact bytes,
// whatever core.autocrlf says, because the release signs those bytes (see the
// comment in .gitattributes). A checkout made before that attribute existed, on a
// machine with core.autocrlf=true (Git for Windows' default), already has such a
// file with CRLF line ends, and git rewrites a file on checkout only when its blob
// changed. So the file stays CRLF, `git status` calls the tree dirty, and the
// updater refuses every update and track switch from then on.
//
// This finds each modified file that is pinned `-text` and is, once every CRLF in
// it is made LF, byte for byte the blob in the index, and checks it out again.
// The comparison is exact on purpose: any other change, a trailing space or a
// final newline removed included, is the operator's edit and is left for the
// dirty-tree refusal that follows to report. Each path is handled on its own, and
// one that fails is returned with why, not allowed to stop the rest.

import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { errorMessage } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface PinnedDeps {
  /** git in the checkout, its stdout exactly as written; throws on a non-zero exit. */
  git: (args: string[]) => Promise<Buffer>;
  /** A working-tree file's bytes, by its path from the top of the checkout. */
  readFile: (file: string) => Promise<Buffer>;
}

export interface PinnedResult {
  /** The paths checked out again. */
  restored: string[];
  /** Each path that could not be looked at or put back, with why. `file` is
   *  empty when the list of modified files itself could not be read. */
  failed: { file: string; error: string }[];
}

/** The real thing, for the checkout at `root`. */
export function pinnedDepsFor(root: string): PinnedDeps {
  return {
    git: async (args) => (await execFileAsync("git", args, { cwd: root, encoding: "buffer", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })).stdout,
    readFile: (file) => fs.readFile(path.join(root, file)),
  };
}

const message = (err: unknown): string => errorMessage(err).split("\n")[0];

/** The NUL-separated fields of a `-z` answer. */
const fields = (out: Buffer): string[] => out.toString("utf8").split("\0").filter((f) => f !== "");

/** The id git gives a blob of these bytes, in the repository's hash. */
function blobId(bytes: Buffer, format: string): string {
  return crypto
    .createHash(format === "sha256" ? "sha256" : "sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
}

/** Every CRLF made LF, and nothing else changed. */
const lfOnly = (bytes: Buffer): Buffer => Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");

/** Check out again every pinned file whose only difference is its line ends. Never
 *  throws: what failed is in the result, for the caller to report. */
export async function restorePinnedLineEnds(deps: PinnedDeps): Promise<PinnedResult> {
  const result: PinnedResult = { restored: [], failed: [] };
  let modified: string[];
  try {
    modified = fields(await deps.git(["diff", "--name-only", "-z", "--diff-filter=M"]));
  } catch (err) {
    result.failed.push({ file: "", error: message(err) });
    return result;
  }
  let format: string | null = null;
  for (const file of modified) {
    try {
      // "<path>\0text\0<value>\0"
      if (fields(await deps.git(["check-attr", "-z", "text", "--", file]))[2] !== "unset") continue;
      // A git older than 2.29 has no --show-object-format, and no SHA-256 repositories either.
      format ??= (await deps.git(["rev-parse", "--show-object-format"]).catch(() => Buffer.from("sha1"))).toString().trim();
      const inIndex = (await deps.git(["rev-parse", `:${file}`])).toString().trim();
      if (blobId(lfOnly(await deps.readFile(file)), format) !== inIndex) continue;
      await deps.git(["checkout", "--", file]);
      result.restored.push(file);
    } catch (err) {
      result.failed.push({ file, error: message(err) });
    }
  }
  return result;
}
