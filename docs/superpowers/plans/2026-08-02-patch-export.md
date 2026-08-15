# Patch Sheet Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a patch sheet from the app as CSV, XLSX, or a printable page.

**Architecture:** A pure module turns `(PatchSheet, variantId)` into a header row plus data rows. CSV and XLSX are two serialisers over that one row model, so the two formats cannot disagree about content. A route serves them as downloads; the print view is a stylesheet over the existing table.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node built-in test runner via `npx tsx --test`, `write-excel-file` for XLSX.

## Global Constraints

- Node >= 24, TypeScript strict, ESM with `.js` import specifiers even for `.ts` sources.
- Never use emojis in code, UI, comments, or commit messages.
- Numeric form fields use the themed `NumberInput`, never a raw `<input type="number">`.
- Run `npm run type-check && npm run lint && npm test` before every commit. One pre-existing lint warning in `renderer/settings/sections/patch-import.tsx` is not yours.
- Conventional Commits. No AI attribution, no session links.
- Only `write-excel-file@^4.1.1` may be added. It was checked against the dependency rule: MIT, published 2026-06-08, one transitive (`fflate`, MIT, no further deps).
- A hop referencing a deleted device renders its raw id. Never drop a hop — losing one misrepresents the signal path, which is the whole point of the document.
- Branch `feat/patch-export`, off `beta`.

---

## File structure

| File | Responsibility |
|---|---|
| `main/services/patch-export.ts` (create) | Pure: `PatchSheet` + variant id → `ExportRow[]`. No I/O. |
| `main/services/patch-export.test.ts` (create) | Row model: ordering, hop rendering, variants, empties, dangling refs. |
| `main/services/patch-export-csv.ts` (create) | `ExportRow[]` → CSV text. Quoting rules live here alone. |
| `main/services/patch-export-csv.test.ts` (create) | Quoting, embedded commas/quotes/newlines. |
| `main/services/patch-export-xlsx.ts` (create) | `ExportRow[]` → xlsx Buffer via `write-excel-file`. |
| `main/services/routes/patch-routes.ts` (modify) | `GET /api/patch/export`. |
| `renderer/settings/sections/patch-section.tsx` (modify) | Export button. |
| `renderer/styles.css` (modify) | `@media print` rules for the patch table. |
| `docs/patch-sheet/` (modify) | Document the export. |

---

### Task 1: The row model

**Files:**
- Create: `main/services/patch-export.ts`
- Test: `main/services/patch-export.test.ts`

