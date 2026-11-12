// A layout's address across the upgrade that started storing it.
//
// Before slugs were stored, a rundown address was looked up by name: the layout with that
// id, else the first in order whose slugify(name) matched (origin/main,
// renderer/main/servicecue-plan-view.tsx:216-218, copied below as the oracle). The
// backfill writes slugs to disk on the first read, so a slug that moves an address moves
// it for good. The new side goes through findLayout, the function the rundown calls.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-layout-backfill-"));
process.env.STAGE_UTILITY_DATA = dir;
process.env.HOME = path.join(dir, "home");

const { serviceCueLayoutsStore } = await import("./servicecue-layouts-store.js");
const { assignSlugs, findLayout, isSlug, slugify } = await import("./servicecue-slug.js");

after(() => fs.rm(dir, { recursive: true, force: true }));

const FILE = path.join(dir, "servicecue-layouts.json");
const rolesFile = path.join(dir, "servicecue-roles.json");

const ALL = "(all columns)";
const WANTS_ALL = new Set(["all-columns", "__all__"]);

/** What an address opened on main. */
function mainOpens(layouts: { id: string; name: string; order: number }[], param: string): string {
  if (WANTS_ALL.has(param)) return ALL;
  const sorted = [...layouts].sort((a, b) => a.order - b.order);
  return (sorted.find((l) => l.id === param) ?? sorted.find((l) => slugify(l.name) === param.toLowerCase()))?.id ?? ALL;
}

/** What it opens once the slugs are stored. */
function nowOpens(layouts: Parameters<typeof findLayout>[0], param: string): string {
  return WANTS_ALL.has(param) ? ALL : (findLayout(layouts, param)?.id ?? ALL);
}

/** Every address that opened a layout on main, with the layout it opened. */
function oldAddresses(layouts: { id: string; name: string; order: number }[]): [string, string][] {
  const params = new Set(layouts.flatMap((l) => [l.id, slugify(l.name)]));
  return [...params].map((p) => [p, mainOpens(layouts, p)] as [string, string]).filter(([, id]) => id !== ALL);
}

function assertSameAddresses(before: { id: string; name: string; order: number }[], label: string): void {
  const after = assignSlugs(before);
  for (const [param, opened] of oldAddresses(before)) {
    assert.equal(nowOpens(after, param), opened, `${label}: /${param} opened ${opened} before slugs`);
  }
  const slugs = after.map((l) => l.slug);
  assert.equal(new Set(slugs).size, slugs.length, `${label}: a slug is shared: ${slugs.join(", ")}`);
  assert.ok(slugs.every((s) => !!s && s !== "all-columns" && isSlug(s)), `${label}: ${slugs.join(", ")}`);
  assert.deepEqual(assignSlugs(after), after, `${label}: not idempotent`);
}

describe("the backfill keeps every address that opened a layout", () => {
  test("Audio, audio, Audio 2: /audio-2 still opens Audio 2, and that is what lands on disk", async () => {
    const before = [
      { id: "svl-1", name: "Audio", order: 0, columnRoles: [] },
      { id: "svl-2", name: "audio", order: 1, columnRoles: [] },
      { id: "svl-3", name: "Audio 2", order: 2, columnRoles: [] },
    ];
    assertSameAddresses(before, "Audio/audio/Audio 2");
    await fs.writeFile(FILE, JSON.stringify(before));
    await fs.writeFile(rolesFile, "[]");
    const loaded = await serviceCueLayoutsStore.load(); // the first read of this file
    assert.equal(nowOpens(loaded, "audio"), "svl-1");
    assert.equal(nowOpens(loaded, "audio-2"), "svl-3", "the address of Audio 2 moved to the shadowed audio");
    const onDisk = JSON.parse(await fs.readFile(FILE, "utf8")) as { id: string; slug: string }[];
    assert.deepEqual(onDisk.map((l) => [l.id, l.slug]), [["svl-1", "audio"], ["svl-2", "audio-3"], ["svl-3", "audio-2"]]);
  });

  test("the same three in every order", () => {
    const names = ["Audio", "audio", "Audio 2"];
    for (const perm of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      assertSameAddresses(perm.map((n, order) => ({ id: `svl-${n}`, name: names[n], order })), perm.join(""));
    }
  });

  test("random lists from names that collide in every way the old lookup allowed", () => {
    const pool = ["Audio", "audio", "Audio 2", "audio-2", "Audio!", "Audio 3", "All columns", "All Columns 2", "!!!", "???", "Звук", "Свет", "x", "x 2", "svl-0"];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let run = 0; run < 2000; run++) {
      const size = 2 + rand(6);
      // Orders drawn from a small range, so ties (settled by position) happen too.
      const list = Array.from({ length: size }, (_, i) => ({ id: `svl-${i}`, name: pool[rand(pool.length)], order: rand(4) }));
      assertSameAddresses(list, JSON.stringify(list.map((l) => [l.name, l.order])));
    }
  });

  test("a stored slug that is not a well-formed slug is treated as absent", () => {
    const out = assignSlugs([
      { id: "1", name: "Audio", order: 0, slug: 5 as unknown as string },
      { id: "2", name: "Video", order: 1, slug: "Not A Slug" },
      { id: "3", name: "Lights", order: 2, slug: "" },
      { id: "4", name: "Keys", order: 3, slug: "../keys" },
    ]);
    assert.deepEqual(out.map((l) => l.slug), ["audio", "video", "lights", "keys"]);
  });
});

describe("a restored layouts file", () => {
  const check = async (raw: unknown) => {
    const { restoreCheckFor } = await import("./stores.js");
    const run = restoreCheckFor("servicecue-layouts.json");
    assert.ok(run, "the layouts file has no restore check");
    return run(raw);
  };

  test("with a well-formed slug and flag, or neither, is accepted", async () => {
    assert.equal((await check([{ id: "1", name: "A", order: 0, slug: "a", autoNamed: true }])).ok, true);
    assert.equal((await check([{ id: "1", name: "A", order: 0 }])).ok, true);
  });

  test("with a slug no address could be, or a flag that is not true or false, is refused", async () => {
    for (const bad of [{ slug: "Not A Slug" }, { slug: "" }, { slug: 5 }, { slug: "a/b" }, { autoNamed: "yes" }, { autoNamed: 1 }]) {
      const result = await check([{ id: "1", name: "A", order: 0, ...bad }]);
      assert.equal(result.ok, false, JSON.stringify(bad));
    }
  });
});
