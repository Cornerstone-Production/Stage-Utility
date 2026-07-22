# Stage Patch Sheet — v1 Design Spec

- **Date:** 2026-07-22
- **Status:** Draft — awaiting review, then implementation plan
- **Branch:** `feat/patch-sheet`
- **Scope:** v1 = input patch spine + weekly resolution + volunteer view. Other patch domains and integrations are deferred (schema hooks included).

---

## 1. Purpose & context

A living, per-week stage patch reference for the Main Auditorium, accessible at `/patch` like `/history` and `/baptism`. It records the physical input patch (what source lands on which console input, via which stage boxes) as a single source of truth, and surfaces a **simple, read-only diagram to volunteers each week** showing the resolved patch and — most importantly — **what changed** vs. the standard, so they know exactly what to re-patch.

The design is grounded in the church's real patch spreadsheet (7 tabs: Analog Input Patch, Dante, FOH Waves SoundGrid, Monitoring, Preamp Mapping, Future 2-SD-Rack Mapping, Rack Layouts). The **Preamp Mapping** tab (`SD Rack input → source → stage input`) is exactly the rack-centric model this spec adopts.

## 2. Scope

**In scope (v1):**
- Add/remove devices (SD racks, snakes, drop snakes, floor pockets, wireless/RF banks, arrays) with per-device input/output counts and connector labels.
- The **input patch** as one row per SD rack input: source name, mic/DI, 48V, console channel, and a flexible physical **path** (ordered hops back to the stage box). Rack **outputs** use the same record shape (dir = `out`) but are secondary in v1.
- Auto-drawn **connection diagram** derived from the path (no hand-wiring).
- **Variants** — reusable named overlays of overrides on the default (unifies "templates" and "event patches").
- **Weekly resolution** driven by PCO: service-type standing variant → per-plan override → per-week tweaks.
- Read-only **volunteer view** at `/patch` (changes-first, full reference, live).
- **CSV/Excel import** with column mapping.
- **Schema hooks** (data only, features later): `micSlotRef` (mic-board link) and `pcoPosition` (scheduling-suggestion tag).

**Deferred (later phases, same engine):**
- Additional domains: Dante patch, Waves SoundGrid I/O, Monitoring (IEM packs/roles/weekly), rack elevations.
- Displaying the mic-board name on vocal/RF rows (uses the `micSlotRef` hook).
- **PCO-scheduling suggestions** (uses the `pcoPosition` hook) — see §12; deliberately **suggestion-first, never auto-removal**.
- Rich output patching UI beyond the parallel spine.

**Non-goals:**
- Not live console control (no writes to any console/DSP).
- PCO is **read-only** (service type + plan awareness only).
- No auth — LAN tool, matching the rest of the app.

## 3. Routing & surfaces

Mirrors the History split exactly:

- **Settings → "Patch"** (new section) — the full **editor**: device manager, the patch table, variant switcher, import, and weekly assignment.
- **`/patch`** — public **read-only volunteer view**. Added as a slug in `renderer/main/root-view.tsx` (`slug === "patch" → <PatchView>`), served by the existing SPA fallback. Auto-follows the live/next PCO plan.

## 4. Data model

Persisted in a single `DataStore<PatchFile>("patch.json", …)` (same pattern as `baptism-store` / `attendance-store`).

