// CSV, encoded here and parsed back there, with the awkward characters in it.
//
// Four hand-rolled CSV routines lived in three files: the archive's encoder and
// parser, the patch export's encoder, and the patch import's parser. They were
// written separately and quietly disagreed. This pins what each has to do
// BEFORE they are consolidated, so the consolidation is provably a refactor
// rather than a rewrite that happens to compile.
//
// Two disagreements matter and are asserted here as intended behaviour, not as
// accidents to be smoothed away:
//
//   The archive parser DROPS an incomplete final row. It reads append-only files
//   that a power cut can truncate mid-line, and a short row silently misaligns
//   against the header for the rest of the file.
//
//   The import parser KEEPS the final row. It reads files a spreadsheet wrote,
//   and Excel does not put a trailing newline on the last line. Dropping it
//   would silently lose the last channel of every patch sheet imported.
//
// One that is simply a bug, fixed by consolidating: the patch import's own
// encoder tested `/[",\n]/` and not `\r`, so a value containing a bare carriage
// return went out unquoted and came back as two rows.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeRow, parseRows, parseTable } from "./csv.js";
import { EXPORT_HEADERS, rowCells, type ExportRow } from "./patch-export.js";
import { toCsv } from "./patch-export-csv.js";

/** The values an engineer actually types into a patch sheet. */
const NASTY = [
  ["plain", "Kick In"],
  ["comma", "Vox 1, Vox 2"],
  ["quote", 'Snake "B" 12'],
  ["both", 'Amp "A", channel 3'],
  ["newline", "Line 1\nLine 2"],
  ["crlf", "Line 1\r\nLine 2"],
  ["bare CR", "Line 1\rLine 2"],
  ["leading space", "  padded"],
  ["only quotes", '""'],
  ["empty", ""],
  ["unicode", "Café — Grace’s Night"],
] as const;

describe("csv encode/parse round-trip", () => {
  for (const [name, value] of NASTY) {
    it(`survives a ${name} value`, () => {
      // Two columns, so a value that leaks its delimiter shows up as a column count
      // change rather than as a subtly different string.
      const text = encodeRow(["before", value, "after"]);
      const rows = parseRows(text);
      assert.equal(rows.length, 1, `${name}: produced ${rows.length} rows`);
      assert.equal(rows[0].length, 3, `${name}: produced ${rows[0].length} columns`);
      assert.equal(rows[0][0], "before");
      assert.equal(rows[0][2], "after");
      // Exact, including CR and LF: anything needing them is quoted on the way
      // out, and inside quotes every character is taken verbatim on the way in.
      assert.equal(rows[0][1], value, `${name}: value did not survive`);
    });
  }

  it("keeps every column of a multi-row table", () => {
    const text = [
      encodeRow(["at", "item", "note"]),
      encodeRow(["t1", 'a "quoted" item', "one, two"]),
      encodeRow(["t2", "line\nbreak", ""]),
    ].join("");
    assert.deepEqual(parseRows(text), [
      ["at", "item", "note"],
      ["t1", 'a "quoted" item', "one, two"],
      ["t2", "line\nbreak", ""],
    ]);
  });
});

describe("parseRows — the archive's rule", () => {
  it("drops a final row with no terminator", () => {
    // A file truncated mid-write by a power cut. The complete rows are all
    // readable; the partial tail must not become a short, misaligned row.
    const text = "a,b,c\n1,2,3\n4,5";
    assert.deepEqual(parseRows(text), [["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("drops a line cut off inside a quoted cell", () => {
    const text = 'a,b\n1,"unterminated';
    assert.deepEqual(parseRows(text), [["a", "b"]]);
  });
});

describe("parseTable — the importer's rule", () => {
  it("keeps a final row with no terminator", () => {
    // Excel does not write a trailing newline. Dropping this row would lose the
    // last channel of every imported patch sheet.
    const { headers, rows } = parseTable("Ch,Source\n1,Kick\n2,Snare");
    assert.deepEqual(headers, ["Ch", "Source"]);
    assert.deepEqual(rows, [["1", "Kick"], ["2", "Snare"]]);
  });

  it("skips blank lines rather than importing empty channels", () => {
    const { rows } = parseTable("Ch,Source\n1,Kick\n\n\n2,Snare\n");
    assert.deepEqual(rows, [["1", "Kick"], ["2", "Snare"]]);
  });

  it("trims the headers but not the data", () => {
    const { headers, rows } = parseTable(" Ch , Source \n 1 , Kick ");
    assert.deepEqual(headers, ["Ch", "Source"]);
    assert.deepEqual(rows, [[" 1 ", " Kick "]], "a leading space in a label is the operator's");
  });

  it("reads CRLF the same as LF", () => {
    const { headers, rows } = parseTable("Ch,Source\r\n1,Kick\r\n2,Snare\r\n");
    assert.deepEqual(headers, ["Ch", "Source"]);
    assert.deepEqual(rows, [["1", "Kick"], ["2", "Snare"]]);
  });

  it("keeps an embedded newline inside a quoted cell as one row", () => {
    const { rows } = parseTable('Ch,Notes\n1,"line one\nline two"');
    assert.deepEqual(rows, [["1", "line one\nline two"]]);
  });
});

describe("the patch export re-imports as itself", () => {
  const row = (over: Partial<ExportRow> = {}): ExportRow => ({
    rackCh: "1", console: "1", dir: "in", label: "Kick In", source: "e901",
    phantom: "", rack: "Snake B", path: "Snake B 1", owner: "Band", notes: "",
    ...over,
  });

  it("round-trips values carrying commas, quotes and newlines", () => {
    // The export is the document that gets printed and taped to a rack, and the
    // importer's own column detection reads it back. A quoting disagreement
    // between the two writers shifts every row's identity silently.
    const rows = [
      row({ label: "Vox 1, Vox 2" }),
      row({ rackCh: "2", notes: 'said "check one"' }),
      row({ rackCh: "3", notes: "line one\nline two" }),
      row({ rackCh: "4", label: "Café — Grace’s Night" }),
    ];
    const parsed = parseTable(toCsv(rows));

    assert.deepEqual(parsed.headers, [...EXPORT_HEADERS], "headers must survive verbatim");
    assert.equal(parsed.rows.length, rows.length, "a value leaked its delimiter and split a row");
    rows.forEach((r, i) => {
      assert.deepEqual(parsed.rows[i], rowCells(r), `row ${i} did not survive the round trip`);
    });
  });

  it("ends with a newline, which spreadsheet importers require", () => {
    assert.ok(toCsv([row()]).endsWith("\n"));
  });

  it("quotes a value containing a bare carriage return", () => {
    // The bug the import-side encoder had: it tested /[",\n]/ and not \r, so
    // this went out unquoted and came back as two rows.
    const text = toCsv([row({ notes: "one\rtwo" })]);
    assert.equal(parseTable(text).rows.length, 1, "a bare CR split the row");
  });
});
