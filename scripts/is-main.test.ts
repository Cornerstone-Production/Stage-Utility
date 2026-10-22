// is-main.test.ts — a script knows it is the one that was run, on Windows too.
//
// manifest-changed.mjs decided that with `import.meta.url.endsWith(argv[1].split("/").pop())`.
// On Windows argv[1] has backslashes, so that is never true: the script printed nothing, and
// the update read that as "no dependency changed" and skipped `npm ci`. Every script that runs
// itself now asks isMain; this holds it to Windows-shaped input, and runs each real script.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { isMain } from "./is-main.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

describe("isMain", () => {
  test("is true for the script itself, however the host writes its path", () => {
    assert.equal(isMain("file:///C:/repo/scripts/manifest-changed.mjs", "C:\\repo\\scripts\\manifest-changed.mjs", { windows: true }), true);
    assert.equal(isMain("file:///C:/repo/scripts/manifest-changed.mjs", "c:\\repo\\scripts\\.\\manifest-changed.mjs", { windows: true }), true, "a drive letter's case");
    assert.equal(isMain(`file://${SCRIPTS}/is-main.mjs`, path.join(SCRIPTS, "is-main.mjs")), true);
  });

  test("is false for another script of the same name elsewhere, and for no script", () => {
    assert.equal(isMain("file:///C:/repo/scripts/x.mjs", "C:\\other\\scripts\\x.mjs", { windows: true }), false);
    assert.equal(isMain("file:///repo/scripts/x.mjs", "/other/x.mjs"), false);
    assert.equal(isMain("file:///repo/scripts/x.mjs", undefined), false);
    assert.equal(isMain("file:///repo/scripts/x.mjs", ""), false);
  });

  test("follows a symlink to the script", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "is-main-"));
    try {
      const link = path.join(dir, "link.mjs");
      fs.symlinkSync(path.join(SCRIPTS, "is-main.mjs"), link);
      assert.equal(isMain(`file://${SCRIPTS}/is-main.mjs`, link), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("every script that runs itself asks it", () => {
  test("and runs when started by its own path, which is the decision isMain makes", () => {
    // Real runs: each of these printed nothing, or did nothing, when the check was false.
    const manifest = spawnSync(process.execPath, [path.join(SCRIPTS, "manifest-changed.mjs"), "HEAD", "HEAD"], { encoding: "utf8" });
    assert.equal(manifest.stdout, '{"deps":false,"manifest":false}');
    const inputs = spawnSync(process.execPath, [path.join(SCRIPTS, "build-inputs.mjs")], { input: "renderer/x.ts\n", encoding: "utf8" });
    assert.equal(inputs.stdout, "true");
  });

  test("none of them decides it from a suffix of the URL", () => {
    const offenders = fs
      .readdirSync(SCRIPTS)
      .filter((f) => /\.(mjs|ts)$/.test(f) && !f.endsWith(".test.ts"))
      .filter((f) => /import\.meta\.url\s*(\.endsWith|===\s*pathToFileURL)|\.split\("\/"\)\.pop\(\)/.test(fs.readFileSync(path.join(SCRIPTS, f), "utf8")));
    assert.deepEqual(offenders, []);
  });
});
