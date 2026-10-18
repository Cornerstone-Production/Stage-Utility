import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyed-store-"));
process.env.STAGE_UTILITY_DATA = dataDir;

const { KeyedRecordStore } = await import("./keyed-record-store.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

interface Rec {
  serviceKey: string;
  startedAt: string;
  title?: string;
}

const make = (dir: string, legacy: string) =>
  new KeyedRecordStore<Rec>(dir, legacy, (r) => r.startedAt, "runtime");

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

// ── Concurrency, after the atomic-write and single-load fixes ──────────────
//
// writeOne used a temp path fixed at `${file}.tmp` — the exact shape
// write-queue.ts was written to remove. DataStore and secrets.ts were converted
// in the same session this store was not: the same fix landing on two of three
// call sites, in the store holding every recorded service.
//
// Within one instance upsert() is serialised, so the hazard needs a second
// writer — which exists: migrateLegacy calls writeOne from inside loadAll, and
// loadAll is reached by get()/list() OUTSIDE the write queue.

test("two writers to one key cannot splice each other's bytes", async () => {
  // Deliberately TWO instances over one directory — a second process over the
  // same data dir is the other way in. Payloads of different lengths, so a
  // splice leaves a file that is unparseable or the wrong size rather than one
  // that happens to look fine.
  const a = make("t12", "t12.json");
  const b = make("t12", "t12.json");
  const big = (c: string, n: number) => ({ serviceKey: "one", startedAt: "2026-01-01T00:00:00.000Z", title: c.repeat(n) });
  await Promise.all([
    ...Array.from({ length: 6 }, () => a.upsert(big("a", 500_000))),
    ...Array.from({ length: 6 }, () => b.upsert(big("b", 300_000))),
  ]);

  const names = await fs.readdir(path.join(dataDir, "t12"));
  assert.deepEqual(names.filter((n) => n.endsWith(".tmp")), [], "a scratch file survived the write");

  const raw = await fs.readFile(path.join(dataDir, "t12", "one.json"), "utf8");
  const parsed = JSON.parse(raw) as Rec; // throws outright on a spliced file
  assert.ok(/^a+$/.test(parsed.title!) || /^b+$/.test(parsed.title!), "the record mixes two writers' bytes");
  assert.ok(
    parsed.title!.length === 500_000 || parsed.title!.length === 300_000,
    `record is ${parsed.title!.length} bytes — neither writer wrote that`,
  );
});

test("concurrent readers share one load rather than each doing it", async () => {
  // list() and get() do not go through the write queue, so two arriving
  // together each ran the whole directory scan AND migrateLegacy — which
  // renames the legacy file out from under the other, leaving one of them with
  // an empty history.
  const seed = make("t13", "t13.json");
  await seed.upsert(rec("a", "2026-01-01T00:00:00.000Z"));

  const fresh = make("t13", "t13.json");
  // Counted on the instance, which shadows the prototype method. The ESM
  // namespace holding fs.readdir is frozen, so the scan itself cannot be spied
  // on — this is the same question one level up.
  const spy = fresh as unknown as { loadOnce: () => Promise<unknown> };
  const real = spy.loadOnce.bind(fresh);
  let loads = 0;
  spy.loadOnce = () => {
    loads += 1;
    return real();
  };

  await Promise.all([fresh.list(), fresh.list(), fresh.list(), fresh.get("a")]);
  assert.equal(loads, 1, `four concurrent readers ran ${loads} full loads`);
  await fresh.list();
  assert.equal(loads, 1, "the cache did not hold afterwards");
});

test("a legacy document is migrated once even under concurrent reads", async () => {
  await fs.writeFile(
    path.join(dataDir, "t14.json"),
    JSON.stringify({
      services: {
        a: rec("a", "2026-01-01T00:00:00.000Z", "one"),
        b: rec("b", "2026-01-08T00:00:00.000Z", "two"),
      },
    }),
  );
  const s = make("t14", "t14.json");
  const [one, two, three] = await Promise.all([s.list(), s.list(), s.list()]);
  for (const got of [one, two, three]) assert.equal(got.length, 2, "a concurrent reader saw an empty history");
  await fs.stat(path.join(dataDir, "t14.json.migrated"));
});

test("invalidate() beats a load already in flight", async () => {
  // config import rewrites the directory behind the store's back and calls
  // invalidate(). A load that started before that must not install its
  // pre-import view as the cache afterwards.
  const seed = make("t15", "t15.json");
  await seed.upsert(rec("a", "2026-01-01T00:00:00.000Z", "before"));

  const fresh = make("t15", "t15.json");
  const inFlight = fresh.list();
  fresh.invalidate();
  await fs.writeFile(
    path.join(dataDir, "t15", "a.json"),
    JSON.stringify(rec("a", "2026-01-01T00:00:00.000Z", "after")),
  );
  await inFlight;

  assert.equal((await fresh.get("a"))?.title, "after", "the stale load was cached over the import");
});

// ── A record file that is there and cannot be read ──
//
// Taken for absent, a recorder restarted mid-service found no record, began a
// fresh one, and its first save renamed over the file that held everything
// recorded before the restart. A file that will not parse went the same way.

/** File permissions do not stop root, so the permission cases skip there. */
const asRoot = process.getuid?.() === 0;

async function heldFiles(dir: string): Promise<string[]> {
  return (await fs.readdir(path.join(dataDir, dir))).filter((n) => n.includes(".held-")).sort();
}

test("a save for a record that could not be read goes beside it, never over it", { skip: asRoot }, async (t) => {
  const lines = captureConsole(t, "error");
  const first = make("u1", "u1.json");
  await first.upsert(rec("svc", "2026-10-18T14:00:00.000Z", "FIRST HALF"));
  const file = path.join(dataDir, "u1", "svc.json");
  const before = await fs.readFile(file, "utf8");
  await fs.chmod(file, 0o000);
  try {
    const s = make("u1", "u1.json"); // the restart
    assert.equal(await s.get("svc"), null);
    await s.upsert(rec("svc", "2026-10-18T14:50:00.000Z", "AFTER RESTART"));
    await s.upsert(rec("svc", "2026-10-18T14:50:00.000Z", "AFTER RESTART, LATER"));
    assert.equal(s.unreadable()?.code, "EACCES");
    assert.equal((await s.get("svc"))?.title, "AFTER RESTART, LATER", "the held copy is what it answers with");
    const held = await heldFiles("u1");
    assert.equal(held.length, 1, held.join());
    assert.match(held[0], /^svc\.json\.held-\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
    const heldRec = JSON.parse(await fs.readFile(path.join(dataDir, "u1", held[0]), "utf8")) as Rec;
    assert.equal(heldRec.title, "AFTER RESTART, LATER");
    assert.equal(lines.filter((l) => l.includes(".held-")).length, 1, `held twice in the log:\n${lines.join("\n")}`);
  } finally {
    await fs.chmod(file, 0o644);
  }
  assert.equal(await fs.readFile(file, "utf8"), before, "the record it could not read was replaced");
});

test("a record that will not parse is kept too, is not deleted, and the log says why", async (t) => {
  const lines = captureConsole(t, "error");
  const s0 = make("u2", "u2.json");
  await s0.upsert(rec("ok", "2026-10-18T09:00:00.000Z"));
  const file = path.join(dataDir, "u2", "torn.json");
  await fs.writeFile(file, "{ torn");
  const s = make("u2", "u2.json");
  await s.upsert(rec("torn", "2026-10-18T10:00:00.000Z", "NEW"));
  assert.equal(await fs.readFile(file, "utf8"), "{ torn", "a file that would not parse was replaced");
  assert.equal((await heldFiles("u2")).length, 1);
  await assert.rejects(s.delete("torn"), /torn\.json in u2 was not deleted/);
  assert.equal(await fs.readFile(file, "utf8"), "{ torn");
  assert.equal(await s.delete("ok"), true, "a record that did read still deletes");
  assert.match(lines[0], /^\[u2\] torn\.json in u2 will not parse \(error\): .*JSON/);
});

test("listStrict and assertReadable refuse while any of it could not be read; list answers what did", async (t) => {
  captureConsole(t, "error");
  await fs.mkdir(path.join(dataDir, "u3"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "u3", "torn.json"), "{ torn");
  await fs.writeFile(path.join(dataDir, "u3", "ok.json"), JSON.stringify(rec("ok", "2026-10-18T09:00:00.000Z")));
  const s = make("u3", "u3.json");
  assert.deepEqual((await s.list()).map((r) => r.serviceKey), ["ok"]);
  await assert.rejects(s.listStrict(), /torn\.json in u3 will not parse/);
  await assert.rejects(s.assertReadable("torn"), /torn\.json in u3/);
  await s.assertReadable("ok");
});

test("a directory that cannot be listed holds every save beside the file it would replace", { skip: asRoot }, async (t) => {
  const lines = captureConsole(t, "error");
  const first = make("u4", "u4.json");
  await first.upsert(rec("svc", "2026-10-18T14:00:00.000Z", "FIRST HALF"));
  const dir = path.join(dataDir, "u4");
  const before = await fs.readFile(path.join(dir, "svc.json"), "utf8");
  await fs.chmod(dir, 0o300); // can write and enter, cannot list
  try {
    const s = make("u4", "u4.json");
    await s.upsert(rec("svc", "2026-10-18T14:50:00.000Z", "AFTER RESTART"));
    assert.match(s.unreadable()?.message ?? "", /^The u4 folder could not be read \(EACCES\)$/);
    await assert.rejects(s.listStrict());
    s.invalidate();
    await s.list();
  } finally {
    await fs.chmod(dir, 0o755);
  }
  assert.equal(await fs.readFile(path.join(dir, "svc.json"), "utf8"), before, "a record it never read was replaced");
  assert.equal((await heldFiles("u4")).length, 1);
  assert.equal(lines.filter((l) => l.startsWith("[u4] The u4 folder")).length, 1, "said again on a reload");
});

test("migrating the legacy file never writes over a per-key file it could not read", async (t) => {
  captureConsole(t, "error");
  await fs.mkdir(path.join(dataDir, "u5"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "u5", "svc.json"), "{ torn");
  await fs.writeFile(
    path.join(dataDir, "u5.json"),
    JSON.stringify({ services: { svc: rec("svc", "2026-01-01T00:00:00.000Z", "LEGACY") } }),
  );
  const s = make("u5", "u5.json");
  await s.list();
  assert.equal(await fs.readFile(path.join(dataDir, "u5", "svc.json"), "utf8"), "{ torn");
  await fs.stat(path.join(dataDir, "u5.json")); // kept under its own name to try again
});

test("a legacy file that will not parse leaves the history incomplete, said once", async (t) => {
  // Its services are missing from list(), so an export would leave them out
  // and an import would take them for new.
  const lines = captureConsole(t, "error");
  await fs.writeFile(path.join(dataDir, "u6.json"), "{ not json");
  const s = make("u6", "u6.json");
  await assert.rejects(s.listStrict(), /^StoreReadError: u6\.json will not parse/);
  s.invalidate();
  await s.list();
  assert.equal(lines.length, 1, lines.join("\n"));
});

test("a legacy file that cannot be read leaves the history incomplete", { skip: asRoot }, async (t) => {
  captureConsole(t, "error");
  const file = path.join(dataDir, "u7.json");
  await fs.writeFile(file, JSON.stringify({ services: {} }));
  await fs.chmod(file, 0o000);
  try {
    await assert.rejects(make("u7", "u7.json").listStrict(), { code: "EACCES" });
  } finally {
    await fs.chmod(file, 0o644);
  }
});
