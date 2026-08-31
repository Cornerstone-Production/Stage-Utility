// An update must not take a wall screen's URL away without saying so.
//
// `/logs` was a legal display slug: RESERVED_SLUGS held "log" alone and
// OPERATOR_PATHS has no /logs. This release makes it both reserved AND a live
// route, dispatched from EARLY_ROUTE_MODULES ahead of slug resolution. Because
// validateSlug runs on the WRITE path only, a stored slug is never re-checked —
// so the screen quietly stops rendering and serves the log viewer instead, while
// its Screens card goes on advertising that URL.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { Output } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-slugmig-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { migrateReservedSlugs, slugMigrationLog } = await import("./slug-migration.js");
const { RESERVED_SLUGS } = await import("./reserved-slugs.js");

const out = (id: string, name: string, slug?: string): Output =>
  ({ id, name, viewId: null, ...(slug ? { slug } : {}) }) as Output;

describe("a slug the app has since claimed", () => {
  it("MOVES rather than shadowing the screen", () => {
    const r = migrateReservedSlugs([out("display-2", "Lobby wall", "logs")]);
    assert.equal(
      r.outputs[0].slug,
      "logs-2",
      "the screen kept a slug the app now serves itself — it renders the log viewer instead",
    );
    assert.deepEqual(r.changed, [
      { outputId: "display-2", outputName: "Lobby wall", from: "logs", to: "logs-2" },
    ]);
  });

  it("is not silently dropped", () => {
    // The repository rule: do not delete the operator's work to tidy something
    // up. The alias survives under a new name, and the change is reported.
    const r = migrateReservedSlugs([out("display-2", "Lobby wall", "logs")]);
    assert.ok(r.outputs[0].slug, "the alias was deleted rather than moved");
    assert.match(slugMigrationLog(r)[0], /Lobby wall.*\/logs.*\/logs-2.*\/display-2/);
  });

  it("does not land on a name another screen already holds", () => {
    const r = migrateReservedSlugs([
      out("display-2", "Lobby wall", "logs"),
      out("display-3", "Foyer", "logs-2"),
    ]);
    assert.equal(r.outputs[0].slug, "logs-3");
    assert.equal(r.outputs[1].slug, "logs-2", "an unrelated screen was renamed");
  });

  it("leaves a slug the app does not serve alone, by reference", () => {
    // Reference equality is what lets the caller skip its write entirely.
    const outputs = [out("display-2", "Lobby wall", "stage-left"), out("display-3", "Foyer")];
    const r = migrateReservedSlugs(outputs);
    assert.equal(r.outputs, outputs, "an untouched list was rebuilt, forcing a needless write");
    assert.deepEqual(r.changed, []);
  });

  it("finds nothing on a second pass", () => {
    const once = migrateReservedSlugs([out("display-2", "Lobby wall", "logs")]);
    assert.deepEqual(migrateReservedSlugs(once.outputs).changed, [], "it renames on every boot");
  });

  it("covers every reserved name, not just the one that broke", () => {
    // Written against the list rather than against "logs": the next path the app
    // claims must be repaired by this too, with no second commit.
    const stored = RESERVED_SLUGS.filter((s) => s !== "");
    const r = migrateReservedSlugs(stored.map((s, i) => out(`display-${i + 2}`, `Screen ${i + 2}`, s)));
    assert.equal(r.changed.length, stored.length);
    for (const o of r.outputs) {
      assert.ok(o.slug && !RESERVED_SLUGS.includes(o.slug), `left ${o.slug} shadowed by a built-in page`);
    }
  });
});

// Through the real boot, because the write path is not where this has to happen
// — the LOAD path is, and a pure function nothing calls repairs nothing.
describe("the load path repairs it", () => {
  after(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("rewrites settings.json on the first boot after the update", async () => {
    await fs.writeFile(
      path.join(TMP, "settings.json"),
      JSON.stringify({
        appName: "Stage Utility",
        outputs: [{ id: "display-1", name: "Lobby wall", viewId: "view-1", slug: "logs" }],
        layoutDefaultsCleaned: true,
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(TMP, "views.json"),
      JSON.stringify([{ id: "view-1", name: "Lobby", kind: "slots", surface: "display" }]),
      "utf8",
    );

    const { stageController } = await import("./stage-controller.js");
    const ctl = stageController as unknown as {
      broadcast: () => void;
      recomputeResolved: () => void;
      startUpdateChecks: () => void;
    };
    ctl.broadcast = () => {};
    ctl.recomputeResolved = () => {};
    ctl.startUpdateChecks = () => {};

    await stageController.init();

    const written = JSON.parse(await fs.readFile(path.join(TMP, "settings.json"), "utf8")) as {
      outputs: Output[];
    };
    assert.equal(
      written.outputs[0].slug,
      "logs-2",
      "settings.json still holds a slug the app serves itself — that screen shows the log viewer",
    );
    assert.equal(
      stageController.getOutputs()[0].slug,
      "logs-2",
      "memory and disk disagree about the screen's URL",
    );
  });
});
