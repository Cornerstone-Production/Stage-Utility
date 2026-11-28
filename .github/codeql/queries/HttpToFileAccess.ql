/**
 * @name Network data written to file
 * @description Writing network data directly to the file system allows arbitrary file upload and might indicate a backdoor.
 * @kind path-problem
 * @problem.severity warning
 * @security-severity 6.3
 * @precision medium
 * @id js/http-to-file-access
 * @tags security
 *       external/cwe/cwe-912
 *       external/cwe/cwe-434
 */

// The stock js/http-to-file-access (Security/CWE-912), unchanged except for importing
// EncodeRowBarrier, which adds a subclass of the stock Sanitizer. A data extension cannot
// add to that class (the model pack reaches only what a library reads through a model),
// but a query can. The stock configuration is reused as it is, so anything CodeQL adds to
// it later applies here too. The rule id is kept, so an alert this stops reporting closes
// rather than a new one opening; codeql-config.yml drops the stock query.
//
// Tested by .github/codeql/tests/queries.

import javascript
import semmle.javascript.security.dataflow.HttpToFileAccessQuery
import HttpToFileAccessFlow::PathGraph
import EncodeRowBarrier

from HttpToFileAccessFlow::PathNode source, HttpToFileAccessFlow::PathNode sink
where HttpToFileAccessFlow::flowPath(source, sink)
select sink.getNode(), source, sink, "Write to file system depends on $@.", source.getNode(),
  "Untrusted data"
