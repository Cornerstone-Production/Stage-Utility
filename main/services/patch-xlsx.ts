// patch-xlsx.ts — Parse an uploaded .xlsx (base64) into { headers, rows } for the
// patch CSV/Excel importer, reusing the exceljs dependency already used for the
// history export. The renderer maps the columns to patch fields (see patch-import).

import ExcelJS from "exceljs";

/** Coerce an exceljs cell value (which may be a rich-text / formula / hyperlink object) to text. */
function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((r) => r.text ?? "").join("");
    if (typeof o.text === "string") return o.text;
    if (o.result != null) return String(o.result);
    return "";
  }
  return String(v);
}

export async function parseXlsx(base64: string): Promise<{ headers: string[]; rows: string[][] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(base64, "base64") as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };
  const all: string[][] = [];
  ws.eachRow((row) => {
    // row.values is 1-indexed (index 0 is empty) — drop it.
    const vals = (row.values as unknown[]).slice(1).map(cellText);
    if (vals.some((x) => x.trim() !== "")) all.push(vals);
  });
  const headers = (all.shift() ?? []).map((h) => h.trim());
  return { headers, rows: all };
}
