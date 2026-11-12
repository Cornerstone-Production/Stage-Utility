// A layout's address, and what may share one.
//
// Rundown URLs name a layout by slug, and tablets and displays are pinned to them. The
// slug used to be the layout's name run through slugify at lookup time, so a rename
// moved every pinned screen to All columns without a word. It is now stored on the
// layout when the layout is made and kept through a rename.
//
// Driven against the real store with a layouts file as the PREVIOUS release wrote it
// (no slug field), and through the real controller save for the name rules.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, mock, test } from "node:test";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-layout-slugs-"));
process.env.STAGE_UTILITY_DATA = dir;
process.env.HOME = path.join(dir, "home");

const { serviceCueLayoutsStore } = await import("./servicecue-layouts-store.js");
const { assignSlugs, layoutNameRefusal, slugify } = await import("./servicecue-slug.js");
const { stageController } = await import("./stage-controller.js");
const { LayoutNameRefused } = await import("./servicecue-slug.js");
const { serviceCueRoutes } = await import("./routes/servicecue-routes.js");
const { servicecuePublisher } = await import("./servicecue-publisher-instance.js");
const { callRoute } = await import("./routes/route-harness.js");

afterEach(() => mock.restoreAll());

after(() => fs.rm(dir, { recursive: true, force: true }));

const FILE = path.join(dir, "servicecue-layouts.json");
const rolesFile = path.join(dir, "servicecue-roles.json");

// Two layouts as 1.28 saved them: no `slug`, one pair of names that slugify alike.
const PREVIOUS_RELEASE = [
  { id: "svl-a", name: "Audio Team", order: 0, columnRoles: ["role-band"] },
  { id: "svl-b", name: "Video", order: 1, columnRoles: ["role-band"] },
  { id: "svl-c", name: "audio team", order: 2, columnRoles: [] },
];

describe("a layouts file from before slugs", () => {
  test("loads with every layout intact, each slug taken from its CURRENT name", async () => {
    await fs.writeFile(rolesFile, JSON.stringify([{ id: "role-band", name: "Band", members: ["Band"] }]));
    await fs.writeFile(FILE, JSON.stringify(PREVIOUS_RELEASE));
    const loaded = await serviceCueLayoutsStore.load();
    assert.deepEqual(
      loaded.map((l) => [l.id, l.name, l.slug, l.columnRoles]),
      [
        ["svl-a", "Audio Team", "audio-team", ["role-band"]],
        ["svl-b", "Video", "video", ["role-band"]],
        // The old lookup took the first match, so the second same-named layout was
        // never reachable; it gets its own address instead of sharing the first's.
        ["svl-c", "audio team", "audio-team-2", []],
      ],
    );
    // Written back, so the slug is stable from here on, and nothing else changed.
    const onDisk = JSON.parse(await fs.readFile(FILE, "utf8")) as { id: string; slug: string }[];
    assert.deepEqual(onDisk.map((l) => l.slug), ["audio-team", "video", "audio-team-2"]);
  });

  test("a rename keeps the slug, through the real save", async () => {
    const saved = await serviceCueLayoutsStore.save(
      (await serviceCueLayoutsStore.load()).map((l) => (l.id === "svl-b" ? { ...l, name: "Video Crew", slug: "attacker-chosen" } : l)),
    );
    assert.equal(saved.find((l) => l.id === "svl-b")?.slug, "video");
    assert.equal((await serviceCueLayoutsStore.load()).find((l) => l.id === "svl-b")?.slug, "video");
  });

  test("a new layout gets a slug from its name that no other layout has", async () => {
    const list = await serviceCueLayoutsStore.load();
    const saved = await serviceCueLayoutsStore.save([...list, { id: "svl-d", name: "Video", order: 3, columnRoles: [] }]);
    assert.equal(saved.find((l) => l.id === "svl-d")?.slug, "video-2");
  });
});

describe("a slug is never shared", () => {
  test("a file carrying one slug twice, or the All columns slug, is made distinct on load", () => {
    const out = assignSlugs([
      { id: "1", name: "A", order: 0, slug: "same" },
      { id: "2", name: "B", order: 1, slug: "same" },
      { id: "3", name: "All columns", order: 2 },
    ]);
    assert.deepEqual(out.map((l) => l.slug), ["same", "b", "all-columns-2"]);
  });

  test("a name with no letters still gets a slug, and a second one a different slug", () => {
    const out = assignSlugs([
      { id: "1", name: "!!!", order: 0 },
      { id: "2", name: "???", order: 1 },
    ]);
    assert.deepEqual(out.map((l) => l.slug), ["x", "x-2"]);
  });

  test("assignSlugs is idempotent", () => {
    const once = assignSlugs([{ id: "1", name: "A", order: 0 }, { id: "2", name: "a", order: 1 }]);
    assert.deepEqual(assignSlugs(once), once);
  });
});