```ts
// ── Devices: anything that carries channels ──────────────────────────────────
type DeviceKind = "rack" | "snake" | "drop-snake" | "pocket" | "wireless" | "array" | "other";

interface PatchDevice {
  id: string;
  name: string;            // "SD Rack 1.11", "Snake A", "SL Drop Snake", "RF Bank", "DPA 5100"
  kind: DeviceKind;
  inputs: number;          // channels carried toward the console
  outputs: number;         // returns/sends back to stage (snakes) or console outs (racks)
  // Optional custom connector labels; default = "1".."N". Supports B-1..B-12, S11, etc.
  inLabels?: string[];
  outLabels?: string[];
}

// ── The spine: one console endpoint on a rack (the "actual input") ────────────
interface Hop { deviceId: string; connector: string; } // connector matches a device label

interface PatchEndpoint {
  rackId: string;          // a device of kind "rack"
  dir: "in" | "out";
  index: number;           // 1-based rack channel
  consoleChannel?: string; // console/session channel label or number
  label?: string;          // source (in) / destination (out) — the name
  mic?: string;            // input metadata: mic / DI model
  phantom?: boolean;       // 48V
  path?: Hop[];            // ordered upstream (in) / downstream (out) hops; [] = direct
  unused?: boolean;        // "pulled this week" / not patched
  notes?: string;

  // ── HOOKS (stored in v1; features shipped later — see §12) ──
  micSlotRef?: string | null;   // link to a mic-board wireless channel; resolves to its current name
  pcoPosition?: string | null;  // PCO team position tag, e.g. "Drums" (for scheduling suggestions)
}

// ── Variants: named overlays (templates == event patches) ────────────────────
interface PatchVariant {
  id: string;
  name: string;            // "Acoustic", "Christmas Eve", "Youth Night"
  // key = `${rackId}:${dir}:${index}`; value = only the changed fields of that endpoint.
  overrides: Record<string, Partial<PatchEndpoint>>;
}

// ── Weekly assignment (PCO-driven) ───────────────────────────────────────────
interface PatchAssignments {
  byServiceType: Record<string, string /* variantId */>;          // standing per service type
  byPlan: Record<string, {                                        // per specific plan/week
    variantId?: string;                                           // override the standing variant
    tweaks?: Record<string, Partial<PatchEndpoint>>;              // one-off week edits
  }>;
}

interface PatchFile {
  devices: PatchDevice[];
  endpoints: PatchEndpoint[];   // the DEFAULT patch
  variants: PatchVariant[];
  assignments: PatchAssignments;
  updatedAt: string;
}
```

Notes:
- **`endpoints` is the default patch** (the source of truth). Variants and week tweaks never mutate it — they layer.
- The endpoint key `${rackId}:${dir}:${index}` is the stable identity used by overrides/tweaks.
- The **device-centric view** (grouping by snake/pocket, mirroring the Analog tab) is derived by grouping endpoints on `path[0].deviceId`; no duplicated data.

## 5. Resolution

For a given PCO plan (the live or next one the app already tracks):

```
resolve(plan):
  layers = [ default endpoints ]
  variantId = assignments.byPlan[plan.id]?.variantId
            ?? assignments.byServiceType[plan.serviceTypeId]
  if variantId: layers += variant(variantId).overrides
  layers += assignments.byPlan[plan.id]?.tweaks ?? {}
  resolved = deep-merge layers by endpoint key
  for each endpoint: mark `changed` if it differs from the default   // drives the volunteer highlight
  return resolved
```

Precedence (low → high): **default → service-type standing variant → per-plan variant → per-plan week tweaks**. Re-wiring infrastructure on the default flows to every variant/week automatically.

## 6. Editor UI — Settings → "Patch"

Matches existing settings patterns (`FieldSet`/`Field`, `Collapsible`, `NumberInput`, `su-card`, semantic tokens, all-Plex type, zero purple).

1. **Device manager** — add/remove devices; set kind, input/output counts (`NumberInput`), and connector labels (default numeric, editable to `B-1`, `S11`, …).
2. **Patch table** (rack-centric, the default view) — rows = rack inputs; columns: `#`, Console ch, Source, Mic, 48V, **From** (path builder that references device connectors), notes. Inline-editable. An **outputs** toggle shows rack outputs (Destination + "To"). A **By device / By rack** segmented control regroups by the first hop's device (mirrors the Analog tab).
3. **Variant switcher** — edit the **Default**, or pick/create a variant. When editing a variant, changed rows are highlighted vs. the default and only diffs are stored.
4. **Weekly** panel — assign a standing variant per service type; override a specific upcoming plan; add week tweaks. Reflects the resolution in §5.
5. **Import** — CSV/Excel with column mapping (§8).

## 7. Volunteer view — `/patch` (read-only)

Per the approved mock (`patch-volunteer-view` artifact) and the "+more" decision:

- **Context strip** — service type + date, active base variant, "Following Planning Center" live indicator.
- **Changes-first card** — "N changes from the standard patch," each showing old → new with a `Re-patch` / `Unused` tag. This is the hero — the "what do I actually do" answer.
- **"How to read"** legend — the resolved chain as connected nodes: `Source → Snake B/1 → SD 1.11 in 12 → Console 12` (the auto-diagram in its simplest form).
- **Full patch** — **expanded by default** (reference-grade; no hide-by-default accordion), grouped by device with **collapsible device headers** (expanded default, choice remembered) and a **filter + "Changes only" toggle** for large rigs. Changed rows get an amber rail; unused rows dim.
- **Live** — updates via SSE without reload.

