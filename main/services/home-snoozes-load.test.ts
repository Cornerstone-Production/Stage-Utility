// What start() does with a file written by an earlier run: a snooze that has
// already lapsed is not brought back, and a line that is not a snooze is skipped.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-home-snoozes-load-"));
process.env.STAGE_UTILITY_DATA = TMP;
const now = Date.now();
await fs.writeFile(
  path.join(TMP, "home-snoozes.json"),
  JSON.stringify({
    snoozes: [
      { key: "screen:expired", severity: "warn", at: now - 99_999, expiresAt: now - 1 },
      { key: "screen:live", severity: "warn", at: now, expiresAt: now + 60_000 },
      { key: "no spaces allowed", severity: "warn", at: now, expiresAt: null },
      { key: "screen:badsev", severity: "meh", at: now, expiresAt: null },
    ],
  }),
);

const { HomeSnoozes } = await import("./home-snoozes.js");

it("start() keeps an unexpired snooze and skips an expired one and malformed ones", async () => {
  const h = new HomeSnoozes();
  await h.start();
  assert.deepEqual(h.state().snoozes.map((s) => s.key), ["screen:live"]);
});
