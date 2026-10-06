// What an install that upgrades across the ScriptView -> ServiceCue rename keeps.
//
// Saved ServiceCue work is the operator's configuration, and losing it to a rename
// is the worst outcome available: the columns somebody built for each department
// quietly gone, the displays rendering all columns, and nothing logged. Every
// route an old shape can arrive by is exercised here against the real code:
//
//   - the three data files, moved at boot and again on a store's first read
//   - an OLD config backup, restored through configSnapshot.apply
//   - a views.json that carries the old preset field
//   - a view export from before the rename, imported through applyViewBundle
//
// Each test names the migration it holds; delete the migration and it goes red.
// Fixture content is invented. The data directory is a fresh temp dir.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-servicecue-migration-"));
process.env.STAGE_UTILITY_DATA = dir;
process.env.HOME = path.join(dir, "home");

const { DataStore } = await import("./data-store.js");
const { adoptLegacyStoreFiles, resetStoreFileAdoptionForTests } = await import("./store-file-adoption.js");
const { renamedStores } = await import("./store-registry.js");
const { serviceCueConfigStore } = await import("./servicecue-config-store.js");
const { serviceCueLayoutsStore } = await import("./servicecue-layouts-store.js");
const { serviceCueRolesStore } = await import("./servicecue-roles-store.js");
const { viewsStore } = await import("./views-store.js");
const { configSnapshot } = await import("./config-snapshot.js");
const { applyViewBundle } = await import("./view-import.js");
const { buildViewBundle } = await import("./view-export.js");

after(() => fs.rm(dir, { recursive: true, force: true }));

const read = (name: string) => fs.readFile(path.join(dir, name), "utf8");
const has = (name: string) =>
  fs.access(path.join(dir, name)).then(
    () => true,
    () => false,
  );
const put = (name: string, value: unknown) => fs.writeFile(path.join(dir, name), JSON.stringify(value, null, 2), "utf8");

/** Capture what the code under test says to /log, then give it back. */
function captureLog() {
  const lines: string[] = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  return {
    lines,
    done: () => {
      console.log = real.log;
      console.warn = real.warn;
      console.error = real.error;
    },
  };
}

// ── Invented fixtures ───────────────────────────────────────────────────────

const LAYOUTS = [{ id: "svl-1", name: "Audio", order: 0, columnRoles: ["role-audio"] }];
const ROLES = [{ id: "role-audio", name: "Audio", members: ["Audio", "FOH"] }];
const CONFIG = { serviceTypeIds: ["st-weekend"] };

// ── The three data files ────────────────────────────────────────────────────

