// Turns each generated sheet into a real Excel Table (a "ListObject") rather than
// a plain range with filter arrows.
//
// A table is what Excel treats as a dataset: banded rows, filter dropdowns, a name
// formulas can reference, and — the reason this exists — Insert > PivotTable opens
// with the range already filled in. A bare autoFilter gives the dropdowns and
// nothing else.
//
// Excel is unforgiving here. A table needs four things to agree, and if any one is
// missing or inconsistent it refuses the file and offers to "repair" it, which
// silently drops the table:
//
//   1. xl/tables/tableN.xml                      the table itself
//   2. a relationship from the sheet to it       xl/worksheets/_rels/sheetN.xml.rels
//   3. a content-type override for the part      [Content_Types].xml
//   4. <tableParts> on the sheet                 pointing at that relationship
//
// and every <tableColumn name> must match the header cell's text exactly.
//
// All of it is therefore done in one pass in `write`, which runs last and can both
// read and overwrite the parts the writer already produced. Spreading it across
// per-file transforms meant depending on the order those fire in, which is how the
// first attempt ended up with table columns named "Column1".
//
// The headers are passed IN rather than read back out of the sheet. Header text
// lives in xl/sharedStrings.xml, which does not exist yet when this runs — reading
// it returns undefined, which is the second way those columns ended up as
// "Column1". The caller builds the sheets and already knows every heading.

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

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Excel requires distinct, non-empty column names within one table. */
function uniqueNames(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h, i) => {
    const base = h.trim() || `Column${i + 1}`;
    const n = seen.get(base.toLowerCase()) ?? 0;
    seen.set(base.toLowerCase(), n + 1);
    return n === 0 ? base : `${base} ${n + 1}`;
  });
}

/** One sheet's shape, in the order the sheets were given to the writer. */
export interface TableSpec {
  /** Column headings, exactly as written into row 1. */
  headers: string[];
  /** Data rows beneath the header. Zero means the sheet is not a table. */
  rowCount: number;
}

/**
 * A workbook feature that promotes every table-shaped sheet to a ListObject.
 *
 * `namePrefix` becomes the table's name in Excel's name box (`Data1`, `Data2`, …);
 * it must start with a letter and contain no spaces.
 */
export function tableFeature(specs: readonly TableSpec[], namePrefix = "Data") {
  return {
    files: {
      write: {
        files(
          sheetsOptions: unknown[],
          properties: { read(path: string): unknown },
        ): Record<string, string> | undefined {
          // `read` hands back whatever the writer stored — a Buffer for the node
          // build, not a string. Reading it as a string silently matched nothing,
          // which is how the table columns first came out named "Column1".
          const read = (path: string): string | undefined => {
            const raw = properties.read(path);
            return raw == null ? undefined : typeof raw === "string" ? raw : String(raw);
          };
                    const out: Record<string, string> = {};
          const overrides: string[] = [];

          for (let i = 0; i < sheetsOptions.length; i++) {
            const spec = specs[i];
            // Excel rejects a table whose range is a single row, and a heading with
            // nothing under it is not a dataset anyway.
            if (!spec || spec.headers.length === 0 || spec.rowCount < 1) continue;
            const sheetPath = `xl/worksheets/sheet${i + 1}.xml`;
            const sheetXml = read(sheetPath);
            if (!sheetXml) continue;

            const id = i + 1;
            const rid = `rIdTable${id}`;
            const names = uniqueNames(spec.headers);
            const ref = `A1:${columnName(names.length)}${spec.rowCount + 1}`;

            out[`xl/tables/table${id}.xml`] =
              `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
              `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${id}" ` +
              `name="${namePrefix}${id}" displayName="${namePrefix}${id}" ref="${ref}" totalsRowShown="0">` +
              `<autoFilter ref="${ref}"/>` +
              `<tableColumns count="${names.length}">` +
              names.map((n, c) => `<tableColumn id="${c + 1}" name="${escapeAttr(n)}"/>`).join("") +
              `</tableColumns>` +
              `<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" ` +
              `showRowStripes="1" showColumnStripes="0"/>` +
              `</table>`;

            // The sheet must point at the table. Stripping a sheet-level autoFilter
            // is defensive — nothing adds one now that the table owns the filter, but
            // two filters over one range is a repair prompt if anything ever does.
            let nextSheet = sheetXml.replace(/<autoFilter\b[^>]*\/>/g, "");
            if (!nextSheet.includes("<tableParts")) {
              nextSheet = nextSheet.replace(
                "</worksheet>",
                `<tableParts count="1"><tablePart r:id="${rid}"/></tableParts></worksheet>`,
              );
            }
            out[sheetPath] = nextSheet;

            const relsPath = `xl/worksheets/_rels/sheet${id}.xml.rels`;
            const rel =
              `<Relationship Id="${rid}" ` +
              `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" ` +
              `Target="../tables/table${id}.xml"/>`;
            const existing = out[relsPath] ?? read(relsPath);
            out[relsPath] = existing
              ? existing.replace("</Relationships>", `${rel}</Relationships>`)
              : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
                `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
                `${rel}</Relationships>`;

            overrides.push(
              `<Override PartName="/xl/tables/table${id}.xml" ` +
                `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`,
            );
          }

          if (overrides.length === 0) return undefined;

          // Without this the file opens "repaired", with the tables quietly removed.
          const types = read("[Content_Types].xml");
          if (types) out["[Content_Types].xml"] = types.replace("</Types>", `${overrides.join("")}</Types>`);
          return out;
        },
      },
    },
  };
}
