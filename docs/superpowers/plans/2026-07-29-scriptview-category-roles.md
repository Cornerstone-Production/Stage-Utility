# ScriptView category roles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a ScriptView layout work on any church's Planning Center setup by referencing category *roles* — editable alias sets — instead of exact category names.

**Architecture:** A role is a named, ordered list of PCO category names that mean the same thing. Layout columns store role ids; at render a role resolves against the service type being viewed by joining its non-empty members in order. Roles seed one-per-category from live PCO data, and existing layouts migrate losslessly into single-member roles.

**Tech Stack:** TypeScript, Node ≥24 via `tsx`, React 19, `node:test`. Zero third-party runtime deps in `main/`.

## Global Constraints

- Branch from `beta` **after #145 merges**. This is its own PR — do not fold it into the colour work.
- `scriptview-roles.json` **must** be added to `CONFIG_FILES` in `main/services/config-snapshot.ts` in the same change. `config-snapshot.test.ts` fails until it is; that guard is deliberate.
- No emojis anywhere. Numeric inputs use `NumberInput`; colour inputs use native `<input type="color">`.
- Zero purple in our own chrome. Dark surfaces strictly R=G=B.
- Migration must be **lossless and idempotent** — running it twice changes nothing, and every existing layout renders exactly as before.
- Keyword matching may only ever *suggest*. It must never silently change membership: measured false-positive rate is high (`Stage Manager` matches "band" via "man**ag**er").
- Tests are pure — no network, no DOM, no device I/O.
- Commits end with the Co-Authored-By + Claude-Session trailers. Target `beta`, never `main`.

---

## File Structure

- Create `main/types/scriptview-roles.ts` — `CategoryRole`
- Create `main/services/scriptview-roles-store.ts` — persistence + seeding
- Create `main/services/scriptview-roles-store.test.ts`
- Create `renderer/main/role-resolve.ts` — `resolveRole()`, the join rule
- Create `renderer/main/role-resolve.test.ts`
- Create `main/services/scriptview-layout-migration.ts` — names → role ids
- Create `main/services/scriptview-layout-migration.test.ts`
- Modify `main/types/stage.ts` — `ScriptViewLayout.columnRoles`, deprecate `columns`
- Modify `main/services/scriptview-layouts-store.ts` — run migration on load, drop `DEFAULT_LAYOUTS`
- Modify `main/services/config-snapshot.ts` — add the new store
- Modify `main/services/routes/scriptview-routes.ts` — roles CRUD
- Modify `renderer/lib/api.ts` — roles channels
- Modify `renderer/main/scriptview-columns.tsx` — build columns from roles
- Modify `renderer/settings/sections/scriptview-section.tsx` — the roles panel

---

## Task 1: The role type and its store

**Files:**
- Create: `main/types/scriptview-roles.ts`
- Create: `main/services/scriptview-roles-store.ts`
- Create: `main/services/scriptview-roles-store.test.ts`
- Modify: `main/services/config-snapshot.ts:33-49`

**Interfaces:**
- Produces: `CategoryRole { id: string; name: string; members: string[] }`;
  `scriptViewRolesStore.load(): Promise<CategoryRole[]>`;
  `scriptViewRolesStore.save(roles: CategoryRole[]): Promise<void>`;
  `seedRoles(categories: string[]): CategoryRole[]`.

- [ ] **Step 1: Write the failing test**

Create `main/services/scriptview-roles-store.test.ts`:

```ts
// Seeding runs once against whatever PCO reports. It must be lossless — one role per
// category, nothing merged — because keyword matching guesses badly enough that a
// wrong automatic merge would silently hide a department's notes.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { seedRoles } from "./scriptview-roles-store.js";

describe("seedRoles", () => {
  test("creates one role per category, named after it", () => {
    const roles = seedRoles(["Audio", "Band", "Vocals"]);
    assert.equal(roles.length, 3);
    assert.deepEqual(roles.map((r) => r.name), ["Audio", "Band", "Vocals"]);
    assert.deepEqual(roles.map((r) => r.members), [["Audio"], ["Band"], ["Vocals"]]);
  });

  test("never merges, even for names that obviously pair", () => {
    // Audio and Audio/Visual are the same role in practice, but merging is the
    // operator's call — an automatic merge that is wrong hides notes silently.
    const roles = seedRoles(["Audio", "Audio/Visual"]);
    assert.equal(roles.length, 2);
  });

  test("ids are stable for the same category name", () => {
    assert.equal(seedRoles(["Audio"])[0].id, seedRoles(["Audio"])[0].id);
  });

  test("duplicates and blanks are dropped", () => {
    const roles = seedRoles(["Audio", "Audio", "  ", ""]);
    assert.deepEqual(roles.map((r) => r.name), ["Audio"]);
  });

  test("a service type with no categories seeds nothing rather than failing", () => {
    assert.deepEqual(seedRoles([]), []);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/scriptview-roles-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the type**

Create `main/types/scriptview-roles.ts`:

```ts
/** A named set of PCO note-category names that mean the same thing.
 *
 *  Category names are defined PER SERVICE TYPE and vary — one church was measured with
 *  29 distinct names across 20 service types, including "Audio" and "Audio/Visual" for
 *  the same role, three spellings of "MD + Playback Tech", and case variants of
 *  "EG 1 (Lead)". A layout column references a role, so it resolves correctly whatever
 *  the service type calls it. */
export interface CategoryRole {
  id: string;
  /** Shown as the column header. */
  name: string;
  /** PCO category names, IN PRIORITY ORDER — see resolveRole(). */
  members: string[];
}
```

- [ ] **Step 4: Write the store**

Create `main/services/scriptview-roles-store.ts`:

```ts
import type { CategoryRole } from "../types/scriptview-roles.js";
import { DataStore } from "./data-store.js";

const store = new DataStore<CategoryRole[]>("scriptview-roles.json", []);