describe("a duplicate layout name", () => {
  const stored = [
    { id: "1", name: "Audio", order: 0 },
    { id: "2", name: "Video", order: 1 },
  ];

  test("is refused when a save adds or changes a name that matches another, ignoring case and punctuation", () => {
    for (const name of ["audio", "AUDIO!", "  Audio  ", "-audio-"]) {
      assert.match(layoutNameRefusal([stored[0], { ...stored[1], name }], stored) ?? "", /already a layout called "Audio"/, name);
    }
    assert.match(layoutNameRefusal([...stored, { id: "3", name: "video", order: 2 }], stored) ?? "", /"Video"/);
  });

  test("a blank name, and the built-in All columns name, are refused", () => {
    assert.match(layoutNameRefusal([{ ...stored[0], name: "  " }, stored[1]], stored) ?? "", /needs a name/);
    assert.match(layoutNameRefusal([{ ...stored[0], name: "All Columns" }, stored[1]], stored) ?? "", /built-in/);
  });

  test("is not refused when the names are unchanged, so an install that already has a pair can still be edited", () => {
    const pair = [{ id: "1", name: "Audio", order: 0 }, { id: "2", name: "audio", order: 1 }];
    assert.equal(layoutNameRefusal(pair.map((l) => ({ ...l, order: l.order + 1 })), pair), null);
    assert.equal(slugify("Audio"), slugify("audio"));
  });

  test("the controller refuses it with LayoutNameRefused, saves nothing, and logs it", async () => {
    await serviceCueLayoutsStore.save([{ id: "1", name: "Audio", order: 0, columnRoles: [] }]);
    const before = await fs.readFile(FILE, "utf8");
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      await assert.rejects(
        stageController.saveServiceCueLayouts([
          { id: "1", name: "Audio", order: 0, columnRoles: [] },
          { id: "2", name: "AUDIO", order: 1, columnRoles: [] },
        ]),
        LayoutNameRefused,
      );
    } finally {
      console.log = log;
    }
    assert.equal(await fs.readFile(FILE, "utf8"), before);
    assert.ok(lines.some((l) => l.startsWith("[servicecue]") && l.includes("refused")), lines.join("\n"));
  });
});

describe("POST /api/servicecue/layouts with a duplicate name", () => {
  test("answers 400 with the reason, keeps the stored list, and does not wake the publisher", async () => {
    await serviceCueLayoutsStore.save([{ id: "1", name: "Audio", order: 0, columnRoles: [] }]);
    const before = await fs.readFile(FILE, "utf8");
    const nudge = mock.method(servicecuePublisher, "nudge", () => undefined);
    mock.method(console, "log", () => undefined);
    const res = await callRoute(serviceCueRoutes, "/api/servicecue/layouts", {
      method: "POST",
      body: { layouts: [{ id: "1", name: "Audio", order: 0 }, { id: "2", name: "audio", order: 1 }] },
    });
    assert.equal(res.status, 400);
    assert.match((res.json as { error: string }).error, /already a layout called "Audio"/);
    assert.equal(nudge.mock.callCount(), 0);
    assert.equal(await fs.readFile(FILE, "utf8"), before);
  });
});

describe("names in any script", () => {
  const stored = [
    { id: "1", name: "Звук", order: 0 },
    { id: "2", name: "Audio", order: 1 },
  ];

  test("two different non-Latin names are two names, though both slugify to x", () => {
    assert.equal(slugify("Звук"), slugify("Свет"));
    assert.equal(layoutNameRefusal([stored[0], { ...stored[1], name: "Свет" }], stored), null);
    assert.equal(layoutNameRefusal([...stored, { id: "3", name: "照明", order: 2 }], stored), null);
  });

  test("the same non-Latin name, in another case or with punctuation, is refused", () => {
    for (const name of ["звук", "ЗВУК!", " Звук "]) {
      assert.match(layoutNameRefusal([stored[0], { ...stored[1], name }], stored) ?? "", /already a layout called "Звук"/, name);
    }
  });

  test("a name with no letters is compared as written, so !!! and ??? may both exist", () => {
    const marks = [{ id: "1", name: "!!!", order: 0 }];
    assert.equal(layoutNameRefusal([...marks, { id: "2", name: "???", order: 1 }], marks), null);
    assert.match(layoutNameRefusal([...marks, { id: "2", name: " !!! ", order: 1 }], marks) ?? "", /already a layout/);
  });

  test("two non-Latin layouts get two addresses, neither empty", async () => {
    await serviceCueLayoutsStore.save([]);
    const saved = await serviceCueLayoutsStore.save([
      { id: "1", name: "Звук", order: 0, columnRoles: [] },
      { id: "2", name: "Свет", order: 1, columnRoles: [] },
    ]);
    assert.deepEqual(saved.map((l) => l.slug), ["x", "x-2"]);
    assert.equal(saved.find((l) => l.slug === "x-2")?.name, "Свет");
  });
});

