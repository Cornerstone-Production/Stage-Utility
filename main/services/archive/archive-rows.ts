// archive-rows.ts — reading a service's raw CSVs back as rows.
//
// One source's rows may be spread across rolled files (`spl.csv`, `spl.2.csv`, …)
// when a meter changed its column set mid-service — see csv-appender.ts. Every
// reader of the raw layer therefore has to walk the roll, and there is now more
// than one: rebuild recomputes a record from these rows, and a history merge
// moves them from one service's directory into another's.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { MAX_ROLL } from "./csv-appender.js";
import { parseRows } from "../csv.js";

/** A parsed row keyed by its file's header. Key order is the header's order. */
export type ArchiveRow = Record<string, string>;

/**
 * Every row of one source within one service directory, across rolled files.
 *
 * Returns null when the source was never recorded, which is different from a
 * source that recorded a header and no rows — callers distinguish "nothing to
 * rebuild from" (leave the stored record alone) from "recorded, but empty".
 */
export async function readArchiveRows(dir: string, base: string): Promise<ArchiveRow[] | null> {
  const out: ArchiveRow[] = [];
  let found = false;
  for (let i = 1; i <= MAX_ROLL; i++) {
    const name = i === 1 ? `${base}.csv` : `${base}.${i}.csv`;
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, name), "utf8");
    } catch {
      // A gap is not the end: `spl.csv` can be absent while `spl.2.csv` exists if
      // the first column set never produced a row. Only a gap after the first
      // ends the walk.
      if (i === 1) continue;
      break;
    }
    found = true;
    const rows = parseRows(text);
    if (rows.length < 2) continue;
    const header = rows[0];
    for (const r of rows.slice(1)) {
      const rec: ArchiveRow = {};
      header.forEach((h, idx) => (rec[h] = r[idx] ?? ""));
      out.push(rec);
    }
  }
  return found ? out : null;
}

/**
 * Rows in chronological order, leaving an unparseable stamp beside its
 * neighbours — the sort is stable, so returning 0 does not herd damaged rows to
 * one end of the file.
 *
 * Lives here rather than in one rebuilder because every replay of the raw layer
 * needs it and none of them may disagree about it: the timing rebuild and the
 * baptism replay both order rows this way, and a second copy is how the SSE
 * buffer cap and the `endedAt` guard drifted.
 */
export function rowsByTime<T extends ArchiveRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = Date.parse(a.at ?? "");
    const tb = Date.parse(b.at ?? "");
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
    return ta - tb;
  });
}

/** The rolled filenames actually present for one source, in roll order. */
export async function rolledFiles(dir: string, base: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const rolled = new RegExp(`^${base}\\.\\d+\\.csv$`);
  return names
    .filter((n) => n === `${base}.csv` || rolled.test(n))
    .sort((a, b) => rollIndex(a, base) - rollIndex(b, base));
}

function rollIndex(name: string, base: string): number {
  if (name === `${base}.csv`) return 1;
  return Number(name.slice(base.length + 1, -4)) || 0;
}