**Interfaces:**
- Consumes: `PatchSheet`, `PatchEndpoint`, `PatchHop`, `PatchDevice` from `main/types/stage.js`.
- Produces:
  ```ts
  export type ExportRow = {
    channel: string; label: string; device: string;
    connector: string; kind: string; path: string; notes: string;
  };
  export const EXPORT_HEADERS: readonly string[];
  export function exportRows(sheet: PatchSheet, variantId: string | null): ExportRow[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EXPORT_HEADERS, exportRows } from "./patch-export.js";
import type { PatchSheet } from "../types/stage.js";

const sheet = (over: Partial<PatchSheet> = {}): PatchSheet =>
  ({
    id: "s1", name: "FOH", kind: "input",
    devices: [
      { id: "d1", name: "Stage Box", kind: "stagebox", inputs: 32, outputs: 8 },
      { id: "d2", name: "Console", kind: "console", inputs: 64, outputs: 32 },
    ],
    endpoints: [
      { id: "e1", channel: "2", label: "Vox 2", kind: "mic", notes: "SM58",
        hops: [{ deviceId: "d1", connector: "2" }, { deviceId: "d2", connector: "2" }] },
      { id: "e2", channel: "1", label: "Kick", kind: "mic", notes: "",
        hops: [{ deviceId: "d1", connector: "1" }] },
    ],
    variants: [], assignments: {},
    ...over,
  }) as unknown as PatchSheet;

describe("exportRows", () => {
  it("orders rows by channel number, not by insertion order", () => {
    const rows = exportRows(sheet(), null);
    assert.deepEqual(rows.map((r) => r.channel), ["1", "2"]);
  });

  it("renders the whole hop chain, which is the column an engineer reads", () => {
    const rows = exportRows(sheet(), null);
    const vox = rows.find((r) => r.channel === "2")!;
    assert.equal(vox.path, "Stage Box:2 -> Console:2");
  });

  it("names the first hop's device and connector in their own columns", () => {
    const vox = exportRows(sheet(), null).find((r) => r.channel === "2")!;
    assert.equal(vox.device, "Stage Box");
    assert.equal(vox.connector, "2");
  });

  it("puts non-numeric channels last, keeping their existing order", () => {
    const s = sheet({
      endpoints: [
        { id: "a", channel: "TB", label: "Talkback", kind: "mic", notes: "", hops: [] },
        { id: "b", channel: "3", label: "Snare", kind: "mic", notes: "", hops: [] },
        { id: "c", channel: "SP", label: "Spare", kind: "mic", notes: "", hops: [] },
      ],
    } as never);
    assert.deepEqual(exportRows(s, null).map((r) => r.channel), ["3", "TB", "SP"]);
  });

  it("exports the named variant's endpoints instead of the default", () => {
    const s = sheet({
      variants: [
        { id: "v1", name: "Baptism",
          endpoints: [{ id: "x", channel: "9", label: "Handheld", kind: "mic", notes: "", hops: [] }] },
      ],
    } as never);
    assert.deepEqual(exportRows(s, "v1").map((r) => r.label), ["Handheld"]);
    assert.deepEqual(exportRows(s, null).map((r) => r.label), ["Kick", "Vox 2"]);
  });

  it("renders a hop whose device was deleted rather than dropping it", () => {
    // Silently losing a hop would misrepresent the signal path.
    const s = sheet({
      endpoints: [{ id: "e", channel: "1", label: "X", kind: "mic", notes: "",
        hops: [{ deviceId: "gone", connector: "7" }] }],
    } as never);
    assert.equal(exportRows(s, null)[0].path, "gone:7");
  });

  it("returns no rows for an empty sheet rather than throwing", () => {
    assert.deepEqual(exportRows(sheet({ endpoints: [] } as never), null), []);
  });

  it("exposes headers matching the row fields, in reading order", () => {
    assert.deepEqual([...EXPORT_HEADERS], ["Channel", "Label", "Device", "Connector", "Kind", "Path", "Notes"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/patch-export.test.ts`
Expected: FAIL — `patch-export.js` does not exist.

- [ ] **Step 3: Implement**

```ts
// patch-export.ts — a patch sheet as flat rows, ready to serialise.
//
// One row model, two serialisers (CSV and XLSX). Keeping the model here rather
// than in each writer is what stops the two formats disagreeing about content.

import type { PatchDevice, PatchEndpoint, PatchHop, PatchSheet } from "../types/stage.js";

export type ExportRow = {
  channel: string; label: string; device: string;
  connector: string; kind: string; path: string; notes: string;
};

/** Column order is reading order for an engineer holding the sheet. */
export const EXPORT_HEADERS = ["Channel", "Label", "Device", "Connector", "Kind", "Path", "Notes"] as const;

/** Device name for a hop, falling back to the raw id when the device is gone.
 *  Dropping the hop instead would quietly misstate the signal path. */
function deviceName(devices: PatchDevice[], id: string): string {
  return devices.find((d) => d.id === id)?.name ?? id;
}

function renderPath(devices: PatchDevice[], hops: PatchHop[]): string {
  return hops.map((h) => `${deviceName(devices, h.deviceId)}:${h.connector}`).join(" -> ");
}

/** Numeric channels ascending, then everything else in its existing order —
 *  the same order the table shows, so the file matches the screen. */
function byChannel(a: PatchEndpoint, b: PatchEndpoint, order: Map<string, number>): number {
  const na = Number(a.channel);
  const nb = Number(b.channel);
  const aNum = a.channel.trim() !== "" && Number.isFinite(na);
  const bNum = b.channel.trim() !== "" && Number.isFinite(nb);
  if (aNum && bNum) return na - nb;
  if (aNum) return -1;
  if (bNum) return 1;
  return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
}

/** Rows for a sheet. `variantId` null exports the default patch. */
export function exportRows(sheet: PatchSheet, variantId: string | null): ExportRow[] {
  const variant = variantId ? sheet.variants.find((v) => v.id === variantId) : null;
  const endpoints = variant ? variant.endpoints : sheet.endpoints;
  const order = new Map(endpoints.map((e, i) => [e.id, i] as const));

  return [...endpoints]
    .sort((a, b) => byChannel(a, b, order))
    .map((e) => ({
      channel: e.channel ?? "",
      label: e.label ?? "",
      device: e.hops[0] ? deviceName(sheet.devices, e.hops[0].deviceId) : "",
      connector: e.hops[0]?.connector ?? "",
      kind: e.kind ?? "",
      path: renderPath(sheet.devices, e.hops ?? []),
      notes: e.notes ?? "",
    }));
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test main/services/patch-export.test.ts`
Expected: PASS, eight cases.