describe("the three ServiceCue data files, on an install that has the old names", () => {
  let log: ReturnType<typeof captureLog>;
  beforeEach(() => {
    resetStoreFileAdoptionForTests();
    log = captureLog();
  });
  afterEach(() => log.done());

  test("registered: exactly these three stores declare a rename, sorted, one per line", () => {
    const pairs = renamedStores()
      .filter((s) => s.filename.startsWith("servicecue-"))
      .map((s) => `${s.renamedFrom.filename} -> ${s.filename}`)
      .sort();
    assert.deepEqual(pairs, [
      "scriptview-config.json -> servicecue-config.json",
      "scriptview-layouts.json -> servicecue-layouts.json",
      "scriptview-roles.json -> servicecue-roles.json",
    ]);
  });

  test("old only: moved at boot, content intact, the old name gone, and one line says so", async () => {
    await put("scriptview-config.json", CONFIG);
    await put("scriptview-layouts.json", LAYOUTS);
    await put("scriptview-roles.json", ROLES);
    const before = await read("scriptview-layouts.json");

    const { reports, failures } = await adoptLegacyStoreFiles(dir);

    assert.deepEqual(failures, []);
    const moved = reports.filter((r) => r.outcome === "moved").map((r) => r.current).sort();
    assert.deepEqual(moved, ["servicecue-config.json", "servicecue-layouts.json", "servicecue-roles.json"]);
    for (const old of ["scriptview-config.json", "scriptview-layouts.json", "scriptview-roles.json"]) {
      assert.equal(await has(old), false, `${old} is still there`);
    }
    assert.equal(await read("servicecue-layouts.json"), before, "the bytes changed in the move");
    const said = log.lines.filter((l) => l.startsWith("[servicecue] moved scriptview-layouts.json to servicecue-layouts.json"));
    assert.equal(said.length, 1, `expected one [servicecue] line for the layouts, got ${JSON.stringify(log.lines)}`);

    // And the stores, read for the first time after the move, hold the work.
    assert.deepEqual(await serviceCueConfigStore.load(), CONFIG);
    assert.deepEqual(await serviceCueLayoutsStore.load(), LAYOUTS);
    assert.deepEqual(await serviceCueRolesStore.load(), ROLES);
  });

  test("a second boot finds nothing to do and says nothing", async () => {
    const { reports } = await adoptLegacyStoreFiles(dir);
    assert.deepEqual(reports.filter((r) => r.outcome !== "none"), []);
    assert.deepEqual(log.lines, []);
  });

  test("a store's first read moves the file itself, with no boot pass", async () => {
    // The route a script, a test or anything else that is not server.ts takes:
    // the file is moved before the store's first read, not after it has already
    // started empty.
    await put("lazy-old.json", { n: 7 });
    const store = new DataStore<{ n: number }>("lazy-new.json", { n: 0 }, "runtime", {
      renamedFrom: { filename: "lazy-old.json", logTag: "servicecue" },
    });
    assert.deepEqual(await store.load(), { n: 7 });
    assert.equal(await has("lazy-old.json"), false);
    assert.equal(await has("lazy-new.json"), true);
  });

  test("a write before any read lands in the new file and does not lose the old content's place", async () => {
    await put("wr-old.json", { n: 1 });
    const store = new DataStore<{ n: number }>("wr-new.json", { n: 0 }, "runtime", {
      renamedFrom: { filename: "wr-old.json", logTag: "servicecue" },
    });
    await store.save({ n: 2 });
    assert.equal(await has("wr-old.json"), false, "the old file was left behind to be read as stale later");
    assert.deepEqual(JSON.parse(await read("wr-new.json")), { n: 2 });
  });

  test("both exist: the new file is kept, the old one is left byte for byte, and it is logged", async () => {
    await put("both-old.json", { which: "old" });
    await put("both-new.json", { which: "new" });
    const oldBytes = await read("both-old.json");
    const store = new DataStore<{ which: string }>("both-new.json", { which: "default" }, "runtime", {
      renamedFrom: { filename: "both-old.json", logTag: "servicecue" },
    });

    assert.deepEqual(await store.load(), { which: "new" });
    assert.equal(await read("both-old.json"), oldBytes, "the old file was touched");
    assert.deepEqual(JSON.parse(await read("both-new.json")), { which: "new" });
    const said = log.lines.filter((l) => l.includes("both-old.json and both-new.json both exist"));
    assert.equal(said.length, 1, `expected the standoff to be logged once: ${JSON.stringify(log.lines)}`);
    assert.ok(said[0]!.startsWith("[servicecue]"), "it is not under the [servicecue] tag");
  });

  test("neither exists: nothing is created, nothing is logged", async () => {
    const store = new DataStore<{ n: number }>("none-new.json", { n: 5 }, "runtime", {
      renamedFrom: { filename: "none-old.json", logTag: "servicecue" },
    });
    assert.deepEqual(await store.load(), { n: 5 });
    assert.equal(await has("none-old.json"), false);
    assert.equal(await has("none-new.json"), false);
    assert.deepEqual(log.lines, []);
  });

  test("new only: left exactly as it is", async () => {
    await put("only-new.json", { n: 3 });
    const bytes = await read("only-new.json");
    const store = new DataStore<{ n: number }>("only-new.json", { n: 0 }, "runtime", {
      renamedFrom: { filename: "only-old.json", logTag: "servicecue" },
    });
    assert.deepEqual(await store.load(), { n: 3 });
    assert.equal(await read("only-new.json"), bytes);
    assert.deepEqual(log.lines, []);
  });

  describe("a move that fails", () => {
    const fsp = createRequire(import.meta.url)("node:fs/promises") as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const realRename = fsp.rename!;
    afterEach(() => {
      fsp.rename = realRename;
      syncBuiltinESMExports();
    });
    function refuseRenames() {
      fsp.rename = async () => {
        throw Object.assign(new Error("EACCES: permission denied, rename"), { code: "EACCES" });
      };
      syncBuiltinESMExports();
    }

    test("is returned to the boot pass, which names it, and leaves the old file where it was", async () => {
      await put("fail-old.json", { keep: "me" });
      new DataStore<unknown>("fail-new.json", null, "runtime", {
        renamedFrom: { filename: "fail-old.json", logTag: "servicecue" },
      });
      refuseRenames();
      const { failures } = await adoptLegacyStoreFiles(dir);
      const mine = failures.filter((f) => f.current === "fail-new.json");
      assert.equal(mine.length, 1);
      assert.match(mine[0]!.error, /EACCES/);
      assert.equal(await has("fail-old.json"), true, "the old file is gone though it was never moved");
      assert.equal(await has("fail-new.json"), false);
      await fs.rm(path.join(dir, "fail-old.json"));
    });

    test("makes the store's own read fail, rather than start it empty beside the old file", async () => {
      await put("rd-old.json", { keep: "me" });
      const store = new DataStore<unknown>("rd-new.json", null, "runtime", {
        renamedFrom: { filename: "rd-old.json", logTag: "servicecue" },
      });
      refuseRenames();
      await assert.rejects(() => store.load(), /EACCES/);
      assert.equal(await has("rd-old.json"), true);
    });
  });
});

