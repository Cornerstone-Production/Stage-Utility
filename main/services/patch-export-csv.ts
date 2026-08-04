// patch-export-csv.ts — RFC 4180 CSV for the patch export.
//
// Hand-rolled rather than pulled in: the rules are three lines, and this is the
// one place they live. A patch sheet's notes and label fields genuinely contain
// commas and quotes, so the quoting is not theoretical.

import { EXPORT_HEADERS, rowCells, type ExportRow } from "./patch-export.js";

/** Quote only when required, and double any embedded quote. */
function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: ExportRow[]): string {
  const lines = [EXPORT_HEADERS.map(cell).join(",")];
  for (const r of rows) lines.push(rowCells(r).map(cell).join(","));
  // Trailing newline: spreadsheet importers treat a missing one as a truncated file.
  return `${lines.join("\n")}\n`;
}