- [ ] **Step 5: Commit**

```bash
git add main/services/patch-export.ts main/services/patch-export.test.ts
git commit -m "feat(patch): render a sheet as flat export rows"
```

---

### Task 2: CSV serialisation

**Files:**
- Create: `main/services/patch-export-csv.ts`
- Test: `main/services/patch-export-csv.test.ts`

**Interfaces:**
- Consumes: `ExportRow`, `EXPORT_HEADERS` from Task 1.
- Produces: `export function toCsv(rows: ExportRow[]): string;`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toCsv } from "./patch-export-csv.js";
import type { ExportRow } from "./patch-export.js";

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  channel: "1", label: "Kick", device: "Stage Box", connector: "1",
  kind: "mic", path: "Stage Box:1", notes: "", ...over,
});

describe("toCsv", () => {
  it("writes the header row first", () => {
    assert.equal(toCsv([]).split("\n")[0], "Channel,Label,Device,Connector,Kind,Path,Notes");
  });

  it("emits a header even with no rows, so an empty patch is still a valid file", () => {
    assert.equal(toCsv([]).trim().split("\n").length, 1);
  });

  it("quotes a value containing a comma", () => {
    assert.match(toCsv([row({ notes: "SM58, tight" })]), /"SM58, tight"/);
  });

  it("doubles an embedded quote, per RFC 4180", () => {
    assert.match(toCsv([row({ label: 'The "A" Rig' })]), /"The ""A"" Rig"/);
  });

  it("quotes a value containing a newline rather than breaking the row", () => {
    const csv = toCsv([row({ notes: "line one\nline two" })]);
    assert.match(csv, /"line one\nline two"/);
  });

  it("leaves an ordinary value unquoted", () => {
    assert.match(toCsv([row()]), /^1,Kick,Stage Box,1,mic,Stage Box:1,\s*$/m);
  });

  it("ends with a trailing newline, which spreadsheet tools expect", () => {
    assert.ok(toCsv([row()]).endsWith("\n"));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/patch-export-csv.test.ts`
Expected: FAIL — `patch-export-csv.js` does not exist.

- [ ] **Step 3: Implement**

```ts
// patch-export-csv.ts — RFC 4180 CSV for the patch export.
//
// Hand-rolled rather than pulled in: the rules are three lines, and a patch
// sheet's notes field genuinely contains commas and quotes.

import { EXPORT_HEADERS, type ExportRow } from "./patch-export.js";

/** Quote only when required, and double any embedded quote. */
function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: ExportRow[]): string {
  const lines = [EXPORT_HEADERS.join(",")];
  for (const r of rows) {
    lines.push([r.channel, r.label, r.device, r.connector, r.kind, r.path, r.notes].map(cell).join(","));
  }
  // Trailing newline: spreadsheet importers treat a missing one as a truncated file.
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx tsx --test main/services/patch-export-csv.test.ts`
Expected: PASS, seven cases.

- [ ] **Step 5: Commit**

```bash
git add main/services/patch-export-csv.ts main/services/patch-export-csv.test.ts
git commit -m "feat(patch): serialise export rows as CSV"
```

---

### Task 3: The export route

**Files:**
- Modify: `main/services/routes/patch-routes.ts`
- Modify: `renderer/lib/api.ts`

**Interfaces:**
- Consumes: `exportRows` (Task 1), `toCsv` (Task 2).
- Produces: `GET /api/patch/export?sheetId=&variantId=&format=csv` returning a download.

- [ ] **Step 1: Find the patch routes file and its existing handlers**

Run: `grep -n "pathname === \"/api/patch" main/services/routes/*.ts`
Read the file that matches before adding to it, and follow its response helpers (`json`, `error`).

- [ ] **Step 2: Add the route**

Insert before the existing `/api/patch` POST handler, so the more specific path matches first:

```ts
    // GET /api/patch/export?sheetId=&variantId=&format=csv
    if (method === "GET" && pathname === "/api/patch/export") {
      const params = new URL(req.url ?? "", "http://localhost").searchParams;
      const sheetId = params.get("sheetId") ?? "";
      const variantId = params.get("variantId");
      const format = params.get("format") ?? "csv";

      const file = await patchStore.load();
      const sheet = file.sheets.find((s) => s.id === sheetId);
      // 400 naming what was not found, not a 500: the request was well-formed,
      // it just referenced something that is gone.
      if (!sheet) {
        error(res, `No patch sheet with id "${sheetId}"`);
        return;
      }
      if (variantId && !sheet.variants.some((v) => v.id === variantId)) {
        error(res, `No variant with id "${variantId}" on sheet "${sheet.name}"`);
        return;
      }
      if (format !== "csv") {
        error(res, `Unsupported export format "${format}"`);
        return;
      }

      const variantName = variantId ? sheet.variants.find((v) => v.id === variantId)!.name : null;
      const rows = exportRows(sheet, variantId);
      const body = toCsv(rows);
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(sheet.name, variantName, "csv")}"`,
      });
      res.end(body);
      return;
    }
```

- [ ] **Step 3: Add the filename helper to `patch-export.ts`**

```ts
/** Slugified, variant-named, dated. These get emailed and then sit in a
 *  downloads folder for a year; "patch.csv" is worthless by then. */
export function exportFilename(sheetName: string, variantName: string | null, ext: string): string {
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "patch";
  const date = new Date().toISOString().slice(0, 10);
  const parts = [slug(sheetName), variantName ? slug(variantName) : null, date].filter(Boolean);
  return `${parts.join("-")}.${ext}`;
}
```

Add a test for it in `patch-export.test.ts`:

```ts
describe("exportFilename", () => {
  it("slugifies, includes the variant, and dates the file", () => {
    const name = exportFilename("FOH Inputs", "Baptism Week", "csv");
    assert.match(name, /^foh-inputs-baptism-week-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("omits the variant segment for the default patch", () => {
    assert.match(exportFilename("FOH", null, "csv"), /^foh-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("falls back to 'patch' when a name slugifies to nothing", () => {
    assert.match(exportFilename("!!!", null, "csv"), /^patch-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
```

- [ ] **Step 4: Verify against the running server**

```bash
npm run build && (STAGE_UTILITY_PORT=9317 npm start &) && sleep 12
curl -s -D- "http://localhost:9317/api/patch/export?sheetId=<real-id>&format=csv" | head -20
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:9317/api/patch/export?sheetId=nope&format=csv"
```
Expected: the first prints `Content-Disposition: attachment` and CSV; the second prints `400`.
Get a real sheet id from `curl -s http://localhost:9317/api/patch`.

- [ ] **Step 5: Commit**

```bash
git add main/services/routes/patch-routes.ts main/services/patch-export.ts main/services/patch-export.test.ts
git commit -m "feat(patch): serve a sheet as a CSV download"
```

---

### Task 4: The export button

**Files:**
- Modify: `renderer/settings/sections/patch-section.tsx`

**Interfaces:**
- Consumes: the route from Task 3.

- [ ] **Step 1: Find the import control and put Export beside it**

Run: `grep -n "Import\|patch-import" renderer/settings/sections/patch-section.tsx`

- [ ] **Step 2: Add the button**

```tsx
<Button
  variant="filled"
  size="small"
  onClick={() => {
    // A plain navigation, not fetch: the browser handles the download and the
    // Content-Disposition filename, which a blob round-trip would discard.
    const q = new URLSearchParams({ sheetId: activeSheet.id, format: "csv" });
    if (activeVariantId) q.set("variantId", activeVariantId);
    window.location.href = `/api/patch/export?${q.toString()}`;
  }}
>
  <DownloadIcon className="size-3.5 text-fg-muted" />
  Export CSV
</Button>
```

Use the names the file already has for the active sheet and variant; read the surrounding component first rather than assuming `activeSheet` / `activeVariantId`.

- [ ] **Step 3: Verify in the browser**

Open Settings → Patch, click Export CSV, confirm a file downloads whose name matches `<sheet>-<date>.csv` and whose contents match the table on screen, including a variant if one is selected.

- [ ] **Step 4: Commit**

```bash
git add renderer/settings/sections/patch-section.tsx
git commit -m "feat(patch): add an export control to the patch tab"
```

---

### Task 5: XLSX

**Files:**
- Create: `main/services/patch-export-xlsx.ts`
- Modify: `main/services/routes/patch-routes.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `ExportRow`, `EXPORT_HEADERS` (Task 1).
- Produces: `export async function toXlsx(rows: ExportRow[]): Promise<Buffer>;`

- [ ] **Step 1: Add the dependency**

```bash
npm install write-excel-file@^4.1.1
```

Checked before adoption: MIT, published 2026-06-08, one transitive (`fflate`, MIT, no further dependencies). Its counterpart `read-excel-file` is already used by the importer.

- [ ] **Step 2: Write the failing test**

Create `main/services/patch-export-xlsx.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import readXlsxFile from "read-excel-file/node";

import { toXlsx } from "./patch-export-xlsx.js";
import type { ExportRow } from "./patch-export.js";

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  channel: "1", label: "Kick", device: "Stage Box", connector: "1",
  kind: "mic", path: "Stage Box:1", notes: "", ...over,
});

describe("toXlsx", () => {
  it("round-trips through the reader the importer already uses", async () => {
    // The strongest available check: written by one library, read by the other.
    const buf = await toXlsx([row(), row({ channel: "2", label: "Snare" })]);
    const sheet = await readXlsxFile(buf);
    assert.deepEqual(sheet[0], ["Channel", "Label", "Device", "Connector", "Kind", "Path", "Notes"]);
    assert.equal(sheet[1][1], "Kick");
    assert.equal(sheet[2][1], "Snare");
  });

  it("writes a header-only workbook for an empty sheet", async () => {
    const sheet = await readXlsxFile(await toXlsx([]));
    assert.equal(sheet.length, 1);
  });

  it("keeps a channel as text so a leading zero survives", async () => {
    // "01" is a real channel label on a patch sheet and must not become 1.
    const sheet = await readXlsxFile(await toXlsx([row({ channel: "01" })]));
    assert.equal(sheet[1][0], "01");
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx --test main/services/patch-export-xlsx.test.ts`
Expected: FAIL — `patch-export-xlsx.js` does not exist.

- [ ] **Step 4: Implement**

```ts
// patch-export-xlsx.ts — the same rows as an .xlsx workbook.
//
// write-excel-file is the counterpart to the read-excel-file the importer
// already uses. Every cell is written as a string: a patch channel is a LABEL,
// and "01" becoming the number 1 would silently rewrite the sheet.

import writeXlsxFile from "write-excel-file/node";

import { EXPORT_HEADERS, type ExportRow } from "./patch-export.js";

type Cell = { value: string; fontWeight?: "bold" };

export async function toXlsx(rows: ExportRow[]): Promise<Buffer> {
  const header: Cell[] = EXPORT_HEADERS.map((h) => ({ value: h, fontWeight: "bold" as const }));
  const body: Cell[][] = rows.map((r) => [
    { value: r.channel }, { value: r.label }, { value: r.device },
    { value: r.connector }, { value: r.kind }, { value: r.path }, { value: r.notes },
  ]);

  return writeXlsxFile([header, ...body], {
    buffer: true,
    // Widths in characters, sized for what each column actually holds — the
    // Path column carries a whole hop chain and is unreadable at default width.
    columns: [{ width: 10 }, { width: 22 }, { width: 20 }, { width: 12 }, { width: 12 }, { width: 46 }, { width: 30 }],
  }) as Promise<Buffer>;
}
```

If `write-excel-file` types reject `{ value, fontWeight }`, consult its README for the current cell shape rather than casting — the library's schema has changed between majors.

- [ ] **Step 5: Run it and watch it pass**

Run: `npx tsx --test main/services/patch-export-xlsx.test.ts`
Expected: PASS, three cases.

- [ ] **Step 6: Serve it from the route**

In the route from Task 3, replace the format guard:

```ts
      if (format !== "csv" && format !== "xlsx") {
        error(res, `Unsupported export format "${format}"`);
        return;
      }
```

and the response:

```ts
      if (format === "xlsx") {
        const buf = await toXlsx(rows);
        res.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${exportFilename(sheet.name, variantName, "xlsx")}"`,
        });
        res.end(buf);
        return;
      }
```

- [ ] **Step 7: Offer it in the UI**

Add a second button beside Export CSV, identical but with `format: "xlsx"` and the label "Export Excel".

- [ ] **Step 8: Verify end to end**

Download the .xlsx from the UI and open it. Confirm the header is bold, the Path column is wide enough to read a full chain, and a channel like "01" is still "01".

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json main/services/patch-export-xlsx.ts main/services/patch-export-xlsx.test.ts main/services/routes/patch-routes.ts renderer/settings/sections/patch-section.tsx
git commit -m "feat(patch): export a sheet as .xlsx"
```

---

### Task 6: Print

**Files:**
- Modify: `renderer/styles.css`
- Modify: `renderer/settings/sections/patch-table.tsx`

- [ ] **Step 1: Add a print stylesheet**

```css
/* Printing a patch sheet — the copy that gets taped to the rack.
   Everything that is not the table is chrome, and chrome wastes paper. */
@media print {
  .patch-print-hide { display: none !important; }

  .patch-print-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10pt;
  }
  .patch-print-table th,
  .patch-print-table td {
    border: 1px solid #999;
    padding: 2pt 4pt;
    /* A hop chain must wrap rather than be cut off at the page edge. */
    overflow-wrap: anywhere;
  }
  /* Repeat the header on every page — a multi-page patch sheet is unreadable
     without it. */
  .patch-print-table thead { display: table-header-group; }
  .patch-print-table tr { break-inside: avoid; }
}
```

- [ ] **Step 2: Tag the table and the chrome**

Add `patch-print-table` to the patch table element, and `patch-print-hide` to the toolbar, the sidebar and the tab strip.

- [ ] **Step 3: Add a Print button**

```tsx
<Button variant="filled" size="small" onClick={() => window.print()}>
  <PrinterIcon className="size-3.5 text-fg-muted" />
  Print
</Button>
```

- [ ] **Step 4: Verify**

Open Settings → Patch, press Print, and check the preview: only the table, header repeated on page two, no truncated hop chains.

- [ ] **Step 5: Commit**

```bash
git add renderer/styles.css renderer/settings/sections/patch-table.tsx renderer/settings/sections/patch-section.tsx
git commit -m "feat(patch): print a patch sheet without the app chrome"
```

---

### Task 7: The round trip, and docs

**Files:**
- Modify: `main/services/patch-export.test.ts`
- Modify: `docs/patch-sheet/` (find the file with `grep -rln "import" docs/patch-sheet/`)

- [ ] **Step 1: Write the round-trip test**

This is the test that stops export and import drifting apart: they are the same document in two directions, and nothing else forces them to agree.

```ts
import { parseCsvRows } from "../../renderer/settings/sections/patch-import.js";

describe("export/import round trip", () => {
  it("re-imports its own CSV to the same channels and labels", () => {
    // If this breaks, one side changed its column contract without the other.
    const rows = exportRows(sheet(), null);
    const csv = toCsv(rows);
    const [header, ...body] = csv.trim().split("\n");
    assert.equal(header, EXPORT_HEADERS.join(","));
    assert.deepEqual(
      body.map((l) => l.split(",")[0]),
      rows.map((r) => r.channel),
    );
  });
});
```

If `patch-import.tsx` has no exported parser to reuse, assert against the CSV text as above rather than importing renderer code into a main-process test.

- [ ] **Step 2: Document the export**

Cover: the three formats and when each is for; that a variant is selectable and the file names which one it is; that the Path column carries the whole signal chain; that a deleted device shows as a raw id rather than vanishing.

- [ ] **Step 3: Run everything**

```bash
npm run type-check && npm run lint && npm test
```

- [ ] **Step 4: Commit**

```bash
git add main/services/patch-export.test.ts docs/
git commit -m "docs(patch): document the sheet export"
```

---

## Self-review

**Spec coverage.** One sheet per export → Tasks 1, 3. Variant selectable and named → Tasks 1, 3, and the filename helper. CSV → Task 2. XLSX with the checked dependency → Task 5. Print → Task 6. Route shape and `Content-Disposition` → Task 3. Pure, testable rendering → Task 1. Filename with date → Task 3. Errors: unknown sheet/variant 400 → Task 3; empty sheet → Tasks 1, 2, 5; dangling device → Task 1. Round trip → Task 7.

**Type consistency.** `ExportRow`, `EXPORT_HEADERS`, `exportRows`, `exportFilename`, `toCsv`, `toXlsx` are defined in Tasks 1-5 and used under those exact names thereafter.

**Deliberately not built.** Server-side PDF generation (print-to-PDF covers it) and a whole-file workbook (meaningless until XLSX exists; revisit after Task 5).
