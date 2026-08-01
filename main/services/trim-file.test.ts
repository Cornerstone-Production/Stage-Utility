import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { trimFileToLastBytes } from "./trim-file.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trim-file-"));
const tmp = (name: string) => path.join(dir, name);

after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("trimFileToLastBytes", () => {
  it("leaves a file under the budget alone", () => {
    const p = tmp("small.log");
    fs.writeFileSync(p, "one\ntwo\n");
    assert.equal(trimFileToLastBytes(p, 1024), false);
    assert.equal(fs.readFileSync(p, "utf8"), "one\ntwo\n");
  });

  it("keeps the tail and drops the partial first line", () => {
    const p = tmp("big.log");
    // 10 lines of 10 bytes each = 100 bytes.
    fs.writeFileSync(p, Array.from({ length: 10 }, (_, i) => `line-${i}xx`).join("\n") + "\n");
    assert.equal(trimFileToLastBytes(p, 25), true);

    const out = fs.readFileSync(p, "utf8");
    assert.ok(out.length <= 25, `expected <=25 bytes, got ${out.length}`);
    // Whatever survived must start at a line boundary, never mid-line.
    assert.ok(!out.startsWith("ine-"), `kept a partial line: ${JSON.stringify(out)}`);
    assert.ok(out.endsWith("line-9xx\n"), `lost the newest line: ${JSON.stringify(out)}`);
  });

  it("reports false for a file that does not exist rather than throwing", () => {
    assert.equal(trimFileToLastBytes(tmp("missing.log"), 10), false);
  });

  it("truncates rather than leaving stale bytes past the new end", () => {
    const p = tmp("shrink.log");
    fs.writeFileSync(p, "a".repeat(200) + "\n" + "b".repeat(20) + "\n");
    trimFileToLastBytes(p, 30);
    const out = fs.readFileSync(p, "utf8");
    // The old 200-byte run must be gone entirely, not merely overwritten in part.
    assert.ok(!out.includes("a".repeat(30)), "stale bytes survived the truncate");
    assert.equal(fs.statSync(p).size, out.length);
  });
});
