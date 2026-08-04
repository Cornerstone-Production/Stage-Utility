import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toCsv } from "./patch-export-csv.js";
import { EXPORT_HEADERS, type ExportRow } from "./patch-export.js";

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  channel: "01", dir: "in", label: "Kick", source: "Beta91",
  rack: "SD Rack", connector: "1", path: "", owner: "", notes: "",
  ...over,
});

describe("toCsv", () => {
  it("writes the header row first", () => {
    assert.equal(toCsv([]).split("\n")[0], EXPORT_HEADERS.join(","));
  });

  it("emits a header even with no rows, so an empty patch is still a valid file", () => {
    assert.equal(toCsv([]).trim().split("\n").length, 1);
  });

  it("quotes a value containing a comma", () => {
    assert.match(toCsv([row({ notes: "SM58, tight" })]), /"SM58, tight"/);
  });

  it("doubles an embedded quote, per RFC 4180", () => {
    assert.match(toCsv([row({ label: 'The "A" Rig' })]), /"The ""A"" Rig"/);
  });

  it("quotes a value containing a newline rather than breaking the row", () => {
    assert.match(toCsv([row({ notes: "line one\nline two" })]), /"line one\nline two"/);
  });

  it("leaves an ordinary value unquoted", () => {
    assert.equal(toCsv([row()]).split("\n")[1], "01,in,Kick,Beta91,SD Rack,1,,,");
  });

  it("writes one cell per header on every row", () => {
    // A row that drifted out of step with the headers would silently shift every
    // column after it in the spreadsheet.
    const lines = toCsv([row(), row({ channel: "02" })]).trim().split("\n");
    for (const l of lines) assert.equal(l.split(",").length, EXPORT_HEADERS.length);
  });

  it("keeps a hop chain intact — the arrow is not a separator", () => {
    assert.match(toCsv([row({ path: "Snake A:2 -> SD Rack:2" })]), /Snake A:2 -> SD Rack:2/);
  });

  it("ends with a trailing newline, which spreadsheet tools expect", () => {
    assert.ok(toCsv([row()]).endsWith("\n"));
  });
});