/** Stable id from a category name, so re-seeding does not churn ids. */
function idFor(name: string): string {
  return `role-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/**
 * One role per category, named after it, containing only itself.
 *
 * Deliberately does NOT merge look-alike names. Keyword matching guesses badly — in
 * measurement "Stage Manager" matched a band keyword through "man(ag)er", and a "band"
 * rule swallowed nine categories in one service type. A wrong automatic merge hides a
 * department's notes with no visible cause, so merging is always the operator's action.
 */
export function seedRoles(categories: string[]): CategoryRole[] {
  const seen = new Set<string>();
  const out: CategoryRole[] = [];
  for (const raw of categories) {
    const name = raw.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ id: idFor(name), name, members: [name] });
  }
  return out;
}

export const scriptViewRolesStore = {
  async load(): Promise<CategoryRole[]> {
    const raw = await store.load();
    return Array.isArray(raw) ? raw : [];
  },
  async save(roles: CategoryRole[]): Promise<void> {
    await store.save(roles);
  },
};
```

- [ ] **Step 5: Run the tests — expect PASS (5 tests)**

- [ ] **Step 6: Add it to the backup allowlist**

In `main/services/config-snapshot.ts`, add to `CONFIG_FILES`:

```ts
  "scriptview-roles.json",
```

- [ ] **Step 7: Prove the backup guard was doing its job**

Run: `npx tsx --test main/services/config-snapshot.test.ts` — expect PASS.
Then temporarily remove the line you just added and re-run: it must FAIL with
"these stores are neither backed up nor declared runtime". Restore the line.

- [ ] **Step 8: Commit**

```bash
git add main/types/scriptview-roles.ts main/services/scriptview-roles-store.ts \
        main/services/scriptview-roles-store.test.ts main/services/config-snapshot.ts
git commit -m "feat(scriptview): category roles store, seeded one per PCO category"
```

---

## Task 2: Resolving a role on an item

**Files:**
- Create: `renderer/main/role-resolve.ts`
- Create: `renderer/main/role-resolve.test.ts`

**Interfaces:**
- Consumes: `CategoryRole` (Task 1).
- Produces: `resolveRole(role: CategoryRole, notesByCategory: Record<string, string>): string`;
  `roleAppliesTo(role: CategoryRole, categories: string[]): boolean`.

- [ ] **Step 1: Write the failing test**

Create `renderer/main/role-resolve.test.ts`:

```ts
// One rule covers every case the operator specified: join the non-empty members in the
// role's order. One populated shows it; the first blank falls through to the next; more
// than one populated merges, first-listed first.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { resolveRole, roleAppliesTo } from "./role-resolve.js";

const AUDIO = { id: "role-audio", name: "Audio", members: ["Audio", "Audio/Visual"] };

describe("resolveRole", () => {
  test("one member has a note — that note shows", () => {
    assert.equal(resolveRole(AUDIO, { Audio: "Ring out on the 1" }), "Ring out on the 1");
  });

  test("the first member is absent — the next one shows", () => {
    assert.equal(resolveRole(AUDIO, { "Audio/Visual": "Roll VT" }), "Roll VT");
  });

  test("the first member is blank — the next one shows", () => {
    assert.equal(resolveRole(AUDIO, { Audio: "   ", "Audio/Visual": "Roll VT" }), "Roll VT");
  });

  test("both populated — merged, first-listed first", () => {
    const out = resolveRole(AUDIO, { "Audio/Visual": "Roll VT", Audio: "Ring out" });
    assert.equal(out, "Ring out\nRoll VT");
  });

  test("member order is the priority chain, not object order", () => {
    const reversed = { id: "r", name: "A", members: ["Audio/Visual", "Audio"] };
    assert.equal(resolveRole(reversed, { Audio: "second", "Audio/Visual": "first" }), "first\nsecond");
  });

  test("no member present — empty, so the cell renders blank", () => {
    assert.equal(resolveRole(AUDIO, { Lighting: "House to 40%" }), "");
  });

  test("a role with no members is empty rather than throwing", () => {
    assert.equal(resolveRole({ id: "r", name: "Empty", members: [] }, { Audio: "x" }), "");
  });
});

describe("roleAppliesTo", () => {
  test("true when the service type defines any member", () => {
    assert.equal(roleAppliesTo(AUDIO, ["Band", "Audio/Visual"]), true);
  });

  test("false when it defines none — the column is hidden, not empty", () => {
    // The bug this fixes: an Audio column rendered blank on the 13 service types that
    // say Audio/Visual.
    assert.equal(roleAppliesTo(AUDIO, ["Band", "Vocals"]), false);
  });

  test("matching ignores case and padding", () => {
    assert.equal(roleAppliesTo(AUDIO, ["  audio/VISUAL "]), true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test renderer/main/role-resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `renderer/main/role-resolve.ts`:

```ts
import type { CategoryRole } from "../../main/types/scriptview-roles.js";

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The text for a role on one item: the non-empty members joined in the role's order.
 *
 * That single rule covers all three cases — one member populated shows it, a blank or
 * absent first member falls through to the next, and several populated members merge
 * first-listed first.
 */
export function resolveRole(role: CategoryRole, notesByCategory: Record<string, string>): string {
  const parts: string[] = [];
  for (const member of role.members) {
    // Notes are keyed by PCO's exact name; match case-insensitively so a role written
    // "audio/visual" still finds "Audio/Visual".
    const key = Object.keys(notesByCategory).find((k) => norm(k) === norm(member));
    const value = key ? (notesByCategory[key] ?? "").trim() : "";
    if (value) parts.push(value);
  }
  return parts.join("\n");
}

/** Whether this service type defines any of the role's members. A role that matches
 *  none is HIDDEN rather than rendered as an empty column. */
export function roleAppliesTo(role: CategoryRole, categories: string[]): boolean {
  const have = new Set(categories.map(norm));
  return role.members.some((m) => have.has(norm(m)));
}
```

- [ ] **Step 4: Run the tests — expect PASS (10 tests)**

- [ ] **Step 5: Prove they aren't vacuous**

Change `parts.join("\n")` to `parts[0] ?? ""`. Re-run — the two merge tests must fail.
Restore. Then change `roleAppliesTo` to `return true`. Re-run — the hidden-column test
must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add renderer/main/role-resolve.ts renderer/main/role-resolve.test.ts
git commit -m "feat(scriptview): resolve a role by joining its non-empty members in order"
```

---

## Task 3: Migrating existing layouts

**Files:**
- Create: `main/services/scriptview-layout-migration.ts`
- Create: `main/services/scriptview-layout-migration.test.ts`
- Modify: `main/types/stage.ts:932-952`
- Modify: `main/services/scriptview-layouts-store.ts`

**Interfaces:**
- Consumes: `CategoryRole`, `seedRoles` (Task 1).
- Produces: `migrateLayouts(layouts: ScriptViewLayout[], roles: CategoryRole[]): { layouts: ScriptViewLayout[]; roles: CategoryRole[] }`.

- [ ] **Step 1: Write the failing test**

Create `main/services/scriptview-layout-migration.test.ts`:

```ts
// Existing layouts store category NAMES. Migration turns each distinct name into a
// single-member role and rewrites the layouts to reference role ids. It has to be
// lossless — every layout must render exactly as before — and idempotent, because it
// runs on every load rather than behind a version stamp.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { migrateLayouts } from "./scriptview-layout-migration.js";

const legacy = [
  { id: "l1", name: "Audio", order: 0, columns: ["Band", "Vocals"], accentDepartment: "Band" },
  { id: "l2", name: "Full", order: 1, columns: ["Band", "Lighting"] },
] as never[];

describe("migrateLayouts", () => {
  test("each distinct name becomes a single-member role", () => {
    const { roles } = migrateLayouts(legacy, []);
    assert.deepEqual(roles.map((r) => r.name).sort(), ["Band", "Lighting", "Vocals"]);
    for (const r of roles) assert.equal(r.members.length, 1);
  });

  test("column ORDER is preserved — a layout must look identical afterwards", () => {
    const { layouts, roles } = migrateLayouts(legacy, []);
    const nameOf = (id: string) => roles.find((r) => r.id === id)!.name;
    assert.deepEqual(layouts[0].columnRoles!.map(nameOf), ["Band", "Vocals"]);
  });

  test("accentDepartment carries across to a role id", () => {
    const { layouts, roles } = migrateLayouts(legacy, []);
    assert.equal(roles.find((r) => r.id === layouts[0].accentRole)!.name, "Band");
  });

  test("a layout with no accent gets none", () => {
    const { layouts } = migrateLayouts(legacy, []);
    assert.equal(layouts[1].accentRole ?? null, null);
  });

  test("running it twice changes nothing", () => {
    const once = migrateLayouts(legacy, []);
    const twice = migrateLayouts(once.layouts, once.roles);
    assert.deepEqual(twice.layouts, once.layouts);
    assert.deepEqual(twice.roles, once.roles);
  });

  test("existing roles are reused rather than duplicated", () => {
    const existing = [{ id: "role-band", name: "Band", members: ["Band", "Banda"] }];
    const { roles } = migrateLayouts(legacy, existing);
    const band = roles.filter((r) => r.name === "Band");
    assert.equal(band.length, 1);
    // and its member list is left alone — the operator may have edited it
    assert.deepEqual(band[0].members, ["Band", "Banda"]);
  });

  test("a layout with no columns survives", () => {
    const { layouts } = migrateLayouts([{ id: "x", name: "Simple", order: 0, columns: [] }] as never[], []);
    assert.deepEqual(layouts[0].columnRoles, []);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Extend the layout type**

In `main/types/stage.ts`, replace the `columns` field and its comment:

```ts
  /** @deprecated Ordered note-category NAMES. Migrated to `columnRoles` on load and
   *  kept only so an unmigrated file still parses. Category names vary per service
   *  type, which is why columns reference roles now. */
  columns?: string[];
  /** Ordered role ids shown as columns. See CategoryRole. */
  columnRoles?: string[];
```

and replace `accentDepartment`:

```ts
  /** @deprecated Category NAME that tinted the row. Migrated to `accentRole`. */
  accentDepartment?: string | null;
  /** Role whose presence tints the row, used when rowColour === "category". */
  accentRole?: string | null;
```

Also fix the now-wrong comment above the interface (line 930-931), which currently reads
that "a category a type lacks just renders as an empty column" — that is the bug.

- [ ] **Step 4: Implement the migration**

Create `main/services/scriptview-layout-migration.ts`:

```ts
import type { ScriptViewLayout } from "../types/stage.js";
import type { CategoryRole } from "../types/scriptview-roles.js";
import { seedRoles } from "./scriptview-roles-store.js";

/**
 * Rewrite name-based layouts to role ids, creating a single-member role per distinct
 * name. Lossless: every layout renders exactly as before, and the operator then merges
 * roles (dragging "Audio/Visual" into "Audio") to gain cross-service-type portability.
 *
 * Idempotent, because it runs on every load rather than behind a version stamp — a
 * layout that already has `columnRoles` is left untouched.
 */
export function migrateLayouts(
  layouts: ScriptViewLayout[],
  roles: CategoryRole[],
): { layouts: ScriptViewLayout[]; roles: CategoryRole[] } {
  const byName = new Map(roles.map((r) => [r.name.trim().toLowerCase(), r]));
  const nextRoles = [...roles];

  const roleFor = (name: string): string | null => {
    const key = name.trim().toLowerCase();
    if (!key) return null;
    const existing = byName.get(key);
    if (existing) return existing.id;
    const [created] = seedRoles([name]);
    byName.set(key, created);
    nextRoles.push(created);
    return created.id;
  };

  const nextLayouts = layouts.map((l) => {
    if (l.columnRoles) return l; // already migrated
    const columnRoles = (l.columns ?? []).map(roleFor).filter((x): x is string => !!x);
    const accentRole = l.accentDepartment ? roleFor(l.accentDepartment) : null;
    const { columns: _columns, accentDepartment: _accent, ...rest } = l;
    return { ...rest, columnRoles, ...(accentRole ? { accentRole } : {}) };
  });

  return { layouts: nextLayouts, roles: nextRoles };
}
```

- [ ] **Step 5: Run the migration on load**

In `main/services/scriptview-layouts-store.ts`, delete `DEFAULT_LAYOUTS` entirely (a
fresh install now creates nothing until PCO is configured — see Task 5), default the
store to `[]`, and run the migration inside `load()`, persisting when it changed:

```ts
  async load(): Promise<ScriptViewLayout[]> {
    const raw = await store.load();
    const roles = await scriptViewRolesStore.load();
    const out = migrateLayouts(Array.isArray(raw) ? raw : [], roles);
    if (JSON.stringify(out.layouts) !== JSON.stringify(raw)) {
      await store.save(out.layouts);
      await scriptViewRolesStore.save(out.roles);
      console.log("[scriptview-layouts] migrated columns to roles");
    }
    return out.layouts;
  },
```

- [ ] **Step 6: Run the tests — expect PASS (7 tests)**

- [ ] **Step 7: Verify against the real config**

Back up first — this rewrites the operator's file:

```bash
cp ~/.stage-utility/scriptview-layouts.json /tmp/layouts.bak
```

Restart the dev server, then check both files:

```bash
python3 -c "
import json
print('roles:', [ (r['name'], r['members']) for r in json.load(open('$HOME/.stage-utility/scriptview-roles.json')) ])
print('layouts:', [ (l['name'], l.get('columnRoles')) for l in json.load(open('$HOME/.stage-utility/scriptview-layouts.json')) ])"
```

Expected: a role per distinct category the layouts used, and each layout's `columnRoles`
in the same order its `columns` were.

- [ ] **Step 8: Commit**

```bash
git add main/types/stage.ts main/services/scriptview-layout-migration.ts \
        main/services/scriptview-layout-migration.test.ts main/services/scriptview-layouts-store.ts
git commit -m "feat(scriptview): migrate layout columns from category names to roles"
```

---

## Task 4: Render columns from roles

**Files:**
- Modify: `renderer/main/scriptview-columns.tsx:20-32`, `:121-123`
- Modify: `renderer/main/rundown-table.tsx` (accent lookup)
- Modify: `renderer/main/scriptview-plan-view.tsx`, `renderer/settings/sections/scriptview-section.tsx` (pass roles)

**Interfaces:**
- Consumes: `resolveRole`, `roleAppliesTo` (Task 2); `CategoryRole` (Task 1).

- [ ] **Step 1: Build columns from roles**

In `scriptview-columns.tsx`, `resolveScriptViewSpec` takes roles and the service type's
categories, and returns only roles that apply:

```ts
export function resolveScriptViewSpec(
  layout: ScriptViewLayout | null,
  roles: CategoryRole[],
  categories: string[],
): ScriptViewSpec {
  const on = (v: boolean | undefined) => v !== false;
  const byId = new Map(roles.map((r) => [r.id, r]));
  // A role none of whose members exist here is HIDDEN, not rendered empty — that empty
  // column is the bug this replaces.
  const chosen = layout
    ? (layout.columnRoles ?? []).map((id) => byId.get(id)).filter((r): r is CategoryRole => !!r)
    : roles;
  return {
    columns: chosen.filter((r) => roleAppliesTo(r, categories)),
    showClock: layout ? on(layout.showClock) : true,
    showLength: layout ? on(layout.showLength) : true,
    showKey: layout ? on(layout.showKey) : true,
    showBpm: layout ? on(layout.showBpm) : true,
    showArrangement: layout ? on(layout.showArrangement) : true,
    showItemNotes: layout ? on(layout.showItemNotes) : true,
    showTotalTime: layout ? on(layout.showTotalTime) : true,
  };
}
```

Change `ScriptViewSpec.columns` to `CategoryRole[]`, and build each column from the role:

```ts
  for (const role of spec.columns) {
    cols.push({
      key: `role:${role.id}`,
      header: role.name,
      cellClassName: "text-fg-muted whitespace-pre-line",
      render: (it) => resolveRole(role, it.notesByCategory),
    });
  }
```

- [ ] **Step 2: Point the row accent at a role**

In `rundown-table.tsx`, the category branch takes an `accentRole` and its resolved text:

```tsx
    if (source === "category") {
      const role = roles?.find((r) => r.id === accentRole);
      if (!role || !resolveRole(role, it.notesByCategory)) return null;
      return categoryColour(role.name);
    }
```

Replace the `accentDepartment` prop with `accentRole?: string | null` and add
`roles?: CategoryRole[]`, updating both call sites.

- [ ] **Step 3: Verify**

Run: `npm run type-check && npm run lint && npm test && npm run build`.
Then open `/scriptview/weekend/audio` and confirm the columns render with the same
headers and content as before the migration.

- [ ] **Step 4: Commit**

```bash
git add renderer/main/ renderer/settings/sections/scriptview-section.tsx
git commit -m "feat(scriptview): render columns from roles, hiding roles a service type lacks"
```

---

## Task 5: Roles API and seeding

**Files:**
- Modify: `main/services/routes/scriptview-routes.ts`
- Modify: `main/services/stage-controller.ts`
- Modify: `renderer/lib/api.ts`

**Interfaces:**
- Produces: `GET /api/scriptview/roles`, `POST /api/scriptview/roles { roles }`,
  `POST /api/scriptview/roles/seed { serviceTypeId }`; channels
  `scriptview:listRoles`, `scriptview:saveRoles`, `scriptview:seedRoles`.

- [ ] **Step 1: Controller methods**

```ts
  async listScriptViewRoles(): Promise<CategoryRole[]> {
    return scriptViewRolesStore.load();
  }

  async saveScriptViewRoles(roles: CategoryRole[]): Promise<CategoryRole[]> {
    const clean = roles
      .filter((r) => r && typeof r.id === "string" && r.name.trim())
      .map((r) => ({
        id: r.id,
        name: r.name.trim(),
        members: [...new Set((r.members ?? []).map((m) => m.trim()).filter(Boolean))],
      }));
    await scriptViewRolesStore.save(clean);
    this.broadcast();
    return clean;
  }

  /** Add a role for any category this service type defines that no role covers yet.
   *  Never merges and never removes — seeding can only ever ADD. */
  async seedScriptViewRoles(serviceTypeId: string): Promise<CategoryRole[]> {
    const cats = await this.listScriptViewNoteCategories(serviceTypeId);
    const roles = await scriptViewRolesStore.load();
    const covered = new Set(roles.flatMap((r) => r.members.map((m) => m.trim().toLowerCase())));
    const missing = cats.filter((c) => !covered.has(c.trim().toLowerCase()));
    if (missing.length === 0) return roles;
    const next = [...roles, ...seedRoles(missing)];
    await scriptViewRolesStore.save(next);
    this.broadcast();
    return next;
  }
```

- [ ] **Step 2: Routes**

```ts
    if (method === "GET" && pathname === "/api/scriptview/roles") {
      json(res, await stageController.listScriptViewRoles());
      return;
    }

    if (method === "POST" && pathname === "/api/scriptview/roles") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.roles)) {
        error(res, "body.roles (array) required");
        return;
      }
      json(res, await stageController.saveScriptViewRoles(body.roles as CategoryRole[]));
      return;
    }

    if (method === "POST" && pathname === "/api/scriptview/roles/seed") {
      const body = await readBody(req) as Record<string, unknown>;
      const serviceTypeId = typeof body.serviceTypeId === "string" ? body.serviceTypeId : "";
      if (!serviceTypeId) {
        error(res, "body.serviceTypeId (string) required");
        return;
      }
      json(res, await stageController.seedScriptViewRoles(serviceTypeId));
      return;
    }
