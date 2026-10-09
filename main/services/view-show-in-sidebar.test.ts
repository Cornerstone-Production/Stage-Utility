// A console's "kept out of the sidebar" choice has to survive a restart, a
// duplicate and an export-then-import.
//
// The failure this is here for is invisible in the UI: the flag is set on the
// in-memory View and never written, so the console leaves the rail, and the next
// time the server starts it quietly comes back. The same three places a per-View
// field has gone missing before:
//
//  - the controller setter updates memory and forgets the file;
//  - `duplicateView` once listed the fields to KEEP;
//  - a view bundle carries `views` verbatim, and nothing enforced that. Here the
//    REAL export feeds the REAL import against a real data directory, so a step
//    that rebuilt the view from a list of known fields would drop the flag and
//    this would say so.
//
// views.json is read back off disk rather than trusting the object in memory.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-showinsidebar-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { viewsStore } = await import("./views-store.js");
const { oscStore } = await import("./osc-store.js");
const { buildViewBundle } = await import("./view-export.js");
const { applyViewBundle } = await import("./view-import.js");
const { viewShownInSidebar } = await import("../types/views.js");

type Mutable = {
  state: { views: View[]; outputs: Output[]; [k: string]: unknown };
  broadcast: () => void;
};
const ctl = stageController as unknown as Mutable;
ctl.broadcast = () => {};

/** Invented ids and names, as every fixture in this repo is. */
const CONSOLE = "view-stage-left";
const OTHER = "view-monitor-world";

const layout = { version: 1, canvas: { width: 1920, height: 1080 }, objects: [] };

function seed() {
  ctl.state = {
    ...ctl.state,
    views: [
      { id: CONSOLE, name: "Stage left", kind: "custom", surface: "console", createdAt: "2026-01-01T00:00:00.000Z", layout },
      { id: OTHER, name: "Monitor World", kind: "custom", surface: "console", createdAt: "2026-01-01T00:00:00.000Z", layout },
    ] as unknown as View[],
    outputs: [] as unknown as Output[],
  };
}

beforeEach(async () => {
  seed();
  await viewsStore.save(ctl.state.views);
  await oscStore.save([] as never);
});

/** A MISSING file reads as no views, so the assertion names what went wrong;
 *  anything but ENOENT is rethrown, so a permissions error is not an empty store. */
async function storedViews(): Promise<View[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(TMP, "views.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed = JSON.parse(raw) as View[] | { views?: View[] };
  return Array.isArray(parsed) ? parsed : (parsed.views ?? []);
}
const stored = async (id: string) => (await storedViews()).find((v) => v.id === id);
const live = (id: string) => stageController.getState().views.find((v) => v.id === id);

describe("keeping a console out of the sidebar", () => {
  it("absent means shown, so an existing console stays listed", () => {
    assert.equal(live(CONSOLE)?.showInSidebar, undefined, "a fresh console must not carry the flag");
    assert.equal(viewShownInSidebar(live(CONSOLE) as View), true);
  });

  it("is written to disk, not only to memory", async () => {
    await stageController.setViewShowInSidebar(CONSOLE, false);
    assert.equal(live(CONSOLE)?.showInSidebar, false, "the in-memory view did not take it");
    assert.equal(
      (await stored(CONSOLE))?.showInSidebar,
      false,
      "the flag never reached views.json — the console is back in the sidebar on the next restart",
    );
  });

  it("comes back, and stays written that way", async () => {
    await stageController.setViewShowInSidebar(CONSOLE, false);
    await stageController.setViewShowInSidebar(CONSOLE, true);
    assert.equal(viewShownInSidebar(live(CONSOLE) as View), true);
    assert.equal((await stored(CONSOLE))?.showInSidebar, true, "listing it again left the file hidden");
  });

  it("does not reach any other console", async () => {
    await stageController.setViewShowInSidebar(CONSOLE, false);
    assert.equal(live(OTHER)?.showInSidebar, undefined, "one console's setting reached another");
    assert.equal((await stored(OTHER))?.showInSidebar, undefined);
  });

  it("does not touch the surface, which is what keeps its controls live", async () => {
    await stageController.setViewShowInSidebar(CONSOLE, false);
    assert.equal(live(CONSOLE)?.surface, "console", "hiding it from the sidebar changed what the view is");
  });

  it("refuses a view that does not exist", async () => {
    await assert.rejects(
      () => stageController.setViewShowInSidebar("view-not-here", false),
      /views:setShowInSidebar/,
      "an unknown id was accepted and wrote nothing anybody could find",
    );
  });

  it("survives a duplicate", async () => {
    await stageController.setViewShowInSidebar(CONSOLE, false);
    await stageController.duplicateView(CONSOLE, "Stage left copy");
    const copy = stageController.getState().views.find((v) => v.name === "Stage left copy");
    assert.ok(copy, "the duplicate was not created");
    assert.equal(copy.showInSidebar, false, "the duplicate came back listed in the sidebar");
  });

  it("travels in a view export and survives an import", async () => {
    await stageController.setViewShowInSidebar(CONSOLE, false);
    const bundle = await buildViewBundle(CONSOLE);
    assert.equal(bundle.views[0].showInSidebar, false, "the export dropped the field");

    // Import into an empty install: the bundle is the only place it can come from.
    await viewsStore.save([] as never);
    await applyViewBundle(JSON.parse(JSON.stringify(bundle)));
    const landed = await viewsStore.load();
    assert.equal(landed.length, 1);
    assert.equal(landed[0].showInSidebar, false, "the import dropped the field");
  });
});
