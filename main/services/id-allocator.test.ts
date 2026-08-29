// An id, once used, is never issued again.
//
// Both allocators were `max(existing) + 1`, so deleting the highest-numbered
// view or display and creating another handed out the dead one's id. Ids are
// treated as permanent everywhere else: slots.json is keyed by output id, and
// Pis, bookmarks and QR codes point at `/<id>`. So a recreated display silently
// inherited a deleted one's mic slots, and a bookmark aimed at one screen opened
// another.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

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

// ── Through the real store, across a real restart ───────────────────────────
//
// The floor is only worth having if it SURVIVES. `DataStore.load()` hands back a
// warm in-memory Map once it is open, so deleting the file and calling `init()`
// in this process would not reload anything — a "survives a restart" test
// written that way passes with the floor never having reached the disk, which is
// the exact defect being guarded. `main/services/checklist-ticks-store.test.ts`
// documents the same trap.
//
// So this restarts for real: a second node process, cold module caches, the same
// data directory. It also reads settings.json directly, because the file is the
// only honest evidence of persistence.

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-ids-"));
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

async function idFloorsOnDisk(): Promise<{ view?: number; output?: number }> {
  const raw = JSON.parse(await fs.readFile(path.join(TMP, "settings.json"), "utf8")) as {
    idFloors?: { view?: number; output?: number };
  };
  return raw.idFloors ?? {};
}

/**
 * Boot a fresh process against the same data directory and create one view
 * there, the way a restarted server would: load views.json, then allocate.
 *
 * Nothing short of a new process is a restart. This one shares no module cache,
 * no DataStore and no controller instance with the test above it, so the only
 * thing carrying the floor across is the file itself.
 */
async function createViewAfterRestart(): Promise<string> {
  // `.mts` so the temp directory (which has no package.json) is still treated as
  // ESM — the project is `"type": "module"` and this script uses top-level await.
  const script = path.join(TMP, "restart.mts");
  await fs.writeFile(
    script,
    `import * as fs from "node:fs/promises";
import * as path from "node:path";
const { stageController } = await import(${JSON.stringify(path.join(REPO, "main/services/stage-controller.js"))});
const ctl = stageController as unknown as { state: Record<string, unknown>; broadcast: () => void; recomputeResolved: () => void };
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};
const views = JSON.parse(await fs.readFile(path.join(process.env.STAGE_UTILITY_DATA!, "views.json"), "utf8"));
ctl.state = { ...ctl.state, views, outputs: [] };
const state = await stageController.createView("After restart");
const created = state.views[state.views.length - 1];
console.log("CREATED:" + created.id);
process.exit(0);
`,
    "utf8",
  );
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn("npx", ["tsx", script], {
      cwd: REPO,
      env: { ...process.env, STAGE_UTILITY_DATA: TMP },
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
    assert.equal(await createViewAfterRestart(), "view-4", "a deleted id came back after a restart");
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
