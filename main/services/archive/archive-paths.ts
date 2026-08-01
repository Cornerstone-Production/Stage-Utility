// archive-paths.ts — where the raw layer lives on disk.
//
// One directory per service occurrence, not per day: two services sharing a plan
// on one Sunday have different serviceKeys and must not share a file. The key
// contains colons (`st:plan:time`), which are illegal in Windows filenames and
// would let a crafted key escape the root, so it is sanitised down to a safe set.

import * as path from "path";

import { getUserDataPath } from "../app-paths.js";

/** Reduce to a filename-safe token. Collapses runs and trims leading/trailing
 *  separators so `..` cannot survive, and never returns an empty segment. */
function safe(part: string): string {
  const s = part
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");
  return s || "unknown";
}

export function archiveRoot(): string {
  return path.join(getUserDataPath(), "archive");
}

/** `2026-07-26_st1-p123-t9` — sortable by date, unique by occurrence. */
export function serviceDirName(serviceKey: string, serviceDate: string): string {
  return `${safe(serviceDate)}_${safe(serviceKey)}`;
}

export function serviceDirPath(serviceKey: string, serviceDate: string): string {
  return path.join(archiveRoot(), serviceDirName(serviceKey, serviceDate));
}
