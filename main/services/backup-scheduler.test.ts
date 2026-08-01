import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-"));
process.env.STAGE_UTILITY_DATA = dataDir;

const { DEFAULT_BACKUP_SCHEDULE, isDue, prune } = await import("./backup-scheduler.js");

const DAY = 24 * 60 * 60 * 1000;
const sched = (over: Partial<typeof DEFAULT_BACKUP_SCHEDULE> = {}) => ({
  ...DEFAULT_BACKUP_SCHEDULE,
  ...over,
});

// ── When a backup is due ───────────────────────────────────────────────────

test("never having run is due, so enabling it produces one promptly", () => {
  assert.equal(isDue(sched({ lastRunAt: null }), Date.now()), true);
});

test("not due until a full interval has passed", () => {
  const now = Date.now();
  const s = sched({ intervalDays: 7, lastRunAt: new Date(now - 6 * DAY).toISOString() });
  assert.equal(isDue(s, now), false);
});

test("due once the interval has passed", () => {
  const now = Date.now();
  const s = sched({ intervalDays: 7, lastRunAt: new Date(now - 7 * DAY - 1000).toISOString() });
  assert.equal(isDue(s, now), true);
});

test("a box off for a month is due once, not once per missed interval", () => {
  // The schedule holds a last-run time, not a queue — catching up runs one backup.
  const now = Date.now();
  const s = sched({ intervalDays: 1, lastRunAt: new Date(now - 30 * DAY).toISOString() });
  assert.equal(isDue(s, now), true);
});

test("an unparseable last-run is treated as never run rather than never due", () => {
  assert.equal(isDue(sched({ lastRunAt: "not a date" }), Date.now()), true);
});

test("a daily interval is due the next day", () => {
  const now = Date.now();
  assert.equal(isDue(sched({ intervalDays: 1, lastRunAt: new Date(now - 25 * 3600_000).toISOString() }), now), true);
  assert.equal(isDue(sched({ intervalDays: 1, lastRunAt: new Date(now - 23 * 3600_000).toISOString() }), now), false);
});

// ── Retention ──────────────────────────────────────────────────────────────

async function seed(dir: string, prefix: string, n: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (let i = 1; i <= n; i++) {
    await fs.writeFile(path.join(dir, `${prefix}2026-08-${String(i).padStart(2, "0")}T00-00-00-000.json`), "x");
  }
}

test("keeps the newest N and deletes the rest", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prune-"));
  await seed(dir, "config-", 15);
  await prune(dir, "config-", 10);
  const left = (await fs.readdir(dir)).sort();
  assert.equal(left.length, 10);
  assert.ok(left.at(-1)!.includes("2026-08-15"), "newest kept");
  assert.ok(!left.some((n) => n.includes("2026-08-05")), "oldest gone");
});

test("fewer files than the limit deletes nothing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prune-"));
  await seed(dir, "config-", 3);
  assert.deepEqual(await prune(dir, "config-", 10), []);
  assert.equal((await fs.readdir(dir)).length, 3);
});

test("pruning one kind leaves the other alone", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prune-"));
  await seed(dir, "config-", 12);
  await seed(dir, "archive-", 4);
  await prune(dir, "config-", 10);
  const left = await fs.readdir(dir);
  assert.equal(left.filter((n) => n.startsWith("config-")).length, 10);
  assert.equal(left.filter((n) => n.startsWith("archive-")).length, 4, "archives untouched");
});

test("unrelated files in the destination are never deleted", async () => {
  // The destination may be a shared folder on a NAS holding other things.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prune-"));
  await seed(dir, "config-", 12);
  await fs.writeFile(path.join(dir, "someone-elses-file.txt"), "keep me");
  await prune(dir, "config-", 1);
  const left = await fs.readdir(dir);
  assert.ok(left.includes("someone-elses-file.txt"));
  assert.equal(left.filter((n) => n.startsWith("config-")).length, 1);
});

test("a keep of zero still leaves one — never prune everything", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prune-"));
  await seed(dir, "config-", 5);
  await prune(dir, "config-", 0);
  assert.equal((await fs.readdir(dir)).length, 1);
});

test("a missing destination is not an error", async () => {
  assert.deepEqual(await prune(path.join(dataDir, "nope"), "config-", 10), []);
});
