# View Export/Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export one view to a JSON file from its three-dot menu, and import that
file into another install as new views alongside the existing ones.

**Architecture:** A pure reference-collector walks a view's layout and reports
everything it points at. An export service turns that into a bundle reusing the
config snapshot's envelope and base64 image map. An import service mints fresh
ids, remaps cross-references between the bundle's own views, merges side data and
targets into existing files, and returns a report of what landed and what needs
rebinding. The UI is one menu item, one button and one review sheet.

**Tech Stack:** TypeScript, node:test, React 19, Tailwind v4, existing
`DataStore`, `layout-clone`, `config-snapshot` and `layout-image-store`.

**Spec:** `docs/superpowers/specs/2026-08-17-view-export-import-design.md`
**Mockup:** https://claude.ai/code/artifact/9e89333c-601b-49dd-ac0d-048e59b9d289

## Global Constraints

- No emojis anywhere — UI, code, comments, commit messages.
- Every new `catch` rethrows or returns the failure to its caller. A `catch` that
  only logs is a defect.
- Any guard ships with proof: reintroduce the bug, watch the test go red, say so
  in the commit.
- Before fixing a repeated pattern, grep every instance and fix them together;
  say in the commit how many were found and how many changed.
- Every new config `DataStore` joins the store registry as `"config"` in the same
  change. This plan adds no new store.
- Bundle `kind` is exactly `"stage-utility-view"`, `version` is exactly `1`.
- Imported view name collisions get exactly `" (imported)"` appended.
- Secrets never enter a bundle. Passwords live in `secretsStore`, not in the
  config files this reads, so this is preserved by not adding code that reaches
  for them.
- Run `npm run lint && npm run type-check && npm test && npm run build` before
  every commit and read the output in-session.

## File Structure

| File | Responsibility |
|---|---|
| `main/types/view-bundle.ts` | Bundle, reference and report types. No logic. |
| `main/services/view-refs.ts` | Pure: walk layouts, collect every outward reference. |
| `main/services/view-export.ts` | Build a bundle from a view id. Reads stores. |
| `main/services/view-import.ts` | Remap ids, merge into stores, return a report. |
| `main/services/routes/view-routes.ts` | Two new routes on the existing module. |
| `renderer/app/screens/import-layout.tsx` | The import button, review sheet and report. |
| `renderer/settings/sections/outputs-section.tsx` | One menu item. |

---

## Phase 1 — The bundle

### Task 1: Collect what a view references

**Files:**
- Create: `main/types/view-bundle.ts`
- Create: `main/services/view-refs.ts`
- Test: `main/services/view-refs.test.ts`

**Interfaces:**
- Consumes: `LayoutObject`, `LayoutDTO`, `View` from `main/types/views.js`.
- Produces: `collectRefs(views: View[]): ViewRefs` and the types below.

- [ ] **Step 1: Write the types**

Create `main/types/view-bundle.ts`:

```ts
// What a view points at, what travels with it, and what came back.
//
// A custom layout is not self-contained: its objects reference views, images,
// targets and hardware. These types name the three outcomes — travels, resolves
// anyway, needs rebinding — so no caller has to re-derive them.

import type { View } from "./views.js";
import type { OscTarget } from "./osc.js";

/** A binding that names hardware the destination will not have. */
export interface UnresolvableRef {
  kind: "wireless" | "charger" | "spl" | "sensource" | "propresenter";
  /** The layout object holding it, so the UI can select it in the editor. */
  objectId: string;
  /** What to call it in the rebind list, e.g. "Handheld 3". */
  label: string;
  /** The id it points at, shown so an operator can recognise it. */
  value: string;
}

export interface ViewRefs {
  /** Views this one embeds, transitively. Excludes the root. */
  embeddedViewIds: string[];
  /** Every layout object id across every collected view. */
  objectIds: string[];
  /** `layout-images/<file>` paths referenced by image objects. */
  imageFiles: string[];
  oscTargetIds: string[];
  rosstalkTargetIds: string[];
  /** Device-level bindings, for the rebind work list. */
  unresolvable: UnresolvableRef[];
}

export interface ViewBundle {
  kind: "stage-utility-view";
  version: 1;
  appVersion: string;
  createdAt: string;
  source: { server: string };
  views: View[];
  sideData: {
    /** slots.json key -> serviceTypeId -> rows. Key is a view id or object id. */
    slots: Record<string, Record<string, unknown[]>>;
    /** layout object id -> notes content. */
    notes: Record<string, unknown>;
    scriptviewLayouts: unknown[];
  };
  targets: { osc: OscTarget[]; rosstalk: unknown[] };
  /** `<dir>/<file>` -> base64, matching ConfigSnapshot.images. */
  images: Record<string, string>;
}

export interface ImportReport {
  views: { id: string; name: string; renamedFrom?: string }[];
  targetsAdded: { kind: "osc" | "rosstalk"; id: string; name: string }[];
  targetsKept: { kind: "osc" | "rosstalk"; id: string; name: string }[];
  images: { written: number; shared: number; failed: string[] };
  /** The work list. Objects whose bindings name absent hardware. */
  rebind: UnresolvableRef[];
}
```

- [ ] **Step 2: Write the failing test**

