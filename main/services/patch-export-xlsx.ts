// patch-export-xlsx.ts — the same rows as an .xlsx workbook.
//
// write-excel-file is the counterpart to the read-excel-file the patch importer
// already uses, and the same writer the history export uses.
//
// Every cell is written as a STRING. A patch channel is a label, not a quantity:
// "01" becoming the number 1, or connector "B-1" being coerced, would silently
// rewrite the sheet an engineer patches against.

import writeXlsxFile, { type Cell, type Row } from "write-excel-file/node";

import { EXPORT_HEADERS, rowCells, type ExportRow } from "./patch-export.js";

/** Widths in characters, sized for what each column actually holds — Path carries
 *  a whole hop chain and is unreadable at the default width. */
const COLUMN_WIDTHS = [10, 6, 24, 18, 18, 12, 40, 16, 30];

export async function toXlsx(rows: ExportRow[]): Promise<Buffer> {
  const header: Row = EXPORT_HEADERS.map(
    (h): Cell => ({ value: h, type: String, fontWeight: "bold" }),
  );
  const body: Row[] = rows.map((r) => rowCells(r).map((value): Cell => ({ value, type: String })));

  return writeXlsxFile([header, ...body], {
    columns: COLUMN_WIDTHS.map((width) => ({ width })),
    // Freeze the header so a long patch stays readable while scrolling.
    stickyRowsCount: 1,
  }).toBuffer();
}
