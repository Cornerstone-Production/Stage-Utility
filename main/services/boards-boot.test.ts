// The boot that moves slots.json onto boards, through the real init() over v3
// files on disk: once with the slots write failing, which must leave both files
// as they were and still draw every screen, then for real.
//
// Through the real load path because a migration is only worth anything if the
// load runs it. Every id and name is invented.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-boards-boot-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { slotsStore } = await import("./slots-store.js");

const ctl = stageController as unknown as {
  broadcast: () => void;
  startUpdateChecks: () => void;
  stopSlotsPruning: () => void;
};
ctl.broadcast = () => {};
ctl.startUpdateChecks = () => {};

const TYPE = "st-weekend";
const row = (id: string, label: string) => ({ id, channel: "1", order: 0, link: { kind: "static", label, color: "#2E6691" } });

const VIEWS = [
  { id: "display-1", name: "Left Display", kind: "slots", surface: "display", createdAt: "", slotsLayout: { displayWidthIn: 32.25, columnWidthIn: 3.49 } },
  { id: "display-2", name: "Right Display", kind: "slots", surface: "display", createdAt: "" },
  {
    id: "view-2", name: "Right Display - Stage Layout", kind: "custom", surface: "display", createdAt: "",
    layout: { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [
      { id: "g-right", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", source: "inline", sourceViewId: null } },
      { id: "g-embed", x: 0, y: 0, w: 1, h: 1, z: 1, config: { type: "slots-grid", source: "view", sourceViewId: "display-1" } },
    ] },
  },
];
const SLOTS = {
  version: 3,
  defaults: {
    "display-1": { [TYPE]: [row("l1", "Pastor")] },
    "display-2": { [TYPE]: [row("r1", "Keys")] },
    "g-right": { [TYPE]: [row("g1", "Drums")] },
  },
  overrides: {},
};

const lines: string[] = [];
const realLog = console.log;
const realError = console.error;
const readJson = async (file: string): Promise<Record<string, unknown> | unknown[]> => JSON.parse(await fs.readFile(path.join(TMP, file), "utf8"));
const labels = (rows: Slot[] | undefined) => (rows ?? []).map((r) => (r.link as { label: string }).label);

async function boot(): Promise<void> {
  lines.length = 0;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    await stageController.init();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

before(async () => {
  await fs.writeFile(
    path.join(TMP, "settings.json"),
    JSON.stringify({
      appName: "Stage Utility",
      layoutDefaultsCleaned: true,
      cardHairlineRaised: true,
      screenRolesFromView: true,
      serviceTypeId: TYPE,
      planId: null,
      outputs: [{ id: "display-1", name: "Left", viewId: "display-1" }, { id: "display-2", name: "Right", viewId: "display-2" }],
    }),
    "utf8",
  );
  await fs.writeFile(path.join(TMP, "views.json"), JSON.stringify(VIEWS), "utf8");
  await fs.writeFile(path.join(TMP, "slots.json"), JSON.stringify(SLOTS), "utf8");
});

after(async () => {
  ctl.stopSlotsPruning();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("a boot whose slots write fails", () => {
  before(async () => {
    const store = slotsStore as unknown as { replaceFile: (f: unknown) => Promise<void> };
    const real = store.replaceFile;
    store.replaceFile = async () => { throw new Error("disk full"); };
    try {
      await boot();
    } finally {
      store.replaceFile = real;
    }
  });

  it("leaves views.json and slots.json as they were", async () => {
    // The views passes before this one (Home is seeded) may write views.json;
    // what must not be there is any trace of THIS migration.
    const views = (await readJson("views.json")) as { id: string; boardId?: string; slotsLayout?: unknown; layout?: { objects: { config: Record<string, unknown> }[] } }[];
    assert.ok(views.every((v) => !("boardId" in v)), "views.json was left half-migrated: a view points at a board");
    assert.deepEqual(views.find((v) => v.id === "display-1")?.slotsLayout, { displayWidthIn: 32.25, columnWidthIn: 3.49 });
    assert.deepEqual(views.find((v) => v.id === "view-2")?.layout?.objects.map((o) => o.config), VIEWS[2]!.layout!.objects.map((o) => o.config));
    assert.deepEqual(await readJson("slots.json"), SLOTS, "slots.json was written");
  });

  it("says so on a tagged line", () => {
    assert.ok(lines.some((l) => /^\[slots-store\] could not save the slot boards migration;.*Writing slots\.json failed; this boot runs on the views as they were:.*disk full/.test(l)), lines.join("\n"));
  });

  it("still draws every screen and widget, from the old shapes", () => {
    const s = stageController.getState();
    assert.deepEqual(labels(s.slotsByView["display-1"]), ["Pastor"]);
    assert.deepEqual(labels(s.slotsByLayoutObject["g-right"]), ["Drums"]);
    assert.deepEqual(labels(s.slotsByLayoutObject["g-embed"]), ["Pastor"]);
    assert.deepEqual(s.slotsLayoutByView["display-1"], { displayWidthIn: 32.25, columnWidthIn: 3.49 });
  });
});

describe("the boot that migrates", () => {
  before(boot);

  it("writes slots.json as v4 with a board per key, moving no rows", async () => {
    const slots = (await readJson("slots.json")) as { version: number; boards: Record<string, { name: string; columnWidthIn: number | null }>; defaults: unknown };
    assert.equal(slots.version, 4);
    assert.deepEqual(
      Object.fromEntries(Object.entries(slots.boards).map(([id, b]) => [id, [b.name, b.columnWidthIn]])),
      {
        "display-1": ["Left Display", 3.49],
        "display-2": ["Right Display", null],
        "g-right": ["Right Display - Stage Layout · widget", null],
      },
    );
    assert.deepEqual(slots.defaults, SLOTS.defaults);
  });

  it("writes views.json with every screen and widget pointed", async () => {
    const all = (await readJson("views.json")) as (typeof VIEWS[number] & { boardId?: string })[];
    const views = ["display-1", "display-2", "view-2"].map((id) => all.find((v) => v.id === id)!);
    assert.deepEqual(views.map((v) => v.boardId), ["display-1", "display-2", undefined]);
    assert.deepEqual(views[0]!.slotsLayout, { displayWidthIn: 32.25 });
    assert.deepEqual(views[2]!.layout!.objects.map((o) => o.config), [
      { type: "slots-grid", boardId: "g-right" },
      { type: "slots-grid", boardId: "display-1", displayWidthIn: 32.25 },
    ]);
  });

  it("logs the migration", () => {
    assert.ok(lines.includes("[slots-store] migrated slots.json v3 → v4: 3 board(s) from 3 key(s), 0 merged, 0 unused"), lines.join("\n"));
  });

  it("draws the same rows and the same alignment as before", () => {
    const s = stageController.getState();
    assert.deepEqual(labels(s.slotsByView["display-1"]), ["Pastor"]);
    assert.deepEqual(labels(s.slotsByView["display-2"]), ["Keys"]);
    assert.deepEqual(labels(s.slotsByLayoutObject["g-right"]), ["Drums"]);
    assert.deepEqual(labels(s.slotsByLayoutObject["g-embed"]), ["Pastor"]);
    assert.deepEqual(s.slotsLayoutByView["display-1"], { displayWidthIn: 32.25, columnWidthIn: 3.49 });
    assert.deepEqual(s.slotsLayoutByLayoutObject["g-embed"], { displayWidthIn: 32.25, columnWidthIn: 3.49 });
  });

  it("does nothing on the next boot", async () => {
    const before = await fs.readFile(path.join(TMP, "slots.json"), "utf8");
    await boot();
    assert.equal(await fs.readFile(path.join(TMP, "slots.json"), "utf8"), before);
    assert.ok(!lines.some((l) => l.startsWith("[slots-store]")), lines.filter((l) => l.startsWith("[slots-store]")).join("\n"));
  });
});
