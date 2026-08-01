import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyed-store-"));
process.env.STAGE_UTILITY_DATA = dataDir;

const { KeyedRecordStore } = await import("./keyed-record-store.js");

interface Rec {
  serviceKey: string;
  startedAt: string;
  title?: string;
}

const make = (dir: string, legacy: string) =>
  new KeyedRecordStore<Rec>(dir, legacy, (r) => r.startedAt);

const rec = (key: string, startedAt: string, title = "x"): Rec => ({ serviceKey: key, startedAt, title });

test("a record round-trips through its own file", async () => {
  const s = make("t1", "t1.json");
  await s.upsert(rec("st:p:1", "2026-07-26T09:00:00.000Z", "hello"));
  assert.equal((await s.get("st:p:1"))?.title, "hello");
  const files = await fs.readdir(path.join(dataDir, "t1"));
  assert.deepEqual(files, ["st-p-1.json"], "one file, named after the sanitised key");
});

test("upsert writes only the record it was given", async () => {
  const s = make("t2", "t2.json");
  await s.upsert(rec("a:1", "2026-07-26T09:00:00.000Z"));
  await s.upsert(rec("b:2", "2026-07-27T09:00:00.000Z"));

  const before = await fs.stat(path.join(dataDir, "t2", "a-1.json"));
  await new Promise((r) => setTimeout(r, 12));
  await s.upsert(rec("b:2", "2026-07-27T09:00:00.000Z", "changed"));
  const after = await fs.stat(path.join(dataDir, "t2", "a-1.json"));

  assert.equal(before.mtimeMs, after.mtimeMs, "the untouched record's file was not rewritten");
  assert.equal((await s.get("b:2"))?.title, "changed");
});

test("list is newest first", async () => {
  const s = make("t3", "t3.json");
  await s.upsert(rec("a", "2026-01-01T00:00:00.000Z"));
  await s.upsert(rec("c", "2026-03-01T00:00:00.000Z"));
  await s.upsert(rec("b", "2026-02-01T00:00:00.000Z"));
  assert.deepEqual((await s.list()).map((r) => r.serviceKey), ["c", "b", "a"]);
});

test("delete removes the file and reports whether it existed", async () => {
  const s = make("t4", "t4.json");
  await s.upsert(rec("gone", "2026-01-01T00:00:00.000Z"));
  assert.equal(await s.delete("gone"), true);
  assert.equal(await s.delete("gone"), false, "second delete is a no-op");
  assert.equal(await s.get("gone"), null);
  assert.deepEqual(await fs.readdir(path.join(dataDir, "t4")), []);
});

test("a key with separators cannot escape the directory", async () => {
  const s = make("t5", "t5.json");
  await s.upsert(rec("../../etc/passwd", "2026-01-01T00:00:00.000Z"));
  const files = await fs.readdir(path.join(dataDir, "t5"));
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes("/") && !files[0].includes(".."), files[0]);
  assert.ok(await s.get("../../etc/passwd"), "still addressable by its real key");
});

test("the legacy single-document file is split into per-key files, once", async () => {
  await fs.writeFile(
    path.join(dataDir, "t6.json"),
    JSON.stringify({
      services: {
        "st:p:1": rec("st:p:1", "2026-01-01T00:00:00.000Z", "one"),
        "st:p:2": rec("st:p:2", "2026-01-08T00:00:00.000Z", "two"),
      },
    }),
  );
  const s = make("t6", "t6.json");
  assert.equal((await s.list()).length, 2, "both records came across");
  assert.equal((await s.get("st:p:2"))?.title, "two");
  assert.deepEqual((await fs.readdir(path.join(dataDir, "t6"))).sort(), ["st-p-1.json", "st-p-2.json"]);

  // The original is kept, not deleted — it is the only copy until the split is proven.
  await fs.stat(path.join(dataDir, "t6.json.migrated"));
  await assert.rejects(() => fs.stat(path.join(dataDir, "t6.json")), "legacy file moved aside");

  // A fresh store over the same directory must not migrate again.
  assert.equal((await make("t6", "t6.json").list()).length, 2);
});

test("migration never clobbers a per-key file that is already there", async () => {
  await fs.mkdir(path.join(dataDir, "t7"), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "t7", "st-p-1.json"),
    JSON.stringify(rec("st:p:1", "2026-01-01T00:00:00.000Z", "NEWER")),
  );
  await fs.writeFile(
    path.join(dataDir, "t7.json"),
    JSON.stringify({ services: { "st:p:1": rec("st:p:1", "2026-01-01T00:00:00.000Z", "older") } }),
  );
  const s = make("t7", "t7.json");
  assert.equal((await s.get("st:p:1"))?.title, "NEWER", "the split file wins over the legacy document");
});

test("an unparseable legacy file is left in place rather than lost", async () => {
  await fs.writeFile(path.join(dataDir, "t8.json"), "{ not json");
  const s = make("t8", "t8.json");
  assert.deepEqual(await s.list(), []);
  await fs.stat(path.join(dataDir, "t8.json")); // still there for recovery
});

test("one unreadable record does not take the rest of the history with it", async () => {
  const s = make("t9", "t9.json");
  await s.upsert(rec("good", "2026-01-01T00:00:00.000Z"));
  await fs.writeFile(path.join(dataDir, "t9", "broken.json"), "{ truncated");
  const fresh = make("t9", "t9.json");
  assert.deepEqual((await fresh.list()).map((r) => r.serviceKey), ["good"]);
});

test("a leftover .tmp file is ignored on load", async () => {
  const s = make("t10", "t10.json");
  await s.upsert(rec("ok", "2026-01-01T00:00:00.000Z"));
  await fs.writeFile(path.join(dataDir, "t10", "half.json.tmp"), "{ partial");
  assert.deepEqual((await make("t10", "t10.json").list()).map((r) => r.serviceKey), ["ok"]);
});

test("concurrent upserts all land", async () => {
  const s = make("t11", "t11.json");
  await Promise.all(
    Array.from({ length: 40 }, (_, i) => s.upsert(rec(`k${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`))),
  );
  assert.equal((await s.list()).length, 40);
  assert.equal((await fs.readdir(path.join(dataDir, "t11"))).filter((f) => f.endsWith(".json")).length, 40);
});
