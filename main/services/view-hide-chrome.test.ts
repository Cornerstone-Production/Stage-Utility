// A console's hidden chrome has to survive a restart, a duplicate and an export.
//
// The failure this is here for is invisible in the UI: the flag is set on the
// in-memory View and never written, so the operator hides the bars, they go, and
// the next time the server starts the console quietly grows them back. That has
// happened in this repo before with an Output's top bar, which is why the
// equivalent test for THAT flag exists.
//
// Three more places a per-View field has silently gone missing here:
//
//  - `duplicateView` once listed the fields to KEEP, so a duplicated console
//    came back as a display with `surface`, `slotsLayout` and
//    `scriptViewLayoutId` all dropped. It spreads the source now, and this
//    checks the spread still reaches a field added after that fix.
//  - a view bundle carries `views` verbatim; nothing enforces that.
//  - views.json is in CONFIG_FILES, so the flag rides in every config snapshot.
//    A store missing from the export is silently absent from every backup, and
//    this asserts the file it lives in is the one that gets exported.
//
// So this drives the REAL controller against a real data directory and reads
// views.json back off disk rather than trusting the object in memory.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-hidechrome-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { configFiles } = await import("./config-snapshot.js");

type Mutable = {
  state: { views: View[]; outputs: Output[]; [k: string]: unknown };
  broadcast: () => void;
};

const ctl = stageController as unknown as Mutable;
ctl.broadcast = () => {};

/** Invented ids and names, as every fixture in this repo is. */
const CONSOLE = "view-booth-console";
const OTHER = "view-monitor-world";

function seed() {
  ctl.state = {
    ...ctl.state,
    views: [
      { id: CONSOLE, name: "Booth", kind: "custom", surface: "console", createdAt: "2026-01-01T00:00:00.000Z", layout: null },
      { id: OTHER, name: "Monitor World", kind: "custom", surface: "console", createdAt: "2026-01-01T00:00:00.000Z", layout: null },
    ] as unknown as View[],
    outputs: [] as unknown as Output[],
  };
}

beforeEach(seed);

/** The views as they are actually on disk, read back rather than trusted.
 *
 *  A MISSING file is the bug, not an error to report as one: "nothing was
 *  written" and "what was written is wrong" are the same failure to an operator
 *  whose console grew its bars back, so it reads as no views and lets the
 *  assertion below say what actually went wrong. Anything other than ENOENT is
 *  rethrown — a permissions error must not read as an empty store. */
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

describe("hiding a console's chrome", () => {
  it("defaults to off, and off means absent rather than false", async () => {
    assert.equal(live(CONSOLE)?.hideChrome, undefined, "a fresh console must not carry the flag");
  });

  it("is written to disk, not only to memory", async () => {
    await stageController.setViewHideChrome(CONSOLE, true);
    assert.equal(live(CONSOLE)?.hideChrome, true, "the in-memory view did not take it");
    assert.equal(
      (await stored(CONSOLE))?.hideChrome,
      true,
      "the flag never reached views.json — it is gone on the next restart",
    );
  });

  it("comes back off, and stays written that way", async () => {
    await stageController.setViewHideChrome(CONSOLE, true);
    await stageController.setViewHideChrome(CONSOLE, false);
    assert.equal((await stored(CONSOLE))?.hideChrome, false, "turning it back on-screen left the file hidden");
  });

  it("does not reach any other console", async () => {
    await stageController.setViewHideChrome(CONSOLE, true);
    assert.equal(live(OTHER)?.hideChrome, undefined, "one console's setting reached another");
    assert.equal((await stored(OTHER))?.hideChrome, undefined);
  });

  it("refuses a view that does not exist", async () => {
    await assert.rejects(
      () => stageController.setViewHideChrome("view-not-here", true),
      /views:setHideChrome/,
      "an unknown id was accepted and wrote nothing anybody could find",
    );
  });

  it("survives a duplicate", async () => {
    // duplicateView spreads the source and overrides only what must differ. A
    // list of fields to KEEP is how `surface` was silently dropped once, and a
    // field added later is exactly what such a list would miss.
    await stageController.setViewHideChrome(CONSOLE, true);
    await stageController.duplicateView(CONSOLE, "Booth copy");
    const copy = stageController.getState().views.find((v) => v.name === "Booth copy");
    assert.ok(copy, "the duplicate was not created");
    assert.equal(copy.hideChrome, true, "the duplicated console came back with its chrome switched on");
  });

  it("rides in the config snapshot, because views.json does", async () => {
    // Not a proxy for the field: the export copies whole files, so the only way
    // the flag can go missing from a backup is the file going missing.
    assert.ok(
      configFiles().includes("views.json"),
      "views.json is no longer exported as config, so every console setting is absent from every backup",
    );
  });
});
