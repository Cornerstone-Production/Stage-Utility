// An id, once used, is never issued again.
//
// Both allocators were `max(existing) + 1`, so deleting the highest-numbered
// view or display and creating another handed out the dead one's id. Ids are
// treated as permanent everywhere else: slots.json is keyed by output id, and
// Pis, bookmarks and QR codes point at `/<id>`. So a recreated display silently
// inherited a deleted one's mic slots, and a bookmark aimed at one screen opened
// another.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { nextId } from "./id-allocator.js";

describe("an id is never reissued", () => {
  it("counts up from the floor", () => {
    const r = nextId("view", ["view-1", "view-2"], 3);
    assert.equal(r.id, "view-3");
    assert.equal(r.nextFloor, 4);
  });

  it("DOES NOT REUSE the id of a deleted item", () => {
    // The bug, stated as the test that catches it. views 1,2,3 exist; 3 is
    // deleted; the floor remembers 4. max(existing)+1 would answer "view-3".
    const r = nextId("view", ["view-1", "view-2"], 4);
    assert.equal(r.id, "view-4", "a deleted id was handed out again");
  });

  it("never collides with an existing id, even if the floor is stale", () => {
    // A restored backup can carry a floor lower than the ids in it. Answering
    // an id that already exists would be worse than reuse: two live things
    // sharing a key.
    const r = nextId("view", ["view-1", "view-2", "view-9"], 3);
    assert.ok(!["view-1", "view-2", "view-9"].includes(r.id), `collided: ${r.id}`);
    assert.equal(r.id, "view-10");
  });

  it("starts at the floor when nothing exists yet", () => {
    assert.equal(nextId("display", [], 2).id, "display-2");
  });

  it("ignores ids that are not numbered", () => {
    // "home" is a real view id in this app and parses to NaN.
    const r = nextId("view", ["home", "view-4"], 1);
    assert.equal(r.id, "view-5");
  });

  it("advances the floor past what it issued", () => {
    const first = nextId("view", [], 1);
    const second = nextId("view", [`view-${1}`], first.nextFloor);
    assert.notEqual(first.id, second.id);
  });
});

// ── Through the real store, across real restarts ────────────────────────────
//
// The floor is only worth having if it SURVIVES. `DataStore.load()` hands back a
// warm in-memory Map once it is open, so deleting the file and calling `init()`
// in this process would not reload anything — a "survives a restart" test
// written that way passes with the floor never having reached the disk, which is
// the exact defect being guarded. `main/services/checklist-ticks-store.test.ts`
// documents the same trap. Cache-busting the `stage-controller.js` specifier
// would not help either: its own import of `settings-store.js` still resolves to
// the warm module.
//
// So these restart for real — a second node process, cold module caches, the
// same data directory — and read settings.json off the disk, because the file is
// the only honest evidence of persistence.

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CONTROLLER = path.join(REPO, "main/services/stage-controller.js");

const tempDirs: string[] = [];
async function tempDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-ids-"));
  tempDirs.push(dir);
  return dir;
}

// A CI box should not accumulate one of these per run.
after(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
});

const TMP = await tempDataDir();
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");

type Mutable = {
  state: { views: unknown[]; outputs: unknown[]; [k: string]: unknown };
  broadcast: () => void;
  recomputeResolved: () => void;
};
const ctl = stageController as unknown as Mutable;
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
ctl.state = { ...ctl.state, views: [], outputs: [] };

async function idFloorsOnDisk(dir = TMP): Promise<{ view?: number; output?: number }> {
  const raw = JSON.parse(await fs.readFile(path.join(dir, "settings.json"), "utf8")) as {
    idFloors?: { view?: number; output?: number };
  };
  return raw.idFloors ?? {};
}

/**
 * Boot a fresh process against `dataDir` and run `body` in it, the way a
 * restarted server would.
 *
 * Nothing short of a new process is a restart. This one shares no module cache,
 * no DataStore and no controller instance with the test that spawned it, so the
 * only thing carrying a floor across is the file itself. `body` is TypeScript
 * source with `stageController` and `ctl` (its broadcast/recompute stubbed) in
 * scope, and reports by printing `CREATED:<id>`.
 *
 * `.mts` because the temp directory has no package.json: without the extension
 * tsx compiles it as CJS and rejects the top-level await.
 */