## 8. CSV/Excel import

- Uses `exceljs` (already a dependency; chosen over SheetJS for the clean-audit repo) for `.xlsx`; plain parse for `.csv`.
- **Column-mapping step**: the operator maps their columns → fields (channel #, source, mic, 48V, path/snake, console ch, target rack). Handles per-device sections (import one snake/pocket at a time) or a full sheet with a device column.
- Import targets the **default patch** (or a chosen variant). Existing rows are matched by rack + index; the operator confirms adds/overwrites before applying.

## 9. Backend & persistence

- `patch-store.ts` → `DataStore<PatchFile>("patch.json", …)` with `load()`/`update()` (atomic writes, existing pattern).
- **HTTP**: `GET /api/patch` returns the resolved current-week patch + the default + change flags for the public view (like `/api/history`). Editor mutations go through IPC handlers (`patch:get`, `patch:save`, `patch:import`, `patch:setAssignment`, `patch:saveVariant`, …).
- **SSE**: broadcast `patch:updated` **on change only** (efficiency-first, per the standing rule), gated on subscribers; `/patch` and the editor live-update. Send current state on subscribe (like the other history channels).
- No secrets. PCO read-only (reuses existing service-type/plan state from `stageController`). Consider whether a mid-edit lock is needed (probably not — patch edits don't interrupt displays like a restart does).

## 10. Design & styling

- All-Plex type (IBM Plex Sans UI, IBM Plex Mono for channel numbers / tabular data — **no serif**), cool-neutral surfaces, themeable blue accent, semantic status colors (green ok, amber caution, red over), **strictly R=G=B neutrals, zero purple**.
- The diagram is SVG, styled like the History charts (same tokens). Numeric fields use `NumberInput` (chevron steppers). Cards use `su-card` / `FieldSet` material.
- Mobile-friendly (volunteers on phones): stacked cards, wide content scrolls within its own container.

## 11. Build order (v1)

- **Phase A — Model + editor core:** `patch.json` store + types; Settings → Patch device manager + rack-centric input table + persistence + SSE.
- **Phase B — Import:** CSV/Excel column-mapping importer.
- **Phase C — Variants + weekly:** variant overlays; service-type/plan/week resolution; weekly panel.
- **Phase D — Volunteer view:** `/patch` route, changes-first layout, auto-diagram, filter/collapse, live.
- Rack **outputs** are supported in the table from Phase A; the diagram and variants apply to them too, but inputs lead.

## 12. Future phases (hooks → features)

- **Mic-board name on vocal/RF rows** (`micSlotRef`): link a wireless/vocal input to its mic-board channel; display the current slot name as a note (e.g. `IN 41 · Vox 1 → "Sarah"`). Mic slots are **per-service-type standing** assignments (`slots.json`: `Record<display, Record<serviceType, Slot[]>>`), so this shows "whatever the mic board says," keeping one source of truth.
- **PCO-scheduling suggestions** (`pcoPosition`): if the plan's teams show no one on a tagged position (e.g. "Drums"), surface a **suggestion** — *"No Drums team scheduled — mark the 6 drum inputs unused? [Apply]"* — that the operator applies or ignores. **Never auto-removes** (PCO team data is routinely incomplete/last-minute, and a wrong removal on a patch sheet is worse than a wrong keep; position→input mapping is fuzzy). Opt-in application *is* the override.
- **Other domains** (Dante, WSG, Monitoring, rack elevations) as additional patch sheets on the same store/engine.

## 13. Assumptions & open questions

- **Assumptions:** editing lives in Settings, `/patch` is read-only (like History); one environment (Main Auditorium) for now; outputs share the endpoint record but inputs lead in v1; `/patch` needs no auth (LAN, matches app).
- **Open:** exact `micSlotRef` identity (wireless `channelId` vs. slot index) — finalized when the display feature is built; whether the volunteer view should also be embeddable as a custom-layout object (later); whether variants need ordering/grouping in the UI for many events.

## 14. Testing

- Unit: resolution precedence (default → service-type → plan → tweaks), change-flagging, import column-mapping parsing.
- Manual/Playwright: editor add/remove device + edit rows + persistence; variant diff storage; `/patch` renders resolved week + changes; SSE live update; CSV round-trip.
- Regression: no secrets in `/api/patch`; SSE broadcasts only on change.
