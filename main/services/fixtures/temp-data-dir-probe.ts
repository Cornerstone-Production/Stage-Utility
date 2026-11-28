// temp-data-dir-probe.ts — run as a child by temp-data-dir.test.ts, so the
// dir's removal can be checked after the process that owned it has ended.

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { after, test } from "node:test";

import { tempDataDir } from "./temp-data-dir.js";

const dir = tempDataDir("temp-data-dir-probe-", { home: true });

test("the dir is set while the file runs", () => {
  writeFileSync(join(dir, "marker"), "x");
  appendFileSync(process.env.PROBE_REPORT as string, JSON.stringify({ dir, env: process.env.STAGE_UTILITY_DATA, home: process.env.HOME }));
});

// Registered after tempDataDir's own cleanup: the dir must still be there.
after(() => {
  appendFileSync(process.env.PROBE_REPORT as string, `\n${JSON.stringify({ presentInLaterAfter: existsSync(dir) })}`);
});
