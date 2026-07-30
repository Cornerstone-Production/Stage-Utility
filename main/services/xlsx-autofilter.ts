// Adds Excel's filter dropdowns to every sheet in a generated workbook.
//
// write-excel-file can freeze a header row but has no notion of a filter or a
// table, so this goes in through its feature/plugin hook. An `.xlsx` sheet gets
// filter controls from a single element:
//
//   <autoFilter ref="A1:I240"/>
//
// It has to sit after `<sheetData>`, which is where appending it just before
// `</worksheet>` puts it.
//
// The range is derived from the cell references in the sheet itself. The writer
// emits no `<dimension>` element to read it from, and the plugin hook is handed
// the sheet's options rather than its data, so the XML is the only place the
// extent of the content is actually known.

/** Cell references as the writer emits them, e.g. `<c r="B14" ...>`. */
const CELL_REF = /<c\s+r="([A-Z]+)(\d+)"/g;

/** "A" → 1, "Z" → 26, "AA" → 27. */
function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** The inverse, for naming the far edge of the range. */
function columnName(index: number): string {
  let out = "";
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** The used range of a worksheet, or null when it holds nothing filterable. */
function usedRange(xml: string): string | null {
  let maxCol = 0;
  let maxRow = 0;
  for (const m of xml.matchAll(CELL_REF)) {
    maxCol = Math.max(maxCol, columnIndex(m[1]));
    maxRow = Math.max(maxRow, Number(m[2]));
  }
  // A header alone is not worth filtering, and Excel rejects a single-cell filter.
  if (maxCol === 0 || maxRow < 2) return null;
  return `A1:${columnName(maxCol)}${maxRow}`;
}

/**
 * A workbook feature that turns each sheet into a filterable range.
 *
 * Sheets that are not tables — a header with no rows under it, or the About page
 * of label/value pairs — are left alone rather than given arrows that filter
 * nothing.
 */
// Deliberately un-annotated: the library's Feature type is generic over its file
// content, and this only uses the transform hook, so the literal matches whatever
// the node build parameterises with.
export const autoFilterFeature = {
  files: {
    transform: {
      "xl/worksheets/sheet{id}.xml": {
        transform(content: string): string {
          if (content.includes("<autoFilter")) return content; // never double-apply
          const ref = usedRange(content);
          if (!ref) return content;
          return content.replace("</worksheet>", `<autoFilter ref="${ref}"/></worksheet>`);
        },
      },
    },
  },
};
