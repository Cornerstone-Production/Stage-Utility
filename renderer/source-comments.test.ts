// The guard on the comment stripper the source-reading guards depend on.
//
// If it blanks too little, a comment satisfies an assertion — the failure it
// exists to stop. If it blanks too much, it swallows code and hides the thing
// the assertion was checking, which is the other half of the same mistake and
// has also happened here.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { withoutComments } from "./source-comments.js";

describe("withoutComments", () => {
  test("blanks a whole-line comment, a trailing one, and a block", () => {
    const src = ["// views:setSurface", 'call("a"); // views:setSurface', "/* views:setSurface */", ""].join(
      "\n",
    );
    const out = withoutComments(src);
    assert.doesNotMatch(out, /views:setSurface/, "a comment survived and can satisfy an assertion");
    assert.match(out, /call\("a"\);/, "the code on the line was swallowed with the comment");
  });

  test("leaves `//` that is inside a string alone", () => {
    // The reason this is a scanner. A regex cut at the first `//` eats the rest
    // of the line, which is how a scan in this repo hid a route that exists.
    for (const src of ['const u = "https://example.test/x";', "const t = `https://example.test/x`;"]) {
      assert.match(withoutComments(src), /https:\/\/example\.test\/x/, `mangled: ${src}`);
    }
  });

  test("keeps every offset and line, so a caller's cut still lands", () => {
    const src = 'a; // one\nb; /* two\nthree */ c;\n';
    const out = withoutComments(src);
    assert.equal(out.length, src.length, "offsets moved");
    assert.equal(out.split("\n").length, src.split("\n").length, "lines were lost");
    assert.match(out, /^a; {7}\nb; {7}\n {9}c;\n$/, out);
  });

  test("handles a template holding a template", () => {
    const src = "const s = `a ${x ? `b // c` : \"d\"} e`; // gone\n";
    const out = withoutComments(src);
    assert.match(out, /b \/\/ c/, "a `//` inside a nested template was treated as a comment");
    assert.doesNotMatch(out, /gone/, "the real trailing comment survived");
  });
});
