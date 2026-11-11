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
import { after, describe, test } from "node:test";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-layout-slugs-"));
process.env.STAGE_UTILITY_DATA = dir;
process.env.HOME = path.join(dir, "home");

const { serviceCueLayoutsStore } = await import("./servicecue-layouts-store.js");
const { assignSlugs } = await import("./servicecue-slug.js");


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
