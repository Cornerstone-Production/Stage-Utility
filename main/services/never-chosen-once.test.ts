// Loading a layout must not restyle it.
//
// Two properties, one load pass:
//
//  1. An alignment is never touched, on any load. `textAlign: "center"` is three
//     characters in a file and they look the same whether the object registry
//     wrote them at creation or the operator picked centre in the inspector. The
//     pass used to strip them, so the operator's choice was deleted on every
//     restart — that is, every update, and it was reported exactly that way.
//
//  2. The card grounds it does still fold run ONCE, recorded in settings. Same
//     ambiguity, lower stakes: they change whether a widget occludes what is
//     behind it. One pass, then never again.
//
// This drives the REAL load pass rather than the pure function, because the pure
// function was not where the bug was: it did what it said, once per call, and
// the caller called it on every boot forever.

import assert from "node:assert/strict";
import { describe, test, before } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "never-chosen-once-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { viewsStore } = await import("./views-store.js");
const { settingsStore } = await import("./settings-store.js");

type Pass = (views: View[], outputs: Output[]) => Promise<{ views: View[]; outputs: Output[] }>;
const runLoadPass = (
  stageController as unknown as { applySurfaceMigration: Pass }
).applySurfaceMigration.bind(stageController) as Pass;

/** One console, one centred readout on a translucent card — the two properties
 *  in one object, so a pass that confuses them cannot pass. */
function seedView(): View[] {
  return [
    {
      id: "v1",
      name: "FOH",
      kind: "custom",
      createdAt: "",
      surface: "console",
      layout: {
        version: 1,
        canvas: { width: 1920, height: 1080, background: null },
        objects: [
          {
            id: "o1",
            x: 0, y: 0, w: 0.2, h: 0.1, z: 1,
            config: { type: "obs-status", mode: "recording", showTimecode: false, hideWhenIdle: false, fillWhenRecording: true },
            style: { textAlign: "center", background: "rgba(255,255,255,0.04)" },
          },
        ],
      },
    } as unknown as View,
  ];
}

const styleOf = (views: View[]) => views.find((v) => v.id === "v1")?.layout?.objects[0]?.style ?? {};

before(async () => {
  await settingsStore.patch({ outputs: [] });
});

describe("loading a layout", () => {
  test("folds the translucent ground on the first load", async () => {
    await viewsStore.save(seedView());
    const out = await runLoadPass(await viewsStore.load(), []);
    assert.equal(styleOf(out.views).background, "#141414", "the ground the registry wrote was not folded");
  });

  test("leaves the operator's alignment alone while doing it", async () => {
    assert.equal(
      styleOf(await viewsStore.load()).textAlign,
      "center",
      "the alignment was stripped — it will not survive an update",
    );
  });

  test("and folds nothing on the next load, whatever it finds", async () => {
    // The operator has since picked one of the old grounds themselves. The pass
    // has had its turn, so this is now a colour like any other.
    await viewsStore.save(seedView());
    const out = await runLoadPass(await viewsStore.load(), []);
    assert.equal(styleOf(out.views).background, "rgba(255,255,255,0.04)", "it restyled a second time");
    assert.equal(styleOf(out.views).textAlign, "center");
    assert.equal(styleOf(await viewsStore.load()).background, "rgba(255,255,255,0.04)", "and wrote that to disk");
  });

  test("the pass records that it ran, so a fresh install never runs it either", async () => {
    assert.equal((await settingsStore.get()).layoutDefaultsCleaned, true);
  });
});
