// patch-export-csv.ts — the patch sheet as CSV.
//
// The quoting rules live in csv.ts, shared with the archive writer and the patch
// importer. They were hand-rolled here too until the three copies were found to
// disagree; a patch sheet's notes and label fields genuinely contain commas,
// quotes and the occasional pasted line break, so the quoting is not theoretical
// and neither was the disagreement.

import { encodeRows } from "./csv.js";
import { EXPORT_HEADERS, rowCells, type ExportRow } from "./patch-export.js";

export function toCsv(rows: ExportRow[]): string {
  // Every row terminated, including the last: spreadsheet importers treat a
  // missing final newline as a truncated file.
  return encodeRows([[...EXPORT_HEADERS], ...rows.map(rowCells)]);
}