describe("POST /api/servicecue/layouts with a malformed list", () => {
  test("answers 400 before the store is asked", async () => {
    mock.method(console, "log", () => undefined);
    for (const layouts of [[null], [{ id: "1" }], [{ id: 2, name: "A" }], ["Audio"]]) {
      const res = await callRoute(serviceCueRoutes, "/api/servicecue/layouts", { method: "POST", body: { layouts } });
      assert.equal(res.status, 400, JSON.stringify(layouts));
      assert.match((res.json as { error: string }).error, /needs an id and a name/);
    }
  });
});

describe("an imported layout", () => {
  test("goes through the name rule, keeps a free slug from the file, and is never auto-named", async () => {
    await serviceCueLayoutsStore.save([]);
    // Ordered after the file's, so a clash settled by order alone would hand "audio" to the import.
    await serviceCueLayoutsStore.save([{ id: "here", name: "Audio", order: 5, columnRoles: [] }]);
    const renamed = await serviceCueLayoutsStore.importLayouts([
      { id: "f1", name: "audio", order: 0, slug: "audio", autoNamed: true, columnRoles: [] },
      { id: "f2", name: "Booth", order: 1, slug: "booth-crew", columnRoles: [] },
      { id: "f3", name: "   ", order: 2, slug: "Bad Slug", columnRoles: [] },
    ]);
    const after = await serviceCueLayoutsStore.load();
    const by = (id: string) => after.find((l) => l.id === id)!;
    assert.equal(by("here").slug, "audio", "an import moved an address already here");
    assert.deepEqual([by("f1").name, by("f1").slug, by("f1").autoNamed], ["audio 2", "audio-2", undefined]);
    assert.deepEqual([by("f2").name, by("f2").slug], ["Booth", "booth-crew"]);
    assert.deepEqual([by("f3").name, by("f3").slug], ["Layout", "layout"]);
    assert.deepEqual(renamed, [{ from: "audio", to: "audio 2" }, { from: "   ", to: "Layout" }]);
    // And a later rename of the imported one does not move its address: it was never auto-named.
    const saved = await serviceCueLayoutsStore.save(after.map((l) => (l.id === "f1" ? { ...l, name: "Monitors" } : l)));
    assert.equal(saved.find((l) => l.id === "f1")?.slug, "audio-2");
  });

  test("through a view import, a clashing name is renamed and reported rather than failing the import", async () => {
    const { applyViewBundle } = await import("./view-import.js");
    const logged = mock.method(console, "log", () => undefined);
    await serviceCueLayoutsStore.save([]);
    await serviceCueLayoutsStore.save([{ id: "here", name: "Audio", order: 0, columnRoles: [] }]);
    const report = await applyViewBundle({
      kind: "stage-utility-view", version: 1, appVersion: "1.0.0",
      createdAt: "2026-08-17T00:00:00.000Z", source: { server: "Elsewhere" },
      views: [{ id: "view-1", name: "Left", kind: "script", createdAt: 0, serviceCueLayoutId: "f1" }],
      sideData: { slots: {}, notes: {}, serviceCueLayouts: [{ id: "f1", name: "AUDIO", order: 0, autoNamed: true, columnRoles: [] }] },
      targets: { osc: [], rosstalk: [] },
      images: {},
    });
    const f1 = (await serviceCueLayoutsStore.load()).find((l) => l.id === "f1");
    assert.deepEqual([f1?.name, f1?.autoNamed], ["AUDIO 2", undefined]);
    assert.ok(report.skipped.some((s) => s.includes('"AUDIO" — imported as "AUDIO 2"')), report.skipped.join("\n"));
    // And on /log, where an operator can find it after the dialog has closed.
    const lines = logged.mock.calls.map((c) => c.arguments.join(" "));
    assert.deepEqual(lines.filter((l) => l.startsWith("[view-import] ServiceCue preset")), [
      '[view-import] ServiceCue preset "AUDIO" imported as "AUDIO 2": that name was taken here',
    ]);
  });
});
