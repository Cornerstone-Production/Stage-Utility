// patch-xlsx.ts — Parse an uploaded .xlsx (base64) into { headers, rows } for the
// patch CSV/Excel importer, reusing the spreadsheet reader already used for the
// history export. The renderer maps the columns to patch fields (see patch-import).

import readXlsxFile from "read-excel-file/node";

/** Coerce a parsed cell to text. The reader hands back primitives, so the only
 *  case needing care is a date — rendered as YYYY-MM-DD rather than a locale
 *  string, since a patch sheet column is matched by text. */
function cellText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export async function parseXlsx(base64: string): Promise<{ headers: string[]; rows: string[][] }> {
  const sheets = await readXlsxFile(Buffer.from(base64, "base64"));
  const first = sheets[0];
  if (!first) return { headers: [], rows: [] };
  // Blank rows carry no columns to map, and a trailing one would import as an
  // empty patch row.
  const all = first.data.map((row) => row.map(cellText)).filter((vals) => vals.some((x) => x.trim() !== ""));
  const headers = (all.shift() ?? []).map((h) => h.trim());
  return { headers, rows: all };
}