Create `main/services/view-refs.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { collectRefs } from "./view-refs.js";
import type { View, LayoutObject } from "../types/views.js";

// Export is only as good as this walk: a reference it misses is a hole in the
// imported layout, and a reference it invents is a file that will not build.

const obj = (id: string, config: Record<string, unknown>): LayoutObject =>
  ({ id, x: 0, y: 0, w: 10, h: 10, z: 0, style: {}, config }) as LayoutObject;

const view = (id: string, objects: LayoutObject[], over: Partial<View> = {}): View =>
  ({ id, name: id, kind: "custom", createdAt: 0,
     layout: { version: 1, canvas: { w: 1920, h: 1080 }, objects } , ...over }) as View;

describe("what a view points at", () => {
  test("an embedded view is collected", () => {
    const a = view("view-1", [obj("o1", { type: "view-embed", viewId: "view-2" })]);
    const b = view("view-2", []);
    assert.deepEqual(collectRefs([a, b], "view-1").embeddedViewIds, ["view-2"]);
  });

  test("embedding is followed transitively, and never loops", () => {
    // A cycle is possible to author and must not hang the export.
    const a = view("view-1", [obj("o1", { type: "view-embed", viewId: "view-2" })]);
    const b = view("view-2", [obj("o2", { type: "view-embed", viewId: "view-1" })]);
    assert.deepEqual(collectRefs([a, b], "view-1").embeddedViewIds, ["view-2"]);
  });

  test("a slots-grid sourcing another view counts as embedding it", () => {
    const a = view("view-1", [obj("o1", { type: "slots-grid", source: "view", sourceViewId: "view-9" })]);
    assert.deepEqual(collectRefs([a, view("view-9", [])], "view-1").embeddedViewIds, ["view-9"]);
  });

  test("nested container children are walked", () => {
    const child = obj("deep", { type: "image", src: "/layout-images/abc.png" });
    const parent = { ...obj("box", { type: "container" }), children: [child] } as LayoutObject;
    const r = collectRefs([view("view-1", [parent])], "view-1");
    assert.deepEqual(r.imageFiles, ["layout-images/abc.png"]);
    assert.ok(r.objectIds.includes("deep"), "a child object was not collected");
  });

  test("targets are collected by id", () => {
    const v = view("view-1", [
      obj("o1", { type: "osc-button", targetId: "osc-a", address: "/x", args: [] }),
      obj("o2", { type: "rosstalk-button", targetId: "ross-a", commandId: "cut" }),
    ]);
    const r = collectRefs([v], "view-1");
    assert.deepEqual(r.oscTargetIds, ["osc-a"]);
    assert.deepEqual(r.rosstalkTargetIds, ["ross-a"]);
  });

  test("hardware bindings land in the rebind list, not silently dropped", () => {
    const v = view("view-1", [
      obj("o1", { type: "wireless-channel", channelId: "conn-7::3", label: "Handheld 3" }),
      obj("o2", { type: "spl-meter", meterId: "FOH::Main", metricKey: "spl" }),
    ]);
    const kinds = collectRefs([v], "view-1").unresolvable.map((u) => u.kind).sort();
    assert.deepEqual(kinds, ["spl", "wireless"]);
  });

  test("integration status and the primary ProPresenter are NOT rebind work", () => {
    // Their ids are fixed constants and "default" — they resolve on any install
    // that has the integration configured, so listing them would be noise.
    const v = view("view-1", [
      obj("o1", { type: "integration-status", integrationId: "obs" }),
      obj("o2", { type: "propresenter-slide", propresenterInstanceId: "default" }),
    ]);
    assert.deepEqual(collectRefs([v], "view-1").unresolvable, []);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --import tsx --test main/services/view-refs.test.ts`
Expected: FAIL, `Cannot find module './view-refs.js'`.

- [ ] **Step 4: Implement the collector**

Create `main/services/view-refs.ts`:

```ts
// What a view points at, gathered in one walk.
//
// Pure and total: it reads layouts and returns data, touching no store. Export
// decides what to do with the answer; this decides only what the answer is.

import type { View, LayoutObject } from "../types/views.js";
import type { ViewRefs, UnresolvableRef } from "../types/view-bundle.js";

/** Walk an object and its children. Containers nest arbitrarily deep. */
function walk(objects: LayoutObject[], visit: (o: LayoutObject) => void): void {
  for (const o of objects) {
    visit(o);
    if (o.children?.length) walk(o.children, visit);
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function collectRefs(all: View[], rootId: string): ViewRefs {
  const byId = new Map(all.map((v) => [v.id, v]));
  const embedded: string[] = [];
  const objectIds: string[] = [];
  const imageFiles: string[] = [];
  const osc: string[] = [];
  const ross: string[] = [];
  const unresolvable: UnresolvableRef[] = [];

  // Breadth-first over the embed graph. `seen` includes the root, so a cycle
  // terminates and the root never lists itself as its own dependency.
  const seen = new Set<string>([rootId]);
  const queue = [rootId];

  while (queue.length) {
    const v = byId.get(queue.shift()!);
    if (!v?.layout) continue;

    walk(v.layout.objects, (o) => {
      objectIds.push(o.id);
      const c = o.config as Record<string, unknown>;
      const type = str(c.type);

      const embed =
        type === "view-embed" ? str(c.viewId)
        : type === "slots-grid" && c.source === "view" ? str(c.sourceViewId)
        : "";
      if (embed && !seen.has(embed)) {
        seen.add(embed);
        embedded.push(embed);
        queue.push(embed);
      }

      // `/layout-images/<file>` on the wire; `<dir>/<file>` in the bundle, which
      // is the shape ConfigSnapshot.images already uses.
      if (type === "image") {
        const src = str(c.src);
        const m = /^\/layout-images\/(.+)$/.exec(src);
        if (m) imageFiles.push(`layout-images/${m[1]}`);
      }

      if (type === "osc-button" && str(c.targetId)) osc.push(str(c.targetId));
      if (type === "rosstalk-button" && str(c.targetId)) ross.push(str(c.targetId));

      // Hardware. Named individually because the import report is a work list,
      // not a count — the operator has to find these objects to fix them.
      const push = (kind: UnresolvableRef["kind"], value: string, label: string) => {
        if (value) unresolvable.push({ kind, objectId: o.id, label: label || o.id, value });
      };
      if (type === "wireless-channel") push("wireless", str(c.channelId), str(c.label));
      if (type === "spl-meter") push("spl", str(c.meterId), str(c.meterId));
      if (type === "people-counter") push("sensource", str(c.zoneId), str(c.zoneId));
      if (type === "charger-battery") {
        for (const b of Array.isArray(c.bays) ? c.bays : []) {
          push("charger", str((b as Record<string, unknown>)?.id), "Charger bay");
        }
      }
      // The PRIMARY instance is "default" on every install, so only an extra
      // instance is work. Same reasoning as integration-status, which is a fixed
      // constant and never listed.
      const pp = str(c.propresenterInstanceId);
      if (pp && pp !== "default") push("propresenter", pp, "ProPresenter");
    });
  }

  const uniq = (a: string[]) => [...new Set(a)];
  return {
    embeddedViewIds: embedded,
    objectIds,
    imageFiles: uniq(imageFiles),
    oscTargetIds: uniq(osc),
    rosstalkTargetIds: uniq(ross),
    unresolvable,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --test main/services/view-refs.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Prove the cycle guard**

Delete the `seen.add(embed)` line, re-run, and confirm the transitive test hangs
or fails. Restore it. Note the result in the commit.

- [ ] **Step 7: Commit**

```bash
npm run lint && npm run type-check && npm test && npm run build
git add main/types/view-bundle.ts main/services/view-refs.ts main/services/view-refs.test.ts
git commit -m "feat(views): collect everything a view points at

One walk over the embed graph returns embedded views, object ids, image files,
target ids and the hardware bindings that will need rebinding. Pure, so export
and the import report share one answer.

Integration status and the primary ProPresenter instance are deliberately not
rebind work: their ids are fixed constants and \"default\", so they resolve on
any install that has the integration configured.

