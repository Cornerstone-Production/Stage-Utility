// The download-name check, and the guard that every route building a
// Content-Disposition header goes through it.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { attachmentDisposition, safeFilename } from "./export-filename.js";

describe("attachmentDisposition", () => {
  test("names a server-built download", () => {
    assert.equal(attachmentDisposition("stage-utility-history-2026-01-04_to_2026-02-01.xlsx"), 'attachment; filename="stage-utility-history-2026-01-04_to_2026-02-01.xlsx"');
    assert.equal(attachmentDisposition("stage_utility.yaml"), 'attachment; filename="stage_utility.yaml"');
  });

  // Each of these would break the quoted value open, end the header, or name a
  // path rather than a file.
  for (const bad of ['a"b.xlsx', "a\r\nSet-Cookie: x.xlsx", "../etc.json", "a/b.json", "a;b.json", " a.json", ".hidden", "", "café.json", "x".repeat(256)]) {
    test(`refuses ${JSON.stringify(bad.slice(0, 40))}`, () => {
      assert.throws(() => attachmentDisposition(bad), /unsafe characters/);
      assert.throws(() => safeFilename(bad), /unsafe characters/);
    });
  }

  test("a 255-character name is still a name", () => {
    assert.equal(safeFilename("x".repeat(255)), "x".repeat(255));
  });
});

describe("Content-Disposition is built through attachmentDisposition", () => {
  // Walks the server source for the header's name in any quotes ('', "", ``).
  // Each one is a site, and it is built through the helper only when the name
  // is an object key or a setHeader() argument whose value is
  // attachmentDisposition(...). Anything else counts as by hand: a name kept in
  // a constant, a computed key, or a quoted mention in prose. A comment naming
  // the header without quotes is not a site. So the scan fails closed: a stray
  // mention can only add an offender, never hide one.
  const MAIN = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const SITE = /["'`]content-disposition["'`]/gi;
  const THROUGH_HELPER = /^\]?\s*[:,]\s*attachmentDisposition\(/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  test("only the files still to migrate build the value by hand", () => {
    const sites: string[] = [];
    const byHand: string[] = [];
    for (const file of walk(MAIN)) {
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(SITE)) {
        const rel = path.relative(MAIN, file).split(path.sep).join("/");
        sites.push(rel);
        if (!THROUGH_HELPER.test(src.slice(m.index + m[0].length))) byHand.push(rel);
      }
    }
    // Every header site found, so a scan that silently matches nothing cannot pass.
    assert.deepEqual(sites.sort(), [
      "services/remote-server.ts",
      "services/routes/archive-routes.ts",
      "services/routes/cue-routes.ts",
      "services/routes/kiosk-device-routes.ts",
      "services/routes/plan-routes.ts",
      "services/routes/servicecue-routes.ts",
      "services/routes/servicecue-routes.ts",
      "services/routes/system-routes.ts",
      "services/routes/video-routes.ts",
      "services/routes/view-routes.ts",
    ]);
    // Files other work was changing when the helper landed. Each one migrated
    // comes off this list; nothing is ever added to it.
    assert.deepEqual(byHand.sort(), [
      "services/remote-server.ts",
      "services/routes/kiosk-device-routes.ts",
      "services/routes/system-routes.ts",
    ]);
  });
});
