// csv.ts — CSV rows, encoded and parsed, with no I/O.
//
// One implementation, because there were four: the archive's encoder and parser,
// the patch export's encoder, and the patch import's parser. They were written
// separately and disagreed — the import-side encoder tested `/[",\n]/` and not
// `\r`, so a value carrying a bare carriage return went out unquoted and came
// back as two rows.
//
// Two callers genuinely need different things at the END of a file, and that is
// the one difference kept rather than smoothed away:
//
//   `parseRows` DROPS an incomplete final row. It reads append-only archive
//   files that a power cut can truncate mid-line, and a short row silently
//   misaligns against the header for the rest of the file.
//
//   `parseTable` KEEPS it. It reads files a spreadsheet wrote, and Excel puts no
//   trailing newline on the last line — dropping it would lose the last channel
//   of every imported patch sheet.
//
// Shared with the renderer through the `@main` alias, which Vite derives from
// tsconfig. Nothing here touches Node, so it bundles.

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

/** A whole document. Every row terminated, so it can be appended to safely. */
export function encodeRows(rows: (string | number | null | undefined)[][]): string {
  return rows.map(encodeRow).join("");
}

/**
 * The tokeniser both parsers share.
 *
 * `partial` is the final row when the text did not end on a terminator — the one
 * thing the two callers answer differently. Inside quotes every character is
 * taken verbatim, including CR and LF, so a cell holding a line break survives
 * exactly as written.
 */
function scan(text: string): { rows: string[][]; partial: string[] | null } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  /** Anything at all on the current line — including an empty cell before a comma. */
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      started = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
      started = true;
    } else if (c === "\n" || c === "\r") {
      // CRLF is one terminator, not two. An archive file is written with LF
      // alone, so outside a quoted cell a CR only ever arrives from a file
      // something else wrote.
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      started = false;
    } else {
      cell += c;
      started = true;
    }
  }
  return { rows, partial: started || row.length > 0 ? [...row, cell] : null };
}

/**
 * Parse complete rows, discarding an unterminated final line.
 *
 * A row is committed only on an unquoted newline, so anything still buffered
 * when the text runs out was a partial write — including a line cut off inside
 * a quoted cell, which never sees its closing quote.
 */
export function parseRows(text: string): string[][] {
  return scan(text).rows;
}

/** Is every cell in this row blank? A file's trailing blank lines are not data. */
function isBlank(row: string[]): boolean {
  return !row.some((c) => c.trim() !== "");
}

/**
 * Parse a headed table, keeping an unterminated final row.
 *
 * Headers are trimmed — a stray space around a column name should still
 * auto-map — but the data is not, because a leading space in a channel label is
 * the operator's and not ours to remove.
 */
export function parseTable(text: string): { headers: string[]; rows: string[][] } {
  const { rows, partial } = scan(text);
  const all = (partial ? [...rows, partial] : rows).filter((r) => !isBlank(r));
  const headers = (all.shift() ?? []).map((h) => h.trim());
  return { headers, rows: all };
}