The cycle guard is proven — removing seen.add() makes the transitive test hang."
```

---

### Task 2: Build the bundle

**Files:**
- Create: `main/services/view-export.ts`
- Test: `main/services/view-export.test.ts`

**Interfaces:**
- Consumes: `collectRefs(all: View[], rootId: string): ViewRefs`, `ViewBundle`.
- Produces: `buildViewBundle(rootId: string): Promise<ViewBundle>`.

- [ ] **Step 1: Write the failing test**

Create `main/services/view-export.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// A real data directory, never the operator's. STAGE_UTILITY_DATA must be set
// before any store module is imported, because DataStore resolves its path once.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-export-"));
process.env.STAGE_UTILITY_DATA = dir;

const { viewsStore } = await import("./views-store.js");
const { buildViewBundle } = await import("./view-export.js");

const custom = (id: string, objects: unknown[]) => ({
  id, name: id, kind: "custom", createdAt: 0,
  layout: { version: 1, canvas: { w: 1920, h: 1080 }, objects },
});

beforeEach(async () => {
  await viewsStore.save([
    custom("view-1", [{ id: "o1", x: 0, y: 0, w: 1, h: 1, z: 0, style: {},
      config: { type: "view-embed", viewId: "view-2" } }]),
    custom("view-2", []),
    custom("view-3", []),
  ] as never);
});

