// What start() does with a file it cannot use: a value that is not a metric name
// is treated as unset and said so on the log, and is left in the file for a hand
// edit or a restore to fix. Nothing the operator wrote is deleted to tidy up.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { it, mock } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-trends-prefs-load-"));
process.env.STAGE_UTILITY_DATA = TMP;
const FILE = path.join(TMP, "trends-prefs.json");
await fs.writeFile(FILE, JSON.stringify({ soundMetric: "bad\nvalue" }));

const warned: string[] = [];
mock.method(console, "warn", (...a: unknown[]) => void warned.push(a.map(String).join(" ")));

const { TrendsPrefs } = await import("./trends-prefs.js");

it("a bad value on disk is treated as unset, logged, and left in the file", async () => {
  const prefs = new TrendsPrefs();
  await prefs.start();
  assert.equal(prefs.state().soundMetric, null);
  assert.ok(warned.some((l) => l.startsWith("[history] trends-prefs.json holds a sound metric")), warned.join("\n"));
  assert.ok(!warned.some((l) => l.includes("\n")), "the stored text is scrubbed before it reaches a log line");
  assert.equal(JSON.parse(await fs.readFile(FILE, "utf8")).soundMetric, "bad\nvalue");
});
