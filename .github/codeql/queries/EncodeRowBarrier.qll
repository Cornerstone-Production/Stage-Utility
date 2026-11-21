// The one barrier this repository adds to js/http-to-file-access.
//
// What it asserts is CSV STRUCTURE and nothing more. encodeRow (main/services/csv.ts)
// quotes a comma, quote, CR or LF, so whatever it is given comes out as one record with
// the columns it was handed. It does not neutralise content: "<script>" or a leading "="
// passes through unchanged.
//
// This query's sink is the data written. The destination path is not checked by it, and
// js/path-injection does not treat a network response as a source, so a write whose PATH
// came from the network, with encodeRow'd content, is reported by neither. That is the
// trade-off, and the fixture .github/codeql/tests/queries/main/services/network-path.ts
// records it. Nothing here builds a path from the network: the archive's is
// [A-Za-z0-9._-] only (archive-paths.ts).
//
// Only encodeRow is covered. encodeRows (rows.map(encodeRow)) and mergeCsv(..., encodeRow)
// are not: a flow through either is still reported, which fails safe.

import javascript
import semmle.javascript.security.dataflow.HttpToFileAccessCustomizations

/** A call to encodeRow in main/services/csv.ts: its result is a single CSV record. */
class EncodeRowResult extends HttpToFileAccess::Sanitizer, DataFlow::CallNode {
  EncodeRowResult() {
    exists(Function f |
      f.getName() = "encodeRow" and
      f.getFile().getRelativePath() = "main/services/csv.ts" and
      this.getACallee() = f
    )
  }
}
