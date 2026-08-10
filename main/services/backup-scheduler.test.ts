import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-"));
process.env.STAGE_UTILITY_DATA = dataDir;

const { DEFAULT_BACKUP_SCHEDULE, isDue, ownBackupPattern, prune } = await import("./backup-scheduler.js");

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
  await prune(dir, "config-", 10, ".json");
  const left = (await fs.readdir(dir)).sort();
  assert.equal(left.length, 10);
  assert.ok(left.at(-1)!.includes("2026-08-15"), "newest kept");
  assert.ok(!left.some((n) => n.includes("2026-08-05")), "oldest gone");
});

test("fewer files than the limit deletes nothing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prune-"));
  await seed(dir, "config-", 3);
  assert.deepEqual(await prune(dir, "config-", 10, ".json"), []);
  assert.equal((await fs.readdir(dir)).length, 3);
});

test("pruning one kind leaves the other alone", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prune-"));
  await seed(dir, "config-", 12);
  await seed(dir, "archive-", 4);
  await prune(dir, "config-", 10, ".json");
  const left = await fs.readdir(dir);
  assert.equal(left.filter((n) => n.startsWith("config-")).length, 10);
  assert.equal(left.filter((n) => n.startsWith("archive-")).length, 4, "archives untouched");
});

test("unrelated files in the destination are never deleted", async () => {
  // The destination may be a shared folder on a NAS holding other things.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prune-"));
  await seed(dir, "config-", 12);
  await fs.writeFile(path.join(dir, "someone-elses-file.txt"), "keep me");
  await prune(dir, "config-", 1, ".json");
  const left = await fs.readdir(dir);
  assert.ok(left.includes("someone-elses-file.txt"));
  assert.equal(left.filter((n) => n.startsWith("config-")).length, 1);
});

test("a keep of zero still leaves one — never prune everything", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prune-"));
  await seed(dir, "config-", 5);
  await prune(dir, "config-", 0, ".json");
  assert.equal((await fs.readdir(dir)).length, 1);
});

test("a missing destination is not an error", async () => {
  assert.deepEqual(await prune(path.join(dataDir, "nope"), "config-", 10, ".json"), []);
});

// The destination is a plain path so it can point at a mounted share. An operator
// pointing it at an existing backups folder on the NAS — the obvious thing to do —
// could already hold files from another tool whose names start the same way. A
// bare startsWith(prefix) deleted those on the first successful run, silently.
test("prune leaves files this scheduler did not write", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-prune-foreign-"));
  const foreign = ["config-2024.json", "config-old.json", "archive-old.zip", "config-notes.txt"];
  for (const n of foreign) await fs.writeFile(path.join(dir, n), "someone else's");
  // More of our own than `keep`, so prune definitely deletes something.
  for (const t of ["2026-08-01T10-00-00-000", "2026-08-02T10-00-00-000", "2026-08-03T10-00-00-000"]) {
    await fs.writeFile(path.join(dir, `config-${t}.json`), "{}");
  }

  const doomed = await prune(dir, "config-", 1, ".json");
  assert.equal(doomed.length, 2, "should have pruned two of its own");

  const left = await fs.readdir(dir);
  for (const n of foreign) assert.ok(left.includes(n), `deleted a file it did not write: ${n}`);
});

test("the prune pattern matches the stamp its own writer produces", () => {
  // Guards the pattern and the stamp format against drifting apart, which would
  // make prune silently stop pruning and let backups grow without bound.
  const at = new Date("2026-08-09T19:58:49.567Z").toISOString().replace(/[:.]/g, "-").replace("Z", "");
  assert.ok(ownBackupPattern("config-", ".json").test(`config-${at}.json`), "does not match its own output");
  assert.ok(!ownBackupPattern("config-", ".json").test("config-2024.json"));
  assert.ok(!ownBackupPattern("config-", ".json").test(`config-${at}.zip`), "extension must matter");
});