async function inAFreshProcess(dataDir: string, body: string): Promise<string> {
  const script = path.join(dataDir, `restart-${Math.random().toString(36).slice(2)}.mts`);
  await fs.writeFile(
    script,
    `const { stageController } = await import(${JSON.stringify(CONTROLLER)});
const ctl = stageController as unknown as { state: Record<string, unknown>; broadcast: () => void; recomputeResolved: () => void };
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
${body}
process.exit(0);
`,
    "utf8",
  );
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn("npx", ["tsx", script], {
      cwd: REPO,
      env: { ...process.env, STAGE_UTILITY_DATA: dataDir, HOME: path.join(dataDir, "home") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`restart process exited ${code}\n${stderr}`)),
    );
  });
  const match = /CREATED:(\S+)/.exec(out);
  if (!match) throw new Error(`restart process printed no id:\n${out}`);
  return match[1];
}

describe("through the real store", () => {
  it("does not reissue a deleted view's id ACROSS A RESTART", async () => {
    await stageController.createView("One");
    await stageController.createView("Two");
    const third = await stageController.createView("Three");
    assert.deepEqual(
      third.views.map((v) => v.id),
      ["view-1", "view-2", "view-3"],
    );

    await stageController.deleteView("view-3");

    assert.equal(
      (await idFloorsOnDisk()).view,
      4,
      "the floor never reached settings.json, so a restart would hand view-3 out again",
    );

    // The restart. max(existing) + 1 over the surviving view-1/view-2 answers
    // "view-3" — the id of the view the operator deleted, which slots.json,
    // bookmarks and QR codes still point at.
    const id = await inAFreshProcess(
      TMP,
      `import * as fs from "node:fs/promises";
import * as path from "node:path";
const views = JSON.parse(await fs.readFile(path.join(process.env.STAGE_UTILITY_DATA!, "views.json"), "utf8"));
ctl.state = { ...ctl.state, views, outputs: [] };
const state = await stageController.createView("After restart");
console.log("CREATED:" + state.views[state.views.length - 1].id);`,
    );
    assert.equal(id, "view-4", "a deleted id came back after a restart");
  });

  it("does not reissue a deleted display's id, and keeps display-1 reserved", async () => {
    // display-1 is the primary output, so created displays start at display-2.
    ctl.state = { ...ctl.state, outputs: [{ id: "display-1", name: "Primary", viewId: null }] };
    const a = await stageController.addOutput("Lobby");
    const b = await stageController.addOutput("Foyer");
    assert.deepEqual([a.output.id, b.output.id], ["display-2", "display-3"]);

    await stageController.removeOutput("display-3");
    assert.equal((await idFloorsOnDisk()).output, 4, "the display floor never reached disk");

    const c = await stageController.addOutput("Replacement");
    assert.equal(c.output.id, "display-4", "a deleted display's id came back");
  });
});

