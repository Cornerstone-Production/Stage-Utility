// The table parts are hand-authored OOXML. Excel does not report a specific
// problem when they disagree — it offers to "repair" the file and silently drops
// the tables — so these assert the four parts that have to line up.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import writeXlsxFile from "write-excel-file/node";
import { unzipSync, strFromU8 } from "fflate";

import { tableFeature, type TableSpec } from "./xlsx-table.js";

const header = (t: string) => ({ value: t, type: String, fontWeight: "bold" as const });
const cell = (v: string | number) => (typeof v === "number" ? { value: v, type: Number } : { value: v, type: String });

/** Build a workbook and hand back its parts. */
async function build(sheets: { sheet: string; data: unknown[][] }[], specs: TableSpec[]) {
  const buf = await writeXlsxFile(
    sheets.map((s) => ({ sheet: s.sheet, stickyRowsCount: 1, data: s.data })) as never,
    { features: [tableFeature(specs)] } as never,
  ).toBuffer();
  const files = unzipSync(new Uint8Array(buf));
  const text = (p: string) => (files[p] ? strFromU8(files[p]) : undefined);
  return { files, text, tables: Object.keys(files).filter((n) => n.startsWith("xl/tables/")).sort() };
}

const DATASET = {
  sheet: "SPL",
  data: [
    [header("Date"), header("Item"), header("LAeq Max")],
    [cell("2026-07-26"), cell("SONG: Way Maker"), cell(102.4)],
    [cell("2026-07-26"), cell("Welcome"), cell(94.1)],
  ],
};
const SPEC: TableSpec = { headers: ["Date", "Item", "LAeq Max"], rowCount: 2 };

// Not covered: the defensive strip of a sheet-level autoFilter. Nothing emits one
// now, so a test for it would pass whether or not the code ran.
describe("tableFeature", () => {
  test("all four parts are present and agree", async () => {
    const { text, tables } = await build([DATASET], [SPEC]);
    assert.deepEqual(tables, ["xl/tables/table1.xml"]);
    assert.match(text("[Content_Types].xml")!, /PartName="\/xl\/tables\/table1\.xml"/);
    assert.match(text("xl/worksheets/sheet1.xml")!, /<tableParts count="1"><tablePart r:id="rIdTable1"\/><\/tableParts>/);
    assert.match(text("xl/worksheets/_rels/sheet1.xml.rels")!, /Id="rIdTable1"[^>]*Target="\.\.\/tables\/table1\.xml"/);
  });

  test("column names match the header row exactly — Excel repairs the file if not", async () => {
    const { text } = await build([DATASET], [SPEC]);
    const names = [...text("xl/tables/table1.xml")!.matchAll(/<tableColumn[^>]*name="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(names, ["Date", "Item", "LAeq Max"]);
  });

  test("the range covers the header plus every data row", async () => {
    const { text } = await build([DATASET], [SPEC]);
    assert.match(text("xl/tables/table1.xml")!, /<table[^>]*ref="A1:C3"/);
  });

  test("a sheet that is not a dataset gets no table", async () => {
    // The About page is label/value pairs; a table there would name its columns
    // after the first row.
    const about = { sheet: "About", data: [[cell("Stage Utility"), cell("Service history export")]] };
    const { tables, text } = await build([about, DATASET], [{ headers: [], rowCount: 0 }, SPEC]);
    assert.deepEqual(tables, ["xl/tables/table2.xml"], "only the dataset is tabled");
    assert.doesNotMatch(text("xl/worksheets/sheet1.xml")!, /<tableParts/);
  });

  test("a header with no rows under it is left alone", async () => {
    const empty = { sheet: "Empty", data: [[header("Date")]] };
    const { tables } = await build([empty], [{ headers: ["Date"], rowCount: 0 }]);
    assert.deepEqual(tables, [], "Excel rejects a single-row table range");
  });

  test("every declared content-type override has a matching part", async () => {
    const { text, tables } = await build([DATASET, { ...DATASET, sheet: "SPL data" }], [SPEC, SPEC]);
    const declared = [...text("[Content_Types].xml")!.matchAll(/PartName="\/xl\/tables\/(table\d+\.xml)"/g)]
      .map((m) => m[1])
      .sort();
    assert.deepEqual(declared, tables.map((t) => t.split("/").pop()).sort());
  });

  test("each table gets its own name, since Excel requires them unique", async () => {
    const { text } = await build([DATASET, { ...DATASET, sheet: "SPL data" }], [SPEC, SPEC]);
    const names = ["xl/tables/table1.xml", "xl/tables/table2.xml"].map(
      (p) => /displayName="([^"]+)"/.exec(text(p)!)![1],
    );
    assert.equal(new Set(names).size, 2, `duplicate table names: ${names.join(", ")}`);
  });

  test("duplicate headings are disambiguated rather than repeated", async () => {
    // Excel rejects a table with two columns of the same name.
    const { text } = await build([DATASET], [{ headers: ["Date", "Date", "Date"], rowCount: 2 }]);
    const names = [...text("xl/tables/table1.xml")!.matchAll(/<tableColumn[^>]*name="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(names).size, 3, `not unique: ${names.join(", ")}`);
  });

});
