// file-exists.ts — "is there a file at this path", with one policy for a failure.
//
// Server-only, so not in errors.ts: the renderer imports that for errorMessage,
// and node:fs has no place in its bundle.
//
// Only ENOENT means "not there". Three copies answered every other failure
// (EACCES, EIO, ENOTDIR) as "not there" too, so an archive the process could not
// read looked absent and was downloaded again, and the permission error that
// explained it was never shown. A failure to look is thrown: the caller decides
// what to tell the operator.

import * as fs from "node:fs/promises";

import { isNotFound } from "./errors.js";

/** Whether `file` exists. False only for a path that is not there; any other
 *  failure to look is thrown. */
export async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}