```

- [ ] **Step 3: Channels** in `renderer/lib/api.ts`:

```ts
    case "scriptview:listRoles":
      return apiFetch<T>("/api/scriptview/roles");
    case "scriptview:saveRoles":
      return post<T>("/api/scriptview/roles", { roles: p.roles });
    // Adds a role for any category this service type defines that no role covers.
    // Only ever adds — never merges, never removes.
    case "scriptview:seedRoles":
      return post<T>("/api/scriptview/roles/seed", { serviceTypeId: p.serviceTypeId });
```

- [ ] **Step 4: Verify against the running server**

```bash
curl -s http://localhost:8788/api/scriptview/roles | head -c 300; echo
curl -s -X POST http://localhost:8788/api/scriptview/roles/seed \
  -H 'Content-Type: application/json' -d '{"serviceTypeId":"41227"}' \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)), 'roles')"
curl -s -X POST http://localhost:8788/api/scriptview/roles \
  -H 'Content-Type: application/json' -d '{"roles":"nope"}' | head -c 80
```

Expected: the roles list, a count after seeding, and `body.roles (array) required`.

- [ ] **Step 5: Commit**

---

## Task 6: The roles panel

**Files:** Modify `renderer/settings/sections/scriptview-section.tsx`

- [ ] **Step 1: Build the panel**

Collapsed, below the layouts (matching the pattern used for the removed accent panel):

- Each role: an `Input` for its name, its members as removable chips in order with
  left/right reorder buttons, and a `Select` labelled **"+ Add category"** listing every
  PCO category not already in this role.
- **Add role** and **Delete role** buttons. Deleting a role also drops it from every
  layout's `columnRoles` in the same save.
- **Unassigned** — every PCO category belonging to no role, each with an "Add as role"
  button. This is how `Communicators` and `Other` get noticed rather than silently lost.
- **In two roles** — any category appearing in more than one role, flagged as a warning,
  since it makes resolution ambiguous.

The add-a-member `Select` **must** use `<SelectValue placeholder="+ Add category" />`.
`Select` renders a native `<select>`, so custom trigger children do not render and the
browser falls back to showing the first option — which reads as a member the role already
has.

- [ ] **Step 2: Verify in the browser**

Merge `Audio/Visual` into the `Audio` role, then check `/scriptview/weekend/audio` and a
service type that uses `Audio/Visual` — the same layout must now populate on both.

- [ ] **Step 3: Commit**

---

## Task 7: Docs

**Files:** Modify `docs/features/scriptview-and-baptisms.md`

- [ ] **Step 1: Document**

Cover: what a role is and why (names vary per service type — cite Audio vs Audio/Visual
and the three MD spellings); the resolution rule; that a role matching nothing is hidden
rather than empty; seeding only ever adds; migration is lossless and idempotent; and that
keyword matching only suggests, with the `Stage Manager` / "man(ag)er" false positive as
the reason.

- [ ] **Step 2: Commit and open the PR against `beta`.**

---

## Self-review notes

**Spec coverage.** Role model → Task 1. Resolution rule → Task 2. Migration → Task 3.
Hidden-not-empty columns → Task 4. Seeding → Tasks 1 and 5. Management panel, unassigned
and duplicate categories → Task 6. `CONFIG_FILES` → Task 1 step 6. Docs → Task 7.

**Deliberate deviation.** The spec says a fresh install "creates nothing until PCO is
configured". Task 3 implements that by deleting `DEFAULT_LAYOUTS` outright rather than
generating starters, and Task 5's seed endpoint is what populates roles once a service
type is chosen. Generating starter *layouts* from roles is left out — with roles in place
the empty state plus Add layout is enough, and inventing layouts risks the same wrong
guesses this whole change exists to remove.

**Not covered by tests.** The roles panel (Task 6) is verified in the browser; the repo
has no React testing harness. All resolution, migration and seeding logic is unit-tested.