// ── An old backup ───────────────────────────────────────────────────────────

describe("restoring a backup taken before the rename", () => {
  const oldBackup = (files: Record<string, unknown>) => ({
    kind: "stage-utility-config",
    version: 1,
    appVersion: "1.24.0",
    createdAt: "2026-09-01T00:00:00.000Z",
    files,
  });

  afterEach(async () => {
    for (const f of ["servicecue-config.json", "servicecue-layouts.json", "servicecue-roles.json", "scriptview-config.json", "scriptview-layouts.json", "scriptview-roles.json"]) {
      await fs.rm(path.join(dir, f), { force: true });
    }
  });

  test("the three scriptview files land under their new names, with their content", async () => {
    const applied = await configSnapshot.apply(
      oldBackup({
        "scriptview-config.json": CONFIG,
        "scriptview-layouts.json": LAYOUTS,
        "scriptview-roles.json": ROLES,
      }),
    );
    assert.deepEqual([...applied].sort(), ["servicecue-config.json", "servicecue-layouts.json", "servicecue-roles.json"]);
    assert.deepEqual(JSON.parse(await read("servicecue-layouts.json")), LAYOUTS);
    assert.deepEqual(JSON.parse(await read("servicecue-roles.json")), ROLES);
    assert.deepEqual(JSON.parse(await read("servicecue-config.json")), CONFIG);
    for (const old of ["scriptview-config.json", "scriptview-layouts.json", "scriptview-roles.json"]) {
      assert.equal(await has(old), false, `${old} was written by a restore`);
    }
  });

  test("a backup listing both spellings restores the new one", async () => {
    const log = captureLog();
    try {
      await configSnapshot.apply(
        oldBackup({
          "scriptview-layouts.json": [{ id: "stale", name: "Stale", columns: [] }],
          "servicecue-layouts.json": LAYOUTS,
        }),
      );
    } finally {
      log.done();
    }
    assert.deepEqual(JSON.parse(await read("servicecue-layouts.json")), LAYOUTS);
    assert.equal(await has("scriptview-layouts.json"), false);
    assert.ok(log.lines.some((l) => l.includes("lists both scriptview-layouts.json and servicecue-layouts.json")), JSON.stringify(log.lines));
  });

  test("a backup taken after the rename round trips: build carries the new names", async () => {
    await put("servicecue-layouts.json", LAYOUTS);
    const bundle = await configSnapshot.build();
    assert.deepEqual(bundle.files["servicecue-layouts.json"], LAYOUTS);
    assert.equal("scriptview-layouts.json" in bundle.files, false);
  });
});

