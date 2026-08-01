// csv.ts — CSV rows, encoded and parsed, with no I/O.
//
// The archive is append-only and a row is only ever whole or absent: every line
// `encodeRow` produces ends in a newline, and `parseRows` commits a row only when
// it reaches one. A file truncated mid-write by a power cut therefore reads back as
// every complete row it had, and the partial tail is dropped rather than parsed
// into a short row that would misalign against the header.

/** RFC 4180 quoting: only when the value contains a comma, quote or newline. */
function encodeCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** One CSV line, terminated. The terminator is what makes a row complete. */
export function encodeRow(values: (string | number | null | undefined)[]): string {
  return values.map(encodeCell).join(",") + "\n";
}

/**
 * Parse complete rows.
 *
 * A row is committed only on an unquoted newline, so anything still buffered when
 * the text runs out was a partial write and is discarded — including a line cut off
 * inside a quoted cell, which never sees its closing quote.
 */
export function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') {
        cell += c;
      } else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") {
      cell += c;
    }
  }
  return rows; // `row`/`cell` hold an incomplete final line — dropped on purpose
}