describe("building a view bundle", () => {
  test("carries the chosen view and what it embeds, and nothing else", async () => {
    const b = await buildViewBundle("view-1");
    assert.deepEqual(b.views.map((v) => v.id), ["view-1", "view-2"]);
  });

  test("is stamped so an import can refuse the wrong file", async () => {
    const b = await buildViewBundle("view-1");
    assert.equal(b.kind, "stage-utility-view");
    assert.equal(b.version, 1);
    assert.ok(b.createdAt, "no createdAt");
  });

  test("an unknown view id is an error, not an empty bundle", async () => {
    // An empty bundle downloads happily and fails silently at the other end.
    await assert.rejects(() => buildViewBundle("view-nope"), /view-nope/);
  });

  test("carries no secrets", async () => {
    // Belt and braces: passwords live in secretsStore, and nothing here reads
    // it. This asserts the property rather than the implementation.
    const b = await buildViewBundle("view-1");
    const text = JSON.stringify(b).toLowerCase();
    for (const word of ["password", "secret", "apikey", "token"]) {
      assert.ok(!text.includes(word), `bundle mentions "${word}"`);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test main/services/view-export.test.ts`
Expected: FAIL, `Cannot find module './view-export.js'`.

- [ ] **Step 3: Implement the builder**

Create `main/services/view-export.ts`:

```ts
// Turn a view into a file.
//
// Reuses the config snapshot's envelope — kind, version, appVersion, createdAt
// and a `<dir>/<file>` base64 image map — so there is one bundle shape in this
// codebase rather than two.

import { readFile } from "node:fs/promises";

import { collectRefs } from "./view-refs.js";
import { viewsStore } from "./views-store.js";
import { slotsStore } from "./slots-store.js";
import { notesStore } from "./notes-store.js";
import { scriptviewLayoutsStore } from "./scriptview-layouts-store.js";
import { oscStore } from "./osc-store.js";
import { rosstalkStore } from "./rosstalk-store.js";
import { settingsStore } from "./settings-store.js";
import { readLayoutImage } from "./layout-image-store.js";
import { appVersion } from "./config-snapshot.js";
import type { ViewBundle } from "../types/view-bundle.js";

export async function buildViewBundle(rootId: string): Promise<ViewBundle> {
  const all = await viewsStore.load();
  const root = all.find((v) => v.id === rootId);
  // Loudly, not an empty bundle: a file that downloads and does nothing at the
  // far end is the worst outcome here.
  if (!root) throw new Error(`export — unknown view ${rootId}`);

  const refs = collectRefs(all, rootId);
  const views = [root, ...refs.embeddedViewIds.map((id) => all.find((v) => v.id === id)!)]
    .filter(Boolean);

  // Slot rows are keyed by view id (a slots view) or by layout object id (an
  // inline slots-grid). Both are collected, for EVERY service type: the
  // destination may run different ones, and dropping them loses real work.
  const slotsFile = await slotsStore.all();
  const slots: Record<string, Record<string, unknown[]>> = {};
  for (const key of [...views.map((v) => v.id), ...refs.objectIds]) {
    if (slotsFile[key]) slots[key] = slotsFile[key];
  }

  const notes: Record<string, unknown> = {};
  for (const id of refs.objectIds) {
    const n = notesStore.get(id);
    if (n && Object.keys(n).length) notes[id] = n;
  }

  const svLayouts = await scriptviewLayoutsStore.load();
  const wanted = new Set(views.map((v) => v.scriptViewLayoutId).filter(Boolean));
  const scriptviewLayouts = svLayouts.filter((l) => wanted.has(l.id));

  const oscTargets = (await oscStore.load()).filter((t) => refs.oscTargetIds.includes(t.id));
  const rossTargets = (await rosstalkStore.load()).filter((t) => refs.rosstalkTargetIds.includes(t.id));

  // A missing image is reported by its absence from the map, not by refusing to
  // export. An export that fails because one logo was deleted is worse.
  const images: Record<string, string> = {};
  for (const ref of refs.imageFiles) {
    const file = ref.slice("layout-images/".length);
    const img = await readLayoutImage(file);
    if (img) images[ref] = img.data.toString("base64");
  }

  const settings = await settingsStore.load();
  return {
    kind: "stage-utility-view",
    version: 1,
    appVersion: appVersion(),
    createdAt: new Date().toISOString(),
    source: { server: settings.appName || "Stage Utility" },
    views,
    sideData: { slots, notes, scriptviewLayouts },
    targets: { osc: oscTargets, rosstalk: rossTargets },
    images,
  };
}
```

If `slotsStore.all()` or `appVersion()` do not exist under those names, add them:
`slotsStore` already wraps a `DataStore`, so `all()` is `await store.load()`;
`config-snapshot.ts` has a private `pkgVersion()` which this task exports as
`appVersion()`.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test main/services/view-export.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run type-check && npm test && npm run build
git add main/services/view-export.ts main/services/view-export.test.ts main/services/config-snapshot.ts
git commit -m "feat(views): build an export bundle from one view

Reuses the config snapshot's envelope and its <dir>/<file> base64 image map, so
this codebase has one bundle shape rather than two. Carries the view, what it
embeds, side data keyed by object id, referenced target definitions and image
bytes.

Slot rows come across for every service type, not just the active one: the
destination may run different ones and dropping them loses an operator's work.
An unknown view id throws rather than producing an empty bundle that would fail
silently at the far end."
```

---

### Task 3: The export route

**Files:**
- Modify: `main/services/routes/view-routes.ts`
- Test: `main/services/routes/view-export-route.test.ts`

**Interfaces:**
- Consumes: `buildViewBundle(rootId: string): Promise<ViewBundle>`.
- Produces: `GET /api/views/:id/export` returning the bundle as a download.

- [ ] **Step 1: Write the failing test**

Create `main/services/routes/view-export-route.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { exportFilename } from "./view-routes.js";

// The filename is the only part of this route worth pinning in isolation; the
// body is buildViewBundle's, already tested, and the wiring is proven against a
// real server in Task 6.
describe("the download filename", () => {
  test("is slugged from the view name and dated", () => {
    assert.equal(
      exportFilename("Left Mic Display", new Date("2026-08-17T12:00:00Z")),
      "stage-utility-view-left-mic-display-2026-08-17.json",
    );
  });

  test("survives a name that is punctuation and spaces", () => {
    // A view named "FOH / Booth (2)" must not produce a path separator.
    const out = exportFilename("FOH / Booth (2)", new Date("2026-08-17T12:00:00Z"));
    assert.ok(!out.includes("/"), `slug contains a separator: ${out}`);
    assert.equal(out, "stage-utility-view-foh-booth-2-2026-08-17.json");
  });

  test("a name with nothing sluggable still yields a filename", () => {
    assert.equal(
      exportFilename("///", new Date("2026-08-17T12:00:00Z")),
      "stage-utility-view-2026-08-17.json",
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test main/services/routes/view-export-route.test.ts`
Expected: FAIL, `exportFilename is not a function`.

- [ ] **Step 3: Implement**

In `main/services/routes/view-routes.ts`, add the helper and the route. Place the
route beside the existing `POST /api/views/:id/duplicate`:

```ts
/** `stage-utility-view-left-mic-display-2026-08-17.json`. Exported for its test. */
export function exportFilename(name: string, now: Date): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const day = now.toISOString().slice(0, 10);
  return `stage-utility-view-${slug ? `${slug}-` : ""}${day}.json`;
}
```

```ts
// GET /api/views/:id/export — the whole view as one file.
const exportMatch = /^\/api\/views\/([^/]+)\/export$/.exec(pathname);
if (method === "GET" && exportMatch) {
  const id = decodeURIComponent(exportMatch[1]);
  try {
    const bundle = await buildViewBundle(id);
    const name = bundle.views[0]?.name ?? id;
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(name, new Date())}"`,
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(bundle, null, 2));
  } catch (err) {
    error(res, errorMessage(err), 404);
  }
  return;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test main/services/routes/view-export-route.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Drive the real server**

```bash
D=/tmp/su-export-check && rm -rf "$D" && mkdir -p "$D" && cp -R ~/.stage-utility/. "$D"/
npm run build
STAGE_UTILITY_DATA="$D" PORT=8851 STAGE_UTILITY_PORT=8851 npm run server &
# Wait for /api/version, then:
curl -s -D- -o /tmp/bundle.json "http://127.0.0.1:8851/api/views/view-1/export" | grep -i content-disposition
python3 -c "import json;d=json.load(open('/tmp/bundle.json'));print(d['kind'],len(d['views']),'views')"
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8851/api/views/nope/export"   # expect 404
lsof -ti tcp:8851 | xargs -r kill
```

Never point `STAGE_UTILITY_DATA` at `~/.stage-utility`. Kill the server by
**port**, never `pkill -f` — the env prefix is not in the process command line.

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run type-check && npm test && npm run build
git add main/services/routes/view-routes.ts main/services/routes/view-export-route.test.ts
git commit -m "feat(views): GET /api/views/:id/export

Downloads one view as a file. Filename is slugged from the view name; a name
that is entirely punctuation still yields a valid filename and can never emit a
path separator. Unknown id is a 404.

Driven against a real server on a COPY of the config: header, body and the 404."
```

---

## Phase 2 — Import

### Task 4: Remap ids, including cross-references

**Files:**
- Create: `main/services/view-remap.ts`
- Test: `main/services/view-remap.test.ts`

**Interfaces:**
- Consumes: `cloneLayoutWithMap(l: LayoutDTO): { layout: LayoutDTO; idMap: Map<string,string> }`
  from `main/services/layout-clone.js`.
- Produces: `remapBundle(views: View[], newViewId: (i: number) => string):
  { views: View[]; viewIdMap: Map<string,string>; objectIdMap: Map<string,string> }`.

This is the heart of the feature. `layout-clone` shallow-copies `config`, so
`viewId` and `sourceViewId` survive a clone verbatim — right when duplicating in
place, wrong when several views arrive together and one embeds another.

- [ ] **Step 1: Write the failing test**

Create `main/services/view-remap.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { remapBundle } from "./view-remap.js";
import type { View } from "../types/views.js";

const v = (id: string, objects: unknown[]): View =>
  ({ id, name: id, kind: "custom", createdAt: 0,
     layout: { version: 1, canvas: { w: 1920, h: 1080 }, objects } }) as View;

const o = (id: string, config: Record<string, unknown>) =>
  ({ id, x: 0, y: 0, w: 1, h: 1, z: 0, style: {}, config });

describe("remapping an imported bundle", () => {
  test("an embed points at the NEW id of the view that came with it", () => {
    // The bug this exists for: without the remap the embed still names view-2
    // from the SOURCE install, which here is somebody else's view or nothing.
    const out = remapBundle([
      v("view-1", [o("o1", { type: "view-embed", viewId: "view-2" })]),
      v("view-2", []),
    ], (i) => `view-new-${i}`);

    const embed = out.views[0].layout!.objects[0].config as Record<string, unknown>;
    assert.equal(embed.viewId, out.views[1].id);
    assert.notEqual(embed.viewId, "view-2");
  });

  test("a slots-grid sourceViewId is remapped the same way", () => {
    const out = remapBundle([
      v("view-1", [o("o1", { type: "slots-grid", source: "view", sourceViewId: "view-2" })]),
      v("view-2", []),
    ], (i) => `view-new-${i}`);
    const cfg = out.views[0].layout!.objects[0].config as Record<string, unknown>;
    assert.equal(cfg.sourceViewId, out.views[1].id);
  });

  test("a reference to a view NOT in the bundle is left alone", () => {
    // It may resolve locally. Rewriting it to a minted id would break a link
    // that would otherwise have worked.
    const out = remapBundle([
      v("view-1", [o("o1", { type: "view-embed", viewId: "view-elsewhere" })]),
    ], (i) => `view-new-${i}`);
    const cfg = out.views[0].layout!.objects[0].config as Record<string, unknown>;
    assert.equal(cfg.viewId, "view-elsewhere");
  });

  test("every object gets a fresh id, and the map records it", () => {
    const out = remapBundle([v("view-1", [o("o1", { type: "clock" })])], (i) => `view-new-${i}`);
    const fresh = out.views[0].layout!.objects[0].id;
    assert.notEqual(fresh, "o1");
    assert.equal(out.objectIdMap.get("o1"), fresh);
  });

  test("a hardware binding is carried across untouched", () => {
    // Deliberate: it names gear, it is reported for rebinding, it is never
    // silently cleared.
    const out = remapBundle([
      v("view-1", [o("o1", { type: "wireless-channel", channelId: "conn-7::3" })]),
    ], (i) => `view-new-${i}`);
    const cfg = out.views[0].layout!.objects[0].config as Record<string, unknown>;
    assert.equal(cfg.channelId, "conn-7::3");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test main/services/view-remap.test.ts`
Expected: FAIL, `Cannot find module './view-remap.js'`.

- [ ] **Step 3: Implement**

Create `main/services/view-remap.ts`:

```ts
// Give an imported bundle ids of its own.
//
// layout-clone already mints fresh OBJECT ids and hands back the map. What it
// does not do is rewrite the references INSIDE config — it shallow-copies that
// object — which is correct when duplicating a view in place and wrong when
// several views arrive together and one embeds another.

import { cloneLayoutWithMap } from "./layout-clone.js";
import type { View, LayoutObject } from "../types/views.js";

function rewrite(objects: LayoutObject[], viewIdMap: Map<string, string>): void {
  for (const o of objects) {
    const c = o.config as Record<string, unknown>;
    for (const key of ["viewId", "sourceViewId"] as const) {
      const cur = c[key];
      // Only what came in the bundle. A reference to a view that is not here may
      // resolve locally, and rewriting it would break a working link.
      if (typeof cur === "string" && viewIdMap.has(cur)) c[key] = viewIdMap.get(cur);
    }
    if (o.children?.length) rewrite(o.children, viewIdMap);
  }
}

export function remapBundle(
  views: View[],
  newViewId: (index: number) => string,
): { views: View[]; viewIdMap: Map<string, string>; objectIdMap: Map<string, string> } {
  const viewIdMap = new Map<string, string>();
  views.forEach((v, i) => viewIdMap.set(v.id, newViewId(i)));

  const objectIdMap = new Map<string, string>();
  const out = views.map((v) => {
    if (!v.layout) return { ...v, id: viewIdMap.get(v.id)! };
    const { layout, idMap } = cloneLayoutWithMap(v.layout);
    for (const [from, to] of idMap) objectIdMap.set(from, to);
    // After cloning, not before: the clone is what carries the stale references.
    rewrite(layout.objects, viewIdMap);
    return { ...v, id: viewIdMap.get(v.id)!, layout };
  });

  return { views: out, viewIdMap, objectIdMap };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test main/services/view-remap.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the remap guard**

Comment out the `rewrite(layout.objects, viewIdMap)` call. Re-run. The first two
tests must fail with the embed still naming `view-2`. Restore. Record it in the
commit — this is the defect the whole task exists for.

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run type-check && npm test && npm run build
git add main/services/view-remap.ts main/services/view-remap.test.ts
git commit -m "feat(views): remap ids across an imported bundle

layout-clone mints fresh object ids and returns the map, but shallow-copies
config — so viewId and sourceViewId survive a clone verbatim. Correct when
duplicating in place, wrong when three views arrive together and one embeds
another: the embed would name a view from the SOURCE install.

A reference to a view NOT in the bundle is deliberately left alone; it may
resolve locally, and rewriting it would break a working link. Hardware bindings
are carried untouched, to be reported for rebinding rather than cleared.

Guard proven: commenting out the rewrite makes both embed tests fail."
```

---

### Task 5: Apply a bundle

**Files:**
- Create: `main/services/view-import.ts`
- Test: `main/services/view-import.test.ts`

**Interfaces:**
- Consumes: `remapBundle`, `collectRefs`, `ViewBundle`, `ImportReport`.
- Produces: `applyViewBundle(bundle: unknown): Promise<ImportReport>`.

- [ ] **Step 1: Write the failing test**

Create `main/services/view-import.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-import-"));
process.env.STAGE_UTILITY_DATA = dir;

const { viewsStore } = await import("./views-store.js");
const { oscStore } = await import("./osc-store.js");
const { applyViewBundle } = await import("./view-import.js");

const bundle = (over: Record<string, unknown> = {}) => ({
  kind: "stage-utility-view", version: 1, appVersion: "1.0.0",
  createdAt: "2026-08-17T00:00:00.000Z", source: { server: "Elsewhere" },
  views: [{ id: "view-1", name: "Left Display", kind: "custom", createdAt: 0,
    layout: { version: 1, canvas: { w: 1920, h: 1080 }, objects: [] } }],
  sideData: { slots: {}, notes: {}, scriptviewLayouts: [] },
  targets: { osc: [], rosstalk: [] },
  images: {},
  ...over,
});

beforeEach(async () => {
  await viewsStore.save([] as never);
  await oscStore.save([] as never);
});

describe("importing a bundle", () => {
  test("a foreign file is refused by name", async () => {
    await assert.rejects(
      () => applyViewBundle({ kind: "stage-utility-config", version: 1 }),
      /stage-utility-config/,
      "the error must name what was actually given, so the operator learns they picked the config snapshot",
    );
  });

  test("adds the view without touching what is already there", async () => {
    await viewsStore.save([{ id: "view-9", name: "Mine", kind: "custom", createdAt: 0, layout: null }] as never);
    await applyViewBundle(bundle());
    const after = await viewsStore.load();
    assert.equal(after.length, 2);
    assert.ok(after.some((v) => v.id === "view-9"), "an existing view was lost");
  });

  test("a name collision is suffixed, and the existing view is untouched", async () => {
    await viewsStore.save([{ id: "view-9", name: "Left Display", kind: "custom", createdAt: 0, layout: null }] as never);
    const report = await applyViewBundle(bundle());
    const names = (await viewsStore.load()).map((v) => v.name).sort();
    assert.deepEqual(names, ["Left Display", "Left Display (imported)"]);
    assert.equal(report.views[0].renamedFrom, "Left Display");
  });

  test("a local target of the same id is never overwritten", async () => {
    await oscStore.save([{ id: "osc-a", name: "MINE", host: "10.0.0.1", port: 8000 }] as never);
    const report = await applyViewBundle(bundle({
      targets: { osc: [{ id: "osc-a", name: "THEIRS", host: "192.168.1.1", port: 9000 }], rosstalk: [] },
    }));
    const t = (await oscStore.load())[0] as { name: string };
    assert.equal(t.name, "MINE", "the imported target overwrote a local one");
    assert.equal(report.targetsKept.length, 1);
    assert.equal(report.targetsAdded.length, 0);
  });

  test("a target that is not here is added", async () => {
    const report = await applyViewBundle(bundle({
      targets: { osc: [{ id: "osc-b", name: "Lighting", host: "192.168.1.50", port: 8000 }], rosstalk: [] },
    }));
    assert.equal(report.targetsAdded.length, 1);
    assert.equal((await oscStore.load()).length, 1);
  });

  test("hardware bindings come back as a named work list, not a count", async () => {
    const report = await applyViewBundle(bundle({
      views: [{ id: "view-1", name: "L", kind: "custom", createdAt: 0, layout: {
        version: 1, canvas: { w: 1920, h: 1080 }, objects: [
          { id: "o1", x: 0, y: 0, w: 1, h: 1, z: 0, style: {},
            config: { type: "wireless-channel", channelId: "conn-7::3", label: "Handheld 3" } },
        ] } }],
    }));
    assert.equal(report.rebind.length, 1);
    assert.equal(report.rebind[0].label, "Handheld 3");
    // The object id must be the NEW one, or the UI cannot select it.
    assert.notEqual(report.rebind[0].objectId, "o1");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test main/services/view-import.test.ts`
Expected: FAIL, `Cannot find module './view-import.js'`.

- [ ] **Step 3: Implement**

Create `main/services/view-import.ts`:

```ts
// Merge a bundle into this install.
//
// The substantive difference from a config snapshot restore: that REPLACES whole
// files, this merges into files that already hold the operator's other views. So
// every write here is additive, and nothing local is ever overwritten.

import { randomUUID } from "node:crypto";

import { remapBundle } from "./view-remap.js";
import { collectRefs } from "./view-refs.js";
import { viewsStore } from "./views-store.js";
import { slotsStore } from "./slots-store.js";
import { notesStore } from "./notes-store.js";
import { scriptviewLayoutsStore } from "./scriptview-layouts-store.js";
import { oscStore } from "./osc-store.js";
import { rosstalkStore } from "./rosstalk-store.js";
import { saveLayoutImageBytes } from "./layout-image-store.js";
import type { ViewBundle, ImportReport } from "../types/view-bundle.js";
import type { View } from "../types/views.js";

function assertBundle(b: unknown): asserts b is ViewBundle {
  const o = b as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("import — not a JSON object");
  if (o.kind !== "stage-utility-view") {
    // Named, because picking the config snapshot by mistake is the likely error
    // and "invalid file" would not teach anybody anything.
    throw new Error(`import — this is a "${String(o.kind)}" file, not a view export`);
  }
  if (o.version !== 1) throw new Error(`import — unsupported version ${String(o.version)}`);
  if (!Array.isArray(o.views) || o.views.length === 0) throw new Error("import — no views in the file");
}

/** `Left Display` -> `Left Display (imported)` when taken. */
function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  let candidate = `${name} (imported)`;
  let n = 2;
  while (taken.has(candidate)) candidate = `${name} (imported ${n++})`;
  return candidate;
}

export async function applyViewBundle(raw: unknown): Promise<ImportReport> {
  assertBundle(raw);
  const bundle = raw;

  const existing = await viewsStore.load();
  const usedIds = new Set(existing.map((v) => v.id));
  let n = 1;
  const mintViewId = (): string => {
    while (usedIds.has(`view-${n}`)) n++;
    const id = `view-${n}`;
    usedIds.add(id);
    return id;
  };

  const { views, objectIdMap } = remapBundle(bundle.views as View[], () => mintViewId());

  const takenNames = new Set(existing.map((v) => v.name));
  const reportViews: ImportReport["views"] = [];
  const named = views.map((v) => {
    const name = freeName(v.name, takenNames);
    takenNames.add(name);
    reportViews.push(name === v.name ? { id: v.id, name } : { id: v.id, name, renamedFrom: v.name });
    return { ...v, name };
  });

  await viewsStore.save([...existing, ...named]);

  // Side data, re-keyed through the object map. A key that is a VIEW id is
  // remapped by position, since remapBundle preserved order.
  const viewKeyMap = new Map(bundle.views.map((v, i) => [(v as View).id, views[i].id]));
  for (const [oldKey, byServiceType] of Object.entries(bundle.sideData.slots)) {
    const newKey = objectIdMap.get(oldKey) ?? viewKeyMap.get(oldKey);
    if (!newKey) continue;
    for (const [serviceTypeId, rows] of Object.entries(byServiceType)) {
      await slotsStore.setSlots(newKey, serviceTypeId, (rows as never[]).map(
        (r) => ({ ...(r as object), id: randomUUID() }) as never,
      ));
    }
  }

  for (const [oldId, content] of Object.entries(bundle.sideData.notes)) {
    const newId = objectIdMap.get(oldId);
    if (newId) await notesStore.set(newId, content as never);
  }

  if (bundle.sideData.scriptviewLayouts.length) {
    const cur = await scriptviewLayoutsStore.load();
    const have = new Set(cur.map((l) => (l as { id: string }).id));
    const add = bundle.sideData.scriptviewLayouts.filter((l) => !have.has((l as { id: string }).id));
    if (add.length) await scriptviewLayoutsStore.save([...cur, ...add] as never);
  }

  // Targets: add what is missing, never touch what is here.
  const targetsAdded: ImportReport["targetsAdded"] = [];
  const targetsKept: ImportReport["targetsKept"] = [];
  for (const [kind, store, incoming] of [
    ["osc", oscStore, bundle.targets.osc],
    ["rosstalk", rosstalkStore, bundle.targets.rosstalk],
  ] as const) {
    const cur = (await store.load()) as { id: string; name?: string }[];
    const have = new Map(cur.map((t) => [t.id, t]));
    const add: unknown[] = [];
    for (const t of incoming as { id: string; name?: string }[]) {
      const row = { kind, id: t.id, name: t.name ?? t.id };
      if (have.has(t.id)) targetsKept.push(row);
      else { add.push(t); targetsAdded.push(row); }
    }
    if (add.length) await store.save([...cur, ...add] as never);
  }

  // Images. Content-addressed by sha256, so a logo already here collapses to the
  // same file rather than duplicating.
  const images = { written: 0, shared: 0, failed: [] as string[] };
  for (const [ref, b64] of Object.entries(bundle.images)) {
    if (!ref.startsWith("layout-images/")) { images.failed.push(ref); continue; }
    try {
      const fresh = await saveLayoutImageBytes(
        ref.slice("layout-images/".length),
        Buffer.from(b64, "base64"),
      );
      if (fresh) images.written++;
      else images.shared++;
    } catch (err) {
      // Recorded and returned, never swallowed: a layout missing one image is
      // more useful than no layout, but the operator has to be told.
      images.failed.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const rebind = collectRefs(named, named[0].id).unresolvable;

  return { views: reportViews, targetsAdded, targetsKept, images, rebind };
}
```

Add `saveLayoutImageBytes(file: string, data: Buffer): Promise<boolean>` to
`main/services/layout-image-store.ts` — returns `true` when it wrote a new file
and `false` when that hash was already present. The existing `saveLayoutImage`
takes a data URL; this takes bytes and an intended filename, verifies the sha256
prefix matches the content, and refuses otherwise.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test main/services/view-import.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Prove the never-overwrite guard**

Change the target merge to `await store.save([...cur.filter(t => !incoming.some(i => i.id === t.id)), ...incoming])`.
Re-run: the "never overwritten" test must fail with `THEIRS`. Restore.

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run type-check && npm test && npm run build
git add main/services/view-import.ts main/services/view-import.test.ts main/services/layout-image-store.ts
git commit -m "feat(views): merge an imported bundle into this install

Every write is additive. A config snapshot restore REPLACES whole files; this
merges into files that already hold the operator's other views, so nothing local
is ever overwritten — a target of the same id keeps the local definition and the
report says so.

Name collisions are suffixed rather than resolved by asking, and the existing
view is untouched. Images are content-addressed, so a shared logo collapses to
one file. Image failures are returned, not logged and dropped.

Guard proven: making the merge replace by id fails the never-overwrite test."
```

---

### Task 6: The import route

**Files:**
- Modify: `main/services/routes/view-routes.ts`
- Modify: `renderer/lib/api.ts`
- Test: driven against a real server (below)

**Interfaces:**
- Consumes: `applyViewBundle(bundle: unknown): Promise<ImportReport>`.
- Produces: `POST /api/views/import` returning `ImportReport`; channel
  `views:import`.

- [ ] **Step 1: Add the route**

In `main/services/routes/view-routes.ts`:

```ts
// POST /api/views/import — merge a bundle in and report what happened.
if (method === "POST" && pathname === "/api/views/import") {
  try {
    const report = await applyViewBundle(await readBody(req));
    // The view list changed and every open page renders from it.
    stageController.broadcastState();
    json(res, report);
  } catch (err) {
    error(res, errorMessage(err));
  }
  return;
}
```

Use whatever the controller's existing broadcast method is called; if there is no
public one, call the same path `duplicateView` uses after it saves.

- [ ] **Step 2: Add the channel**

In `renderer/lib/api.ts`, beside the other view channels:

```ts
    case "views:import":
      return post<T>("/api/views/import", p);
```

- [ ] **Step 3: Check the body limit**

`main/services/routes/body-limits.test.ts` pins per-route maximums. A bundle
carries base64 images and will exceed a small default. Add
`/api/views/import` to the generous tier alongside the config import, and extend
that test with the new path so the limit is asserted rather than assumed.

- [ ] **Step 4: Drive the real server, round trip**

```bash
D=/tmp/su-roundtrip && rm -rf "$D" && mkdir -p "$D" && cp -R ~/.stage-utility/. "$D"/
npm run build
STAGE_UTILITY_DATA="$D" PORT=8852 STAGE_UTILITY_PORT=8852 npm run server &
# wait for /api/version
curl -s -o /tmp/b.json "http://127.0.0.1:8852/api/views/view-1/export"
curl -s -X POST -H 'content-type: application/json' --data @/tmp/b.json \
  "http://127.0.0.1:8852/api/views/import" | python3 -m json.tool
# The imported view must exist, be renamed, and share no ids with the original.
curl -s "http://127.0.0.1:8852/api/stage" | python3 -c "
import json,sys; d=json.load(sys.stdin)
print([v['id']+' / '+v['name'] for v in d['views']])"
lsof -ti tcp:8852 | xargs -r kill
```

Confirm: the new view is named `... (imported)`, its object ids differ from the
original's, and the original is unchanged.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run type-check && npm test && npm run build
git add main/services/routes/view-routes.ts renderer/lib/api.ts main/services/routes/body-limits.test.ts
git commit -m "feat(views): POST /api/views/import

Returns the report rather than a bare ok, so the UI can show what landed and
what needs rebinding. Body limit raised for this path alongside the config
import, since a bundle carries base64 images, and the new path is asserted in
body-limits.test.ts rather than assumed.

Round-tripped against a real server on a COPY of the config: exported view-1,
imported it back, confirmed the copy is suffixed and shares no object ids with
the original."
```

---

## Phase 3 — The UI

### Task 7: Export from the menu

**Files:**
- Modify: `renderer/settings/sections/outputs-section.tsx`

**Interfaces:**
- Consumes: `GET /api/views/:id/export`.

- [ ] **Step 1: Add the item**

In the view card's dropdown, directly beneath `Duplicate view`:

```tsx
<DropdownMenu.Item
  // A plain anchor, not a fetch-and-blob: the browser's own download handles
  // the filename from Content-Disposition, and a middle-click behaves.
  asChild
  className={MENU_ITEM}
>
  <a href={`/api/views/${encodeURIComponent(view.id)}/export`} download>
    <DownloadIcon className="size-3.5 text-fg-subtle" />
    Export layout
  </a>
</DropdownMenu.Item>
```

Add the same item to the screen card menu (`OutputRow`), using
`output.viewId`, and render it only when `output.viewId` is set — a screen with
no view has no layout to export.

- [ ] **Step 2: Drive it in a browser**

Start a server on a copied data dir, open Screens, use the menu on a view and on
a screen, and confirm a file downloads with the expected name and parses as
JSON. A control that renders is not a control that does anything.

- [ ] **Step 3: Commit**

```bash
npm run lint && npm run type-check && npm test && npm run build
git add renderer/settings/sections/outputs-section.tsx
git commit -m "feat(views): Export layout in the view and screen menus

An anchor rather than a fetch-and-blob, so the browser handles the filename from
Content-Disposition and middle-click behaves. Hidden on a screen with no view,
which has no layout to export.

Driven in a browser from both menus: file downloads, filename correct, parses."
```

---

### Task 8: The import sheet

**Files:**
- Create: `renderer/app/screens/import-layout.tsx`
- Modify: `renderer/app/screens/screens-route.tsx`

**Interfaces:**
- Consumes: channel `views:import`, `ImportReport`.
- Produces: `<ImportLayout />`, rendered beside the existing `New view` button.

The three states are drawn in the mockup: picking a file, reviewing what is in
it, and the report. Follow it for structure and copy.

- [ ] **Step 1: Build the component**

`ImportLayout` holds `file | null`, `parsed: ViewBundle | null`, `report | null`
and `busy`. It:

- accepts a file from a hidden `<input type="file" accept="application/json">`
  and from a drop on its own region;
- parses locally and shows the review — views (marking which are embedded
  dependencies), what comes with it, and what will need rebinding, computed by
  calling the same `collectRefs` shared with the server;
- refuses a file whose `kind` is not `stage-utility-view`, naming what it got;
- on confirm, posts through `views:import` and renders the report.

Reuse the readout of `describeScreen`-style shared helpers where they exist; do
not fork `collectRefs` — import it from `@main/services/view-refs`, which the
renderer already does for other main-side pure modules.

- [ ] **Step 2: Wire it in**

In `screens-route.tsx`, render `<ImportLayout />` beside the existing `New view`
button.

- [ ] **Step 3: Drive it in a browser**

Export a view, then import the file through the UI. Confirm the review lists the
embedded views, the confirm creates them, and the report matches what the API
returned. Then import the **config snapshot** file deliberately and confirm the
refusal names it.

- [ ] **Step 4: Commit**

```bash
npm run lint && npm run type-check && npm test && npm run build
git add renderer/app/screens/import-layout.tsx renderer/app/screens/screens-route.tsx
git commit -m "feat(views): the import sheet

Pick or drop a file, review what is in it before committing, then a report. The
review shares collectRefs with the server rather than forking the walk, so what
it promises and what import does cannot drift.

Driven in a browser end to end, including deliberately importing a config
snapshot to confirm the refusal names the file kind."
```

---

### Task 9: The rebind work list

**Files:**
- Modify: `renderer/app/screens/import-layout.tsx`

- [ ] **Step 1: Render the list**

In the report, group `report.rebind` by `kind` and render each entry by `label`
and `value`, with a link that navigates to the layout editor for that view with
`objectId` selected. Heading text names the count and the kind, e.g.
`4 objects need a wireless channel`.

Inline pickers are explicitly out of scope for this task; the spec names them as
the follow-up.

- [ ] **Step 2: Drive it**

Import a layout containing a `wireless-channel` object into an install with no
wireless connections. Confirm each entry appears by label and that clicking one
opens the editor with that object selected.

- [ ] **Step 3: Commit**

```bash
npm run lint && npm run type-check && npm test && npm run build
git add renderer/app/screens/import-layout.tsx
git commit -m "feat(views): the import report is a rebind work list

Grouped by kind and named individually rather than counted, because the
destination is a different rig and rebinding is the expected path. Each entry
links into the editor with the object selected, so four bindings are four
clicks rather than a hunt.

Inline pickers are the named follow-up; the work list is useful without them."
```

---

## Phase 4 — The bug next door, and docs

### Task 10: duplicateView drops four fields

**Files:**
- Modify: `main/services/stage-controller.ts`
- Test: `main/services/duplicate-view.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("duplicating a console view produces a console view", async () => {
  // It produced a DISPLAY: the copy literal omitted surface, so a control
  // surface silently became read-only.
  const copy = await stageController.duplicateView("view-console");
  const made = copy.views.find((v) => v.id !== "view-console" && v.name.includes("console"));
  assert.equal(made?.surface, "console");
});

test("duplicating carries slotsLayout and scriptViewLayoutId", async () => {
  const copy = await stageController.duplicateView("view-script");
  const made = copy.views.at(-1)!;
  assert.equal(made.scriptViewLayoutId, "svl-1");
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — `surface` is `undefined`.

- [ ] **Step 3: Fix**

Add `surface`, `slotsLayout` and `scriptViewLayoutId` to the copy literal in
`duplicateView`. Do **not** copy `layoutRev` — a fresh view starts at its own
revision, and carrying the source's would make the optimistic-concurrency check
compare against a number that means nothing here.

- [ ] **Step 4: Grep for the pattern**

Run `grep -n "kind: \|createdAt: " main/services/stage-controller.ts` and check
every other place that builds a `View` literal from an existing one. Fix all of
them together and say in the commit how many were found and how many changed.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run type-check && npm test && npm run build
git commit -m "fix(views): duplicate keeps surface, slotsLayout and the ScriptView layout

The copy literal omitted them, so duplicating a console view silently produced a
display — its buttons rendered and did nothing. layoutRev is deliberately NOT
copied: a fresh view starts at its own revision and carrying the source's would
make the concurrency check compare against a meaningless number.

Grepped every View-from-View literal in stage-controller: N found, M changed."
```

---

### Task 11: Documentation

**Files:**
- Create: `docs/views-portability.md`
- Modify: `docs/reference/api.md`

- [ ] **Step 1: Write it**

Concise reference for a stranger, not a narrative. Cover: what the menu item
does, what travels and what does not and why (different hardware, not
credentials), the Smaart naming trick, name collisions, and the fact that a
local target is never overwritten. Document both routes in `api.md`.

- [ ] **Step 2: Commit**

```bash
git add docs/
git commit -m "docs: moving a view between installs"
```

---

## Self-review

**Spec coverage.** Bundle shape → Task 2. Reference graph and transitive embeds →
Task 1. Slot rows for every service type → Task 2. Missing image reported not
fatal → Tasks 2 and 5. Validate kind/version → Task 5. Fresh ids → Task 4.
Cross-reference remap → Task 4. Re-key side data → Task 5. Content-addressed
images → Task 5. Never overwrite a target → Task 5. Name collisions → Task 5.
Report as a named work list → Tasks 5 and 9. Export menu item → Task 7. Import
beside New view → Task 8. `duplicateView` fix → Task 10.

**Known gap accepted:** inline rebind pickers are the spec's named follow-up and
have no task here, deliberately.

**Type consistency.** `collectRefs(all, rootId)` is used with both arguments in
Tasks 1, 5 and 8. `remapBundle(views, newViewId)` returns `viewIdMap` and
`objectIdMap`, both consumed in Task 5. `ImportReport` fields used in Tasks 5, 8
and 9 match the definition in Task 1. `saveLayoutImageBytes` is defined in Task 5
where it is first used.
