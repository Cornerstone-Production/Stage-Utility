// The sidebar's saved arrangement, driven through its route.
//
// Through the ROUTE, the way bar-config-store.test.ts is, because the route is
// where a request's shape is checked: a store called with a hand-built value
// cannot show that a bad request is refused and leaves the saved one alone.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";

// Set before the module graph loads, so the stores this route reaches read an
// empty tree instead of the operator's real config.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-config-"));
process.env.STAGE_UTILITY_DATA = DIR;

const { displaySettingsRoutes } = await import("./routes/display-settings-routes.js");
const { callRoute } = await import("./routes/route-harness.js");
const { sidebarConfigStore } = await import("./sidebar-config-store.js");
const { DEFAULT_SIDEBAR } = await import("./sidebar-arrangement.js");

after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

const save = (body: unknown) => callRoute(displaySettingsRoutes, "/api/sidebar", { method: "POST", body: body as never });
const onDisk = () => JSON.parse(fs.readFileSync(path.join(DIR, "sidebar-config.json"), "utf8")) as unknown;

function arrangement() {
  return {
    sections: DEFAULT_SIDEBAR.map((s) => ({ ...s, members: [...s.members] })),
    hidden: [] as string[],
  };
}

describe("saving the sidebar", () => {
  test("an install that never saved one has the default, which is nothing", async () => {
    await sidebarConfigStore.init();
    assert.deepEqual(sidebarConfigStore.get(), { sections: [], hidden: [] });
  });

  test("a valid arrangement is written to disk and kept", async () => {
    const next = arrangement();
    next.sections[2].label = "Show";
    next.hidden = ["baptisms"];
    next.sections[5].members = next.sections[5].members.filter((m) => m !== "baptisms");
    const res = await save(next);
    assert.equal(res.status, 200);
    assert.deepEqual(onDisk(), next);
    assert.equal(sidebarConfigStore.get().sections[2].label, "Show");
  });

  test("a refused arrangement says why and leaves the saved one alone", async () => {
    const before = onDisk();
    const bad = arrangement();
    bad.sections[1].members = ["patch"];
    bad.sections[2].members = bad.sections[2].members.filter((m) => m !== "patch");
    const res = await save(bad);
    assert.equal(res.status, 400);
    assert.match(res.body, /Consoles holds consoles only/);
    assert.deepEqual(onDisk(), before);
  });

  test("a file that breaks the rules is kept beside the store before a save can replace it", async () => {
    const file = path.join(DIR, "sidebar-config.json");
    const bad = JSON.stringify({ sections: [{ id: "top", label: "", kind: "top", members: ["home", "patch"] }, { id: "x", kind: "widgets", label: "X", members: [] }], hidden: [] });
    fs.writeFileSync(file, bad);
    await sidebarConfigStore.init();
    // Drawn from what can be read, not the default.
    assert.deepEqual(sidebarConfigStore.get().sections[0].members, ["home", "patch"]);
    const copies = fs.readdirSync(DIR).filter((f) => f.startsWith("sidebar-config.json.invalid-"));
    assert.equal(copies.length, 1, "no copy of the operator's file was kept");
    assert.equal(fs.readFileSync(path.join(DIR, copies[0]), "utf8"), bad);
    // The next save replaces the live file; the copy stays.
    const res = await save(arrangement());
    assert.equal(res.status, 200);
    assert.equal(fs.readFileSync(path.join(DIR, copies[0]), "utf8"), bad);
  });
});
