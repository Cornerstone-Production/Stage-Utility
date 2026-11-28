import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { fileExists } from "./file-exists.js";

test("true for a file, false for one that is not there, and a failure to look is thrown, not 'absent'", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-exists-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "here");
  await fs.writeFile(file, "x");
  assert.equal(await fileExists(file), true);
  assert.equal(await fileExists(path.join(dir, "not-here")), false);
  // A path under a file is ENOTDIR: the platform cannot say whether it exists.
  await assert.rejects(() => fileExists(path.join(file, "child")), (err: NodeJS.ErrnoException) => err.code === "ENOTDIR");
});