// ── The old preset field on a view ──────────────────────────────────────────

describe("a view saved with the old column-preset field", () => {
  const customView = (extra: Record<string, unknown>) => ({
    id: "view-sc", name: "Booth", kind: "script", createdAt: 0, ...extra,
  });

  test("reads as the new field, and the next save writes the new one", async () => {
    await put("views.json", [customView({ scriptViewLayoutId: "svl-1" })]);
    await viewsStore.reload();

    const loaded = (await viewsStore.load()) as unknown as Record<string, unknown>[];
    assert.equal(loaded[0]!.serviceCueLayoutId, "svl-1");
    assert.equal("scriptViewLayoutId" in loaded[0]!, false);
    // Nothing is written by reading.
    assert.equal(JSON.parse(await read("views.json"))[0].scriptViewLayoutId, "svl-1");

    await viewsStore.save(loaded as never);
    const onDisk = JSON.parse(await read("views.json"))[0];
    assert.equal(onDisk.serviceCueLayoutId, "svl-1");
    assert.equal("scriptViewLayoutId" in onDisk, false, "the old field was written back");
  });

  test("a view that already has the new field keeps it, and the old one is dropped", async () => {
    await put("views.json", [customView({ scriptViewLayoutId: "old", serviceCueLayoutId: "new" })]);
    const loaded = (await viewsStore.reload()) as unknown as Record<string, unknown>[];
    assert.equal(loaded[0]!.serviceCueLayoutId, "new");
    assert.equal("scriptViewLayoutId" in loaded[0]!, false);
  });

  test("a view with no preset at all is untouched", async () => {
    await put("views.json", [customView({})]);
    const loaded = (await viewsStore.reload()) as unknown as Record<string, unknown>[];
    assert.equal("serviceCueLayoutId" in loaded[0]!, false);
  });
});

// ── View exports ────────────────────────────────────────────────────────────

describe("view exports across the rename", () => {
  beforeEach(async () => {
    await viewsStore.save([] as never);
    await serviceCueLayoutsStore.save([] as never);
  });

  const oldExport = () => ({
    kind: "stage-utility-view",
    version: 1,
    appVersion: "1.24.0",
    createdAt: "2026-09-01T00:00:00.000Z",
    source: { server: "Elsewhere" },
    views: [{ id: "view-9", name: "Booth", kind: "script", createdAt: 0, scriptViewLayoutId: "svl-1" }],
    // The key an export from before the rename wrote.
    sideData: { slots: {}, notes: {}, scriptviewLayouts: LAYOUTS },
    targets: { osc: [], rosstalk: [] },
    images: {},
  });

  test("an export from before the rename imports its presets and keeps the view pointed at one", async () => {
    const report = await applyViewBundle(oldExport());

    assert.deepEqual(await serviceCueLayoutsStore.load(), LAYOUTS, "the presets in the old key were dropped");
    const [v] = (await viewsStore.load()) as unknown as Record<string, unknown>[];
    assert.equal(v!.serviceCueLayoutId, "svl-1", "the view lost its preset");
    assert.equal("scriptViewLayoutId" in v!, false);
    assert.deepEqual(
      report.skipped.filter((s) => /preset/.test(s)),
      [],
      "the import claimed a preset was missing though the file carried it",
    );
  });

  test("an export writes the new key and never the old one", async () => {
    await serviceCueLayoutsStore.save(LAYOUTS as never);
    await viewsStore.save([
      { id: "view-a", name: "A", kind: "script", createdAt: 0, serviceCueLayoutId: "svl-1" },
    ] as never);
    const b = await buildViewBundle("view-a");
    assert.deepEqual(b.sideData.serviceCueLayouts, LAYOUTS);
    assert.equal("scriptviewLayouts" in b.sideData, false);
    assert.equal((b.views[0] as unknown as Record<string, unknown>).serviceCueLayoutId, "svl-1");
    assert.equal("scriptViewLayoutId" in (b.views[0] as object), false);
  });
});