// An install that UPGRADES into id floors has ids and no floor. Nothing writes a
// floor until an id is issued, so without seeding at boot the very first
// delete-then-create after the update falls back to `max(existing) + 1` and
// reuses the highest id — once, after which it self-heals. That is the shape of
// defect that is never reported, and for a display it means the new one inherits
// the deleted one's slots.json bucket.
describe("an install that upgrades into id floors", () => {
  it("does not reissue the highest view id on its FIRST delete-then-create", async () => {
    const dir = await tempDataDir();
    await fs.mkdir(path.join(dir, "home"), { recursive: true });
    // Settings as they were BEFORE this change: no idFloors key at all.
    await fs.writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({
        serviceTypeId: null,
        serviceTypeName: null,
        planMode: "manual",
        planId: null,
        planTitle: null,
        planSeriesTitle: null,
        integrationConfigs: {},
        integrationEnabled: {},
        showQr: true,
        displays: [],
        allowedServiceTypeIds: [],
        outputs: [{ id: "display-1", name: "Display 1", viewId: "view-1" }],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(dir, "views.json"),
      JSON.stringify(
        [1, 2, 3, 4, 5].map((n) => ({
          id: `view-${n}`,
          name: `View ${n}`,
          kind: "slots",
          createdAt: "2026-01-01T00:00:00.000Z",
        })),
      ),
      "utf8",
    );

    // The real boot path — init() is where the seeding lives — then the first
    // thing an operator does after updating.
    const id = await inAFreshProcess(
      dir,
      `await stageController.init();
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
await stageController.deleteView("view-5");
const state = await stageController.createView("Replacement");
console.log("CREATED:" + state.views[state.views.length - 1].id);`,
    );
    assert.equal(id, "view-6", "the upgraded install handed out the id of the view just deleted");
    assert.equal((await idFloorsOnDisk(dir)).view, 7);
  });
});

// Allocation reads a floor and writes it back, and its callers await in between.
// That pair is only indivisible because the whole read-allocate-write happens
// inside `store.update` — the settings write queue. It used to be safe only by
// accident: `DataStore.writeRaw` sets the cache before writing, so a WARM cache
// resolves in microtasks and nothing can interleave. On a COLD cache, which is
// every allocation made in the first moments after a boot, two concurrent
// creates could both read the same floor and be handed the same id.
//
// A cold cache is the whole point, so this runs in a fresh process against a
// data directory with no settings.json at all.
describe("two allocations at once", () => {
  it("cannot be handed the same id on a COLD settings cache", async () => {
    const dir = await tempDataDir();
    await fs.mkdir(path.join(dir, "home"), { recursive: true });
    const ids = await inAFreshProcess(
      dir,
      `const { settingsStore } = await import(${JSON.stringify(path.join(REPO, "main/services/settings-store.js"))});
const alloc = () => settingsStore.allocateIds("view", (next) => next([]));
console.log("CREATED:" + (await Promise.all([alloc(), alloc(), alloc()])).join(","));`,
    );
    assert.deepEqual(
      ids.split(","),
      ["view-1", "view-2", "view-3"],
      "concurrent allocations collided — the floor was read outside the write queue",
    );
  });
});

// Restoring last week's backup onto a new box is the likeliest thing an operator
// will ever do with this data, and it was the last way an id could come back.
//
// A snapshot taken before id floors existed carries none, so the merge in
// config-snapshot.ts has only the LIVE floor to keep — a number belonging to the
// box being restored ONTO, which knows nothing about the ids that arrived with
// the snapshot. Every restored id then sits above the floor. Boot is what
// repairs that, and only because seeding RAISES a floor it finds too low; while
// it skipped any floor that was merely present, the first delete-then-create
// after a restore reissued an id, and slots.json is keyed by output id, so the
// new display inherited the dead one's mic slots.
describe("a snapshot restored from before id floors existed", () => {
  it("does not reissue an id the snapshot brought with it", async () => {
    const dir = await tempDataDir();
    await fs.mkdir(path.join(dir, "home"), { recursive: true });

    // The box being restored ONTO: it has booted, so it HAS floors, and they are
    // low because there is almost nothing on it.
    const base = {
      serviceTypeId: null,
      planMode: "manual",
      integrationConfigs: {},
      integrationEnabled: {},
      showQr: true,
      displays: [],
      allowedServiceTypeIds: [],
    };
    await fs.writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({
        ...base,
        outputs: [{ id: "display-1", name: "Display 1", viewId: null }],
        idFloors: { view: 1, output: 2 },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(dir, "views.json"), "[]", "utf8");

    const restored = [1, 2, 3].map((n) => ({
      id: `view-${n}`,
      name: `View ${n}`,
      kind: "slots",
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    const snapshot = {
      kind: "stage-utility-config",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      files: {
        // No idFloors: this snapshot predates the feature. Its ids run to 3.
        "settings.json": {
          ...base,
          outputs: [1, 2, 3].map((n) => ({ id: `display-${n}`, name: `D${n}`, viewId: `view-${n}` })),
        },
        "views.json": restored,
      },
    };

    // The real restore path, in its own process, the way the operator triggers it.
    await inAFreshProcess(
      dir,
      `const { configSnapshot } = await import(${JSON.stringify(path.join(REPO, "main/services/config-snapshot.js"))});
await configSnapshot.apply(${JSON.stringify(snapshot)});
console.log("CREATED:applied");`,
    );
    const landed = JSON.parse(await fs.readFile(path.join(dir, "views.json"), "utf8")) as { id: string }[];
    assert.deepEqual(landed.map((v) => v.id), ["view-1", "view-2", "view-3"], "the snapshot did not land");

    // The restart that follows a restore, then the first thing anyone does.
    const ids = await inAFreshProcess(
      dir,
      `await stageController.init();
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
await stageController.deleteView("view-3");
const state = await stageController.createView("Replacement");
await stageController.removeOutput("display-3");
const { output } = await stageController.addOutput("Replacement");
console.log("CREATED:" + state.views[state.views.length - 1].id + "," + output.id);`,
    );
    assert.deepEqual(
      ids.split(","),
      ["view-4", "display-4"],
      "a restored id was handed straight back out — the new display inherits the dead one's slots.json bucket",
    );
  });
});
