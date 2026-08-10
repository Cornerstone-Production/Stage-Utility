// The store holding every recorded service, under concurrency.
//
// Two defects, both from a fix applied to some call sites and not others.
//
// writeOne used a temp path fixed at `${file}.tmp`. That is the exact shape
// write-queue.ts was written to remove: two writers to one key share the scratch
// file, fs.writeFile is not atomic at that size, and the first rename promotes a
// spliced record. DataStore and secrets.ts were converted in the same session
// this store was not — the same fix landing on two of three call sites, which is
// the most expensive recurring mistake in this repo.
//
// loadAll was not serialised. list() and get() do not go through the write
// queue, so two arriving together each ran the whole directory scan AND
// migrateLegacy — which renames the legacy file out from under the other and
// writes the same per-key files twice.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-keyed-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { KeyedRecordStore } = await import("./keyed-record-store.js");

interface Rec {
  serviceKey: string;
  startedAt: string;
  payload: string;
}

const DIR = "keyed-test";

function newStore() {
  return new KeyedRecordStore<Rec>(DIR, "keyed-test-legacy.json", (r) => r.startedAt, "runtime");
}

describe("KeyedRecordStore", () => {
  beforeEach(async () => {
    await fs.rm(path.join(TMP, DIR), { recursive: true, force: true });
    await fs.rm(path.join(TMP, "keyed-test-legacy.json"), { force: true });
    await fs.rm(path.join(TMP, "keyed-test-legacy.json.migrated"), { force: true });
  });

  it("two writers to one key cannot splice each other's bytes", async () => {
    // Deliberately TWO instances over one directory. Within a single instance
    // upsert() is serialised by the write queue, so the shared-temp-path hazard
    // needs a second writer — which the code has: migrateLegacy calls writeOne
    // from inside loadAll, and loadAll is reached by get()/list() OUTSIDE the
    // queue. A second process over the same data dir is the other way in.
    //
    // Payloads of different lengths, so a splice leaves a file that is either
    // unparseable or the wrong size rather than one that happens to look fine.
    const a = newStore();
    const b = newStore();
    await Promise.all([
      ...Array.from({ length: 6 }, () =>
        a.upsert({ serviceKey: "svc-1", startedAt: "2026-07-26T11:00:00Z", payload: "a".repeat(500_000) }),
      ),
      ...Array.from({ length: 6 }, () =>
        b.upsert({ serviceKey: "svc-1", startedAt: "2026-07-26T11:00:00Z", payload: "b".repeat(300_000) }),
      ),
    ]);

    const names = await fs.readdir(path.join(TMP, DIR));
    assert.deepEqual(names.filter((n) => n.endsWith(".tmp")), [], "a scratch file survived the write");

    // Whatever landed is ONE of the two writes, whole.
    const raw = await fs.readFile(path.join(TMP, DIR, "svc-1.json"), "utf8");
    const parsed = JSON.parse(raw) as Rec; // throws outright on a spliced file
    assert.ok(
      /^a+$/.test(parsed.payload) || /^b+$/.test(parsed.payload),
      "the record is a mix of two writers' bytes",
    );
    assert.ok(
      parsed.payload.length === 500_000 || parsed.payload.length === 300_000,
      `record is ${parsed.payload.length} bytes — neither writer wrote that`,
    );
  });

  it("survives concurrent writes to different keys", async () => {
    const store = newStore();
    const keys = Array.from({ length: 20 }, (_, i) => `svc-${i}`);
    await Promise.all(
      keys.map((k) => store.upsert({ serviceKey: k, startedAt: "2026-07-26T11:00:00Z", payload: k })),
    );
    const all = await store.list();
    assert.equal(all.length, 20);
    for (const k of keys) assert.equal((await store.get(k))?.payload, k);
  });

  it("migrates the legacy document exactly once under concurrent reads", async () => {
    // Two readers arriving together both used to run migrateLegacy: one renames
    // the legacy file, the other finds it gone, and both write the same files.
    await fs.writeFile(
      path.join(TMP, "keyed-test-legacy.json"),
      JSON.stringify({
        services: {
          a: { serviceKey: "a", startedAt: "2026-07-26T09:00:00Z", payload: "a" },
          b: { serviceKey: "b", startedAt: "2026-07-26T11:00:00Z", payload: "b" },
        },
      }),
      "utf8",
    );

    const store = newStore();
    const [one, two, three] = await Promise.all([store.list(), store.list(), store.list()]);

    for (const got of [one, two, three]) assert.equal(got.length, 2);
    assert.deepEqual(one.map((r) => r.serviceKey), ["b", "a"], "newest first");
    // The rename happened, once, and left the original as insurance.
    await assert.rejects(() => fs.stat(path.join(TMP, "keyed-test-legacy.json")));
    await fs.stat(path.join(TMP, "keyed-test-legacy.json.migrated"));
  });

  it("concurrent readers share one load rather than each doing it", async () => {
    const store = newStore();
    await store.upsert({ serviceKey: "a", startedAt: "2026-07-26T09:00:00Z", payload: "a" });

    const fresh = newStore();
    // Counted on the instance, which shadows the prototype method. The ESM
    // namespace object holding fs.readdir is frozen, so the scan itself cannot
    // be spied on — this is the same question one level up.
    const spy = fresh as unknown as { loadOnce: () => Promise<unknown> };
    const real = spy.loadOnce.bind(fresh);
    let loads = 0;
    spy.loadOnce = () => {
      loads += 1;
      return real();
    };

    await Promise.all([fresh.list(), fresh.list(), fresh.list(), fresh.get("a")]);
    assert.equal(loads, 1, `four concurrent readers ran ${loads} full loads`);

    // And the cache holds afterwards, so a later reader does not load again.
    await fresh.list();
    assert.equal(loads, 1);
  });

  it("invalidate() beats a load already in flight", async () => {
    // config import rewrites the directory behind the store's back and calls
    // invalidate(). A load that started before that must not install its
    // pre-import view as the cache afterwards.
    const store = newStore();
    await store.upsert({ serviceKey: "a", startedAt: "2026-07-26T09:00:00Z", payload: "before" });

    const fresh = newStore();
    const inFlight = fresh.list();
    fresh.invalidate();
    await fs.writeFile(
      path.join(TMP, DIR, "a.json"),
      JSON.stringify({ serviceKey: "a", startedAt: "2026-07-26T09:00:00Z", payload: "after" }),
      "utf8",
    );
    await inFlight;

    assert.equal((await fresh.get("a"))?.payload, "after", "the stale load was cached over the import");
  });
});
