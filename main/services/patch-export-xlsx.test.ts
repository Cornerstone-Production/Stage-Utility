import assert from "node:assert/strict";
import { describe, it } from "node:test";

import readXlsxFile from "read-excel-file/node";

import { EXPORT_HEADERS, type ExportRow } from "./patch-export.js";
import { toXlsx } from "./patch-export-xlsx.js";

/** The reader returns a list of sheets; this export writes exactly one.
 *  Blank cells come back as null rather than "", which is the reader's own
 *  convention and not something the writer should fight. */
async function rowsOf(buf: Buffer): Promise<unknown[][]> {
  const sheets = await readXlsxFile(buf);
  return sheets[0]!.data as unknown[][];
}

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  rackCh: "1", console: "01", dir: "in", label: "Kick", source: "Beta91",
  phantom: "48V", rack: "SD Rack", path: "", owner: "", notes: "",
  ...over,
});

describe("toXlsx", () => {
  it("round-trips through the reader the importer already uses", async () => {
    // The strongest available check: written by one library, read by the other.
    const buf = await toXlsx([row(), row({ console: "02", label: "Snare" })]);
    const sheet = await rowsOf(buf);
    assert.deepEqual(sheet[0], [...EXPORT_HEADERS]);
    assert.equal(sheet[1][3], "Kick");
    assert.equal(sheet[2][3], "Snare");
  });

  it("writes a header-only workbook for an empty sheet", async () => {
    const sheet = await rowsOf(await toXlsx([]));
    assert.equal(sheet.length, 1);
  });

  it("keeps a channel as text so a leading zero survives", async () => {
    // "01" is a real channel label on a patch sheet and must not become 1.
    const sheet = await rowsOf(await toXlsx([row({ console: "01" })]));
    assert.equal(sheet[1][1], "01");
    assert.equal(typeof sheet[1][1], "string");
  });

  it("keeps a numeric-looking connector as text too", async () => {
    const sheet = await rowsOf(await toXlsx([row({ rackCh: "007" })]));
    assert.equal(sheet[1][0], "007");
  });

  it("preserves a full hop chain in one cell", async () => {
    const sheet = await rowsOf(await toXlsx([row({ path: "Snake A:2 -> SD Rack:2" })]));
    assert.equal(sheet[1][7], "Snake A:2 -> SD Rack:2");
  });
});

describe("toXlsx blank cells", () => {
  it("writes a blank rather than the word 'null' for an empty field", async () => {
    // read-excel-file reports a blank cell as null; what matters is that nothing
    // literal was written into it.
    const sheets = await readXlsxFile(await toXlsx([row({ notes: "" })]));
    const cell = (sheets[0]!.data as unknown[][])[1]![9];
    assert.ok(cell === null || cell === "", `expected a blank, got ${JSON.stringify(cell)}`);
  });
});
