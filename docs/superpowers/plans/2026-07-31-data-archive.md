# Data Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain every raw sample behind the recorded metrics in append-only per-service CSVs, and make that history exportable and re-importable so a rebuilt machine can be given its data back.

**Architecture:** A new raw layer writes append-only CSVs under `<data>/archive/<date>_<serviceKey>/` as a service runs, gated on an open service record. The existing JSON history stores are untouched and stay what the UI reads. A separate export bundles `archive/` plus those stores into a zip; import merges by `serviceKey`, skipping services already present rather than overwriting them.

**Tech Stack:** TypeScript, Node ≥24 via `tsx` (no compile step), `node:test`, `fflate` (zip), React 19 for the settings panel.

## Global Constraints

- **Recording is gated on an open service record** — `serviceKey` is null → every archive call is a no-op. Nothing is written outside a service.
- **Wireless RF/battery is out of scope.** The layout leaves room for `wireless.csv`; do not add it.
- **Archive files are append-only.** Never rewrite or truncate a CSV that already has rows.
- **The archive export is a separate file from the config snapshot** — `stage-archive-*.zip` vs the existing `stage-utility-config-*.json`.
- **Import never overwrites a `serviceKey` that already exists** unless explicitly told to replace that one service.
- **Nothing is written on import until the whole archive is read and validated.**
- **No emojis** anywhere — UI, code, comments, or commit messages. Lucide icons or text.
- **Numeric inputs use the themed `NumberInput`**, never a raw `<input type="number">`.
- **Every new config `DataStore` goes into `CONFIG_FILES`** in the same change. (This feature adds none — but if you add one, that rule applies.)
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
  ```
- Run tests with `npm test`. Run a single file with `node --import tsx --test main/services/archive/csv.test.ts`.
- Branch: `feat/data-archive`, cut from `origin/beta`. Never force-push `beta` or `main`.

---

## File Structure

**New — `main/services/archive/`** (the raw layer, one responsibility per file):

| File | Responsibility |
|---|---|
| `csv.ts` | Pure encode/parse of CSV rows. No I/O. |
| `csv.test.ts` | Tests for the above. |
| `archive-paths.ts` | `<data>/archive` root, and serviceKey → safe directory name. No I/O beyond `mkdir`. |
| `archive-paths.test.ts` | Tests for sanitisation. |
| `csv-appender.ts` | `CsvAppender` — header-once, serialised appends, rolls to a new file when the column set changes. |
| `csv-appender.test.ts` | Tests, against a real tmpdir. |
| `sample-archive.ts` | The façade recorders call. Holds one appender per (service, source). Gated on `serviceKey`. |
| `sample-archive.test.ts` | Tests, incl. the no-serviceKey no-op. |
| `archive-bundle.ts` | Build / inspect / import the zip. Merge rules live here. |
| `archive-bundle.test.ts` | Round trip, dedupe, rejection cases. |

**New elsewhere:**

| File | Responsibility |
|---|---|
| `main/services/routes/archive-routes.ts` | `GET /api/archive/export`, `POST /api/archive/inspect`, `POST /api/archive/import`. |
| `renderer/settings/sections/data-archive-panel.tsx` | The Advanced panel. |

**Modified:**

| File | Change |
|---|---|
| `main/services/spl-recorder.ts:190-247` | Call `sampleArchive.recordSpl(...)` from `recordSample`; record an item-change event. |
| `main/services/attendance-recorder.ts:~155` | Call `sampleArchive.recordAttendance(...)` where the sample is pushed. |
| `main/services/routes/context.ts:53` | Add `readRawBody` beside `readBody` (the existing one is JSON-only). |
| `main/services/remote-server.ts` | Register `archiveRoutes` in the domain-route list. |
| `renderer/settings/sections/advanced-section.tsx:~722` | Add the `Data archive` collapsible beside `Backup & restore`. |
| `package.json` | Add `fflate`. |
| `docs/integrations/` or `docs/` | Document the archive (see Task 8). |

**Deliberately not modified:** `config-snapshot.ts`. `CONFIG_FILES` and `RUNTIME_FILES` stay exactly as they are — the archive is a second, separate bundle that happens to read the same `RUNTIME_FILES` names.

### Scope note on the event log

The spec lists item changes, OBS/REAPER state, OSC feedback and automation fires for `events.csv`. **v1 wires PCO item changes and automation fires only.** OBS and REAPER have no single change-detection chokepoint today (their state flows through the stage-state object, not a dedicated broadcast), so wiring them means adding one — a separate change with its own review. `recordEvent(source, kind, detail)` is generic, so adding them later is a one-line call at each site. Update the spec's Out of scope list to say so (Task 8).

---

## Task 1: CSV codec

**Files:**
- Create: `main/services/archive/csv.ts`
- Test: `main/services/archive/csv.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `encodeRow(values: (string | number | null | undefined)[]): string` — returns the line **including** its trailing `\n`. `parseRows(text: string): string[][]` — parses complete lines only, discarding any trailing bytes after the last `\n`.

The truncation tolerance is the whole point: a file cut off by a power loss mid-write ends without a newline, and that partial line must be dropped rather than parsed into a short row.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/archive/csv.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { encodeRow, parseRows } from "./csv.js";

test("encodeRow terminates the line", () => {
  assert.equal(encodeRow(["a", "b"]), "a,b\n");
});

test("encodeRow renders null and undefined as empty", () => {
  assert.equal(encodeRow(["a", null, undefined, 3]), "a,,,3\n");
});

test("encodeRow quotes commas, quotes and newlines", () => {
  assert.equal(encodeRow(['a,b']), '"a,b"\n');
  assert.equal(encodeRow(['say "hi"']), '"say ""hi"""\n');
  assert.equal(encodeRow(["two\nlines"]), '"two\nlines"\n');
});

test("encodeRow leaves plain values unquoted", () => {
  assert.equal(encodeRow(["plain", 12.5]), "plain,12.5\n");
});

test("parseRows round-trips encodeRow", () => {
  const text = encodeRow(["a", "b,c"]) + encodeRow(['q"d', 1]);
  assert.deepEqual(parseRows(text), [["a", "b,c"], ['q"d', "1"]]);
});

test("parseRows drops a truncated final line", () => {
  const text = encodeRow(["a", "b"]) + "c,d-but-the-power-w";
  assert.deepEqual(parseRows(text), [["a", "b"]]);
});

test("parseRows returns nothing for an empty or headerless-partial file", () => {
  assert.deepEqual(parseRows(""), []);
  assert.deepEqual(parseRows("no newline yet"), []);
});

test("parseRows keeps embedded newlines inside quotes", () => {
  assert.deepEqual(parseRows(encodeRow(["two\nlines", "x"])), [["two\nlines", "x"]]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test main/services/archive/csv.test.ts`
Expected: FAIL — `Cannot find module './csv.js'`.

- [ ] **Step 3: Implement**

```ts
// csv.ts — CSV rows, encoded and parsed, with no I/O.
//
// The archive is append-only and a row is only ever whole or absent: every line
// `encodeRow` produces ends in a newline, and `parseRows` discards anything after
// the last one. A file truncated mid-write by a power cut therefore reads back as
// every complete row it had, rather than throwing or yielding a short final row.

/** RFC 4180 quoting: only when the value contains a comma, quote or newline. */
function encodeCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** One CSV line, terminated. The terminator is what makes a row complete. */
export function encodeRow(values: (string | number | null | undefined)[]): string {
  return values.map(encodeCell).join(",") + "\n";
}

/**
 * Parse complete rows. Bytes after the final newline are a partial write and are
 * dropped — see the file header.
 */
export function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let complete = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      complete = true;
    } else if (c !== "\r") {
      cell += c;
      complete = false;
    } else {
      complete = false;
    }
    if (c !== "\n") complete = false;
  }
  // Anything still buffered came after the last newline: an incomplete write.
  return complete || (row.length === 0 && cell === "") ? rows : rows;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test main/services/archive/csv.test.ts`
Expected: PASS, 8/8.

- [ ] **Step 5: Prove the truncation test is not vacuous**

Mutate `parseRows` so it flushes the trailing buffer — add `if (cell !== "" || row.length) { row.push(cell); rows.push(row); }` immediately before the `return`. Re-run.
Expected: `parseRows drops a truncated final line` FAILS. Revert the mutation and confirm green again.

- [ ] **Step 6: Commit**

```bash
git add main/services/archive/csv.ts main/services/archive/csv.test.ts
git commit -m "$(cat <<'EOF'
feat(archive): CSV rows that survive a truncated write

Every encoded row ends in a newline and the parser discards anything after
the last one, so a file cut off mid-write reads back as the complete rows it
had rather than throwing or yielding a short final row.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
EOF
)"
```

---

## Task 2: Archive paths

**Files:**
- Create: `main/services/archive/archive-paths.ts`
- Test: `main/services/archive/archive-paths.test.ts`

**Interfaces:**
- Consumes: `getUserDataPath()` from `../app-paths.js`.
- Produces: `archiveRoot(): string`, `serviceDirName(serviceKey: string, serviceDate: string): string`, `serviceDirPath(serviceKey: string, serviceDate: string): string`.

`serviceKey` is `${serviceTypeId}:${planId}:${serviceTimeId ?? YYYY-MM-DD}` — colons are illegal in Windows filenames and `..` would escape the archive root, so the name is sanitised to `[A-Za-z0-9._-]` with everything else collapsed to `-`.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/archive/archive-paths.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { serviceDirName } from "./archive-paths.js";

test("names a directory by date then sanitised key", () => {
  assert.equal(serviceDirName("st1:p123:t9", "2026-07-26"), "2026-07-26_st1-p123-t9");
});

test("collapses every character that is not [A-Za-z0-9._-]", () => {
  assert.equal(serviceDirName("a/b\\c:d e", "2026-07-26"), "2026-07-26_a-b-c-d-e");
});

test("cannot escape the archive root", () => {
  const name = serviceDirName("../../etc/passwd", "2026-07-26");
  assert.ok(!name.includes("/"), name);
  assert.ok(!name.includes(".."), name);
});

test("a bad date cannot escape either", () => {
  const name = serviceDirName("k", "../..");
  assert.ok(!name.includes("/") && !name.includes(".."), name);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test main/services/archive/archive-paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// archive-paths.ts — where the raw layer lives on disk.
//
// One directory per service occurrence, not per day: two services sharing a plan
// on one Sunday have different serviceKeys and must not share a file. The key
// contains colons (`st:plan:time`), which are illegal in Windows filenames and
// would let a crafted key escape the root, so it is sanitised down to a safe set.

import * as path from "path";

import { getUserDataPath } from "../app-paths.js";

/** Reduce to a filename-safe token. Collapses runs and trims separators so `..`
 *  cannot survive and the result is never empty. */
function safe(part: string): string {
  const s = part.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.+/g, ".").replace(/^[-.]+|[-.]+$/g, "");
  return s || "unknown";
}

export function archiveRoot(): string {
  return path.join(getUserDataPath(), "archive");
}

/** `2026-07-26_st1-p123-t9` — sortable by date, unique by occurrence. */
export function serviceDirName(serviceKey: string, serviceDate: string): string {
  return `${safe(serviceDate)}_${safe(serviceKey)}`;
}

export function serviceDirPath(serviceKey: string, serviceDate: string): string {
  return path.join(archiveRoot(), serviceDirName(serviceKey, serviceDate));
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test main/services/archive/archive-paths.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add main/services/archive/archive-paths.ts main/services/archive/archive-paths.test.ts
git commit -m "$(cat <<'EOF'
feat(archive): one directory per service occurrence

serviceKey contains colons, which are illegal in Windows filenames and would
let a crafted key escape the archive root, so the directory name is sanitised
to [A-Za-z0-9._-] and can never contain a separator or a parent reference.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
EOF
)"
```

---

## Task 3: The appender

**Files:**
- Create: `main/services/archive/csv-appender.ts`
- Test: `main/services/archive/csv-appender.test.ts`

**Interfaces:**
- Consumes: `encodeRow` from `./csv.js`.
- Produces: `class CsvAppender { constructor(dir: string, base: string); append(headers: string[], row: (string | number | null)[]): Promise<void>; files(): string[] }` — `files()` returns the basenames written, in order, for the manifest.

Two behaviours matter and both are tested:

1. **Appends are serialised.** At 1 Hz a second write can start before the first resolves; `fs.appendFile` gives no interleaving guarantee for that, and a spliced line would corrupt the row. Every call chains onto the previous.
2. **A changed column set rolls to a new file.** A meter that starts reporting a new metric mid-service must not produce a ragged file. `spl.csv` → `spl.2.csv`, both listed in the manifest.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/archive/csv-appender.test.ts
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { CsvAppender } from "./csv-appender.js";
import { parseRows } from "./csv.js";

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "archive-test-"));
}

test("writes the header once, then rows", async () => {
  const dir = await tmp();
  const a = new CsvAppender(dir, "spl");
  await a.append(["at", "db"], ["t1", 90]);
  await a.append(["at", "db"], ["t2", 91]);
  const text = await fs.readFile(path.join(dir, "spl.csv"), "utf8");
  assert.deepEqual(parseRows(text), [["at", "db"], ["t1", "90"], ["t2", "91"]]);
});

test("serialises concurrent appends without splicing rows", async () => {
  const dir = await tmp();
  const a = new CsvAppender(dir, "spl");
  const headers = ["n"];
  await Promise.all(Array.from({ length: 200 }, (_, i) => a.append(headers, [i])));
  const rows = parseRows(await fs.readFile(path.join(dir, "spl.csv"), "utf8"));
  assert.equal(rows.length, 201, "header + 200 rows");
  const got = rows.slice(1).map((r) => Number(r[0])).sort((x, y) => x - y);
  assert.deepEqual(got, Array.from({ length: 200 }, (_, i) => i));
});

test("a changed column set rolls to a new file rather than a ragged one", async () => {
  const dir = await tmp();
  const a = new CsvAppender(dir, "spl");
  await a.append(["at", "db"], ["t1", 90]);
  await a.append(["at", "db", "lceq"], ["t2", 91, 95]);
  await a.append(["at", "db", "lceq"], ["t3", 92, 96]);

  assert.deepEqual(parseRows(await fs.readFile(path.join(dir, "spl.csv"), "utf8")), [
    ["at", "db"],
    ["t1", "90"],
  ]);
  assert.deepEqual(parseRows(await fs.readFile(path.join(dir, "spl.2.csv"), "utf8")), [
    ["at", "db", "lceq"],
    ["t2", "91", "95"],
    ["t3", "92", "96"],
  ]);
  assert.deepEqual(a.files(), ["spl.csv", "spl.2.csv"]);
});

test("resumes an existing file without repeating the header", async () => {
  const dir = await tmp();
  await new CsvAppender(dir, "spl").append(["at", "db"], ["t1", 90]);
  await new CsvAppender(dir, "spl").append(["at", "db"], ["t2", 91]);
  const rows = parseRows(await fs.readFile(path.join(dir, "spl.csv"), "utf8"));
  assert.deepEqual(rows, [["at", "db"], ["t1", "90"], ["t2", "91"]]);
});

test("resuming with a different column set rolls rather than appending ragged rows", async () => {
  const dir = await tmp();
  await new CsvAppender(dir, "spl").append(["at", "db"], ["t1", 90]);
  await new CsvAppender(dir, "spl").append(["at", "db", "lceq"], ["t2", 91, 95]);
  assert.deepEqual(parseRows(await fs.readFile(path.join(dir, "spl.2.csv"), "utf8")), [
    ["at", "db", "lceq"],
    ["t2", "91", "95"],
  ]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test main/services/archive/csv-appender.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// csv-appender.ts — append-only writer for one source within one service.
//
// Two things this has to get right:
//
//   Serialisation. Samples arrive at 1 Hz and a second append can begin before
//   the first resolves. fs.appendFile makes no interleaving promise at that
//   granularity, and a spliced line is a corrupt row, so every write chains onto
//   the one before it.
//
//   Ragged files. A meter that starts reporting a new metric mid-service changes
//   the column set. Widening the file in place would leave earlier rows short and
//   silently misaligned against the header, so a changed set opens `spl.2.csv`
//   instead and both files go in the manifest.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { encodeRow, parseRows } from "./csv.js";

export class CsvAppender {
  private chain: Promise<void> = Promise.resolve();
  private written: string[] = [];
  private activeHeaders: string[] | null = null;
  private activeFile: string | null = null;
  private index = 1;

  constructor(private readonly dir: string, private readonly base: string) {}

  /** Basenames written by this appender, in order — for the manifest. */
  files(): string[] {
    return [...this.written];
  }

  append(headers: string[], row: (string | number | null)[]): Promise<void> {
    this.chain = this.chain.then(() => this.write(headers, row)).catch((err) => {
      // A failed archive write must never take the recorder down with it — the
      // derived record is still being kept, and a gap in the raw layer is
      // recoverable where a crashed live service is not.
      console.error(`[archive] ${this.base}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.chain;
  }

  private async write(headers: string[], row: (string | number | null)[]): Promise<void> {
    if (!this.activeHeaders || !sameColumns(this.activeHeaders, headers)) {
      await this.open(headers);
    }
    await fs.appendFile(path.join(this.dir, this.activeFile!), encodeRow(row), "utf8");
  }

  /** Point at the file these headers belong in, writing the header row if new. */
  private async open(headers: string[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    // First open of the process: an earlier run may already have this file. Reuse
    // it when its header still matches, so a restart mid-service keeps one file.
    if (this.activeHeaders == null) {
      const name = `${this.base}.csv`;
      const existing = await readHeader(path.join(this.dir, name));
      if (existing == null) {
        await fs.appendFile(path.join(this.dir, name), encodeRow(headers), "utf8");
        this.activeHeaders = headers;
        this.activeFile = name;
        this.written.push(name);
        return;
      }
      if (sameColumns(existing, headers)) {
        this.activeHeaders = headers;
        this.activeFile = name;
        this.written.push(name);
        return;
      }
      // Header on disk disagrees — fall through and roll.
      this.activeHeaders = existing;
      this.activeFile = name;
      this.written.push(name);
    }
    // Roll to the next index that is free.
    do {
      this.index += 1;
      this.activeFile = `${this.base}.${this.index}.csv`;
    } while (await exists(path.join(this.dir, this.activeFile)) && !(await headerMatches(path.join(this.dir, this.activeFile), headers)));

    if (!(await exists(path.join(this.dir, this.activeFile)))) {
      await fs.appendFile(path.join(this.dir, this.activeFile), encodeRow(headers), "utf8");
    }
    this.activeHeaders = headers;
    this.written.push(this.activeFile);
  }
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** The header row of an existing file, or null if it does not exist / has none. */
async function readHeader(file: string): Promise<string[] | null> {
  try {
    const rows = parseRows(await fs.readFile(file, "utf8"));
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function headerMatches(file: string, headers: string[]): Promise<boolean> {
  const h = await readHeader(file);
  return h != null && sameColumns(h, headers);
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test main/services/archive/csv-appender.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Prove the serialisation test is not vacuous**

Change `append` to `void this.write(headers, row); return Promise.resolve();` (dropping the chain). Re-run.
Expected: `serialises concurrent appends` FAILS — the header is written more than once, or rows are lost. Revert and confirm green.

- [ ] **Step 6: Commit**

```bash
git add main/services/archive/csv-appender.ts main/services/archive/csv-appender.test.ts
git commit -m "$(cat <<'EOF'
feat(archive): serialised append-only writer with header rolling

Samples arrive at 1 Hz and a second append can start before the first
resolves; appendFile gives no interleaving guarantee at that granularity, so
writes chain. A changed column set opens spl.2.csv rather than widening the
file in place, which would leave earlier rows misaligned against the header.

A failed archive write logs rather than throwing — a gap in the raw layer is
recoverable where a crashed live service is not.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
EOF
)"
```

---

## Task 4: The sample archive façade, wired to SPL

**Files:**
- Create: `main/services/archive/sample-archive.ts`
- Test: `main/services/archive/sample-archive.test.ts`
- Modify: `main/services/spl-recorder.ts:190-247` (`recordSample`) and `:96-101` (item change)

**Interfaces:**
- Consumes: `CsvAppender` (Task 3), `serviceDirPath` (Task 2).
- Produces:
  ```ts
  export interface ServiceCtx { serviceKey: string; serviceDate: string }
  export interface SampleArchive {
    recordSpl(ctx: ServiceCtx, itemId: string, itemTitle: string, metrics: Record<string, number>): void;
    recordAttendance(ctx: ServiceCtx, fields: Record<string, number | null>): void;
    recordEvent(ctx: ServiceCtx, source: string, kind: string, detail: string): void;
    writeManifest(ctx: ServiceCtx): Promise<void>;
    closeService(serviceKey: string): void;
  }
  export const sampleArchive: SampleArchive;
  ```

Every method returns `void` and never throws: the recorders run on the live tick and must not block on disk or die on an ENOSPC. `closeService` drops the in-memory appenders when a record finalises.

`recordSpl` writes **one wide row per tick** — `at,itemId,item,<metric>,<metric>,…` — because a row per metric per tick is four times the bytes for the same information and does not pivot directly.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/archive/sample-archive.test.ts
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-svc-"));
process.env.STAGE_UTILITY_DATA = dataDir;

const { sampleArchive } = await import("./sample-archive.js");
const { parseRows } = await import("./csv.js");

const CTX = { serviceKey: "st1:p1:t9", serviceDate: "2026-07-26" };
const dirFor = (c = CTX) => path.join(dataDir, "archive", `${c.serviceDate}_${c.serviceKey.replace(/:/g, "-")}`);

test("writes one wide SPL row per tick", async () => {
  sampleArchive.recordSpl(CTX, "i1", "Welcome", { "SPL A Slow": 88.2, "LAeq 10": 85.1 });
  await sampleArchive.recordSpl(CTX, "i1", "Welcome", { "SPL A Slow": 89.0, "LAeq 10": 85.4 }) as unknown as Promise<void>;
  await sampleArchive.flush();

  const rows = parseRows(await fs.readFile(path.join(dirFor(), "spl.csv"), "utf8"));
  assert.deepEqual(rows[0], ["at", "itemId", "item", "LAeq 10", "SPL A Slow"]);
  assert.equal(rows.length, 3, "header + 2 ticks");
  assert.equal(rows[1][1], "i1");
  assert.equal(rows[1][2], "Welcome");
  assert.equal(rows[1][4], "88.2");
  assert.equal(rows[2][4], "89");
});

test("metric columns are stable regardless of key order", async () => {
  sampleArchive.recordSpl(CTX, "i2", "Song", { "LAeq 10": 90, "SPL A Slow": 95 });
  await sampleArchive.flush();
  const rows = parseRows(await fs.readFile(path.join(dirFor(), "spl.csv"), "utf8"));
  assert.equal(rows[0].length, 5, "no new file was rolled");
  assert.equal(rows.at(-1)![3], "90");
  assert.equal(rows.at(-1)![4], "95");
});

test("events land in their own file", async () => {
  sampleArchive.recordEvent(CTX, "pco", "item", "Welcome");
  await sampleArchive.flush();
  const rows = parseRows(await fs.readFile(path.join(dirFor(), "events.csv"), "utf8"));
  assert.deepEqual(rows[0], ["at", "source", "kind", "detail"]);
  assert.deepEqual(rows[1].slice(1), ["pco", "item", "Welcome"]);
});

test("attendance lands in its own file", async () => {
  sampleArchive.recordAttendance(CTX, { inside: 1100, entries: 1240, exits: 140 });
  await sampleArchive.flush();
  const rows = parseRows(await fs.readFile(path.join(dirFor(), "attendance.csv"), "utf8"));
  assert.deepEqual(rows[0], ["at", "entries", "exits", "inside"]);
  assert.deepEqual(rows[1].slice(1), ["1240", "140", "1100"]);
});

test("writes a manifest naming every file", async () => {
  await sampleArchive.writeManifest(CTX);
  const m = JSON.parse(await fs.readFile(path.join(dirFor(), "manifest.json"), "utf8"));
  assert.equal(m.serviceKey, CTX.serviceKey);
  assert.equal(m.serviceDate, CTX.serviceDate);
  assert.equal(m.version, 1);
  assert.ok(m.files.includes("spl.csv"), JSON.stringify(m.files));
  assert.ok(m.files.includes("events.csv"));
  assert.ok(m.files.includes("attendance.csv"));
});

test("an empty serviceKey writes nothing at all", async () => {
  const before = await fs.readdir(path.join(dataDir, "archive"));
  sampleArchive.recordSpl({ serviceKey: "", serviceDate: "2026-07-26" }, "i1", "x", { a: 1 });
  sampleArchive.recordEvent({ serviceKey: "", serviceDate: "2026-07-26" }, "pco", "item", "x");
  await sampleArchive.flush();
  assert.deepEqual(await fs.readdir(path.join(dataDir, "archive")), before);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test main/services/archive/sample-archive.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// sample-archive.ts — the raw layer's front door.
//
// The recorders call this on the live tick, so nothing here blocks or throws:
// every method returns void, writes are queued on the appender's chain, and a
// failure is logged. Losing a sample is survivable; taking the live service down
// to record one is not.
//
// Gated on serviceKey. No open service record means no key, and no key means every
// call is a no-op — which is what keeps a Tuesday afternoon out of the archive.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { serviceDirPath } from "./archive-paths.js";
import { CsvAppender } from "./csv-appender.js";

export interface ServiceCtx {
  serviceKey: string;
  serviceDate: string;
}

const MANIFEST_VERSION = 1;

interface ServiceEntry {
  ctx: ServiceCtx;
  dir: string;
  appenders: Map<string, CsvAppender>;
}

class SampleArchiveImpl {
  private services = new Map<string, ServiceEntry>();

  private entry(ctx: ServiceCtx): ServiceEntry | null {
    if (!ctx.serviceKey) return null; // no open service record — record nothing
    let e = this.services.get(ctx.serviceKey);
    if (!e) {
      e = { ctx, dir: serviceDirPath(ctx.serviceKey, ctx.serviceDate), appenders: new Map() };
      this.services.set(ctx.serviceKey, e);
    }
    return e;
  }

  private appender(e: ServiceEntry, base: string): CsvAppender {
    let a = e.appenders.get(base);
    if (!a) {
      a = new CsvAppender(e.dir, base);
      e.appenders.set(base, a);
    }
    return a;
  }

  /** One wide row per tick: all metrics on one line, sorted so the column set is
   *  stable when the meter reports the same keys in a different order. */
  recordSpl(ctx: ServiceCtx, itemId: string, itemTitle: string, metrics: Record<string, number>): void {
    const e = this.entry(ctx);
    if (!e) return;
    const keys = Object.keys(metrics).sort();
    void this.appender(e, "spl").append(
      ["at", "itemId", "item", ...keys],
      [new Date().toISOString(), itemId, itemTitle, ...keys.map((k) => metrics[k])],
    );
  }

  recordAttendance(ctx: ServiceCtx, fields: Record<string, number | null>): void {
    const e = this.entry(ctx);
    if (!e) return;
    const keys = Object.keys(fields).sort();
    void this.appender(e, "attendance").append(
      ["at", ...keys],
      [new Date().toISOString(), ...keys.map((k) => fields[k])],
    );
  }

  recordEvent(ctx: ServiceCtx, source: string, kind: string, detail: string): void {
    const e = this.entry(ctx);
    if (!e) return;
    void this.appender(e, "events").append(
      ["at", "source", "kind", "detail"],
      [new Date().toISOString(), source, kind, detail],
    );
  }

  /** Settle every queued write. Tests await this; production does not need to. */
  async flush(): Promise<void> {
    for (const e of this.services.values()) {
      for (const a of e.appenders.values()) await a.append.call(a, [], []).catch(() => {});
    }
  }

  async writeManifest(ctx: ServiceCtx): Promise<void> {
    const e = this.entry(ctx);
    if (!e) return;
    const files = [...new Set([...e.appenders.values()].flatMap((a) => a.files()))].sort();
    await fs.mkdir(e.dir, { recursive: true });
    await fs.writeFile(
      path.join(e.dir, "manifest.json"),
      JSON.stringify({ version: MANIFEST_VERSION, serviceKey: ctx.serviceKey, serviceDate: ctx.serviceDate, files }, null, 2),
      "utf8",
    );
  }

  /** Drop the in-memory appenders for a finalised record. */
  closeService(serviceKey: string): void {
    this.services.delete(serviceKey);
  }
}

export const sampleArchive = new SampleArchiveImpl();
```

**Note on `flush`:** the version above appends an empty row, which is wrong. Replace the `flush` body with a chain-settle that does not write:

```ts
  async flush(): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const e of this.services.values()) for (const a of e.appenders.values()) waits.push(a.settled());
    await Promise.all(waits);
  }
```

and add to `CsvAppender` (Task 3's file):

```ts
  /** Resolves when every queued append has landed. */
  settled(): Promise<void> {
    return this.chain;
  }
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test main/services/archive/sample-archive.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Wire it into the SPL recorder**

In `main/services/spl-recorder.ts`, add the import:

```ts
import { sampleArchive } from "./archive/sample-archive.js";
```

In `recordSample`, immediately after the `if (sample) {` block's metric fold (after the `for (const [key, v] of Object.entries(sample.metrics))` loop closes, before the legacy single-metric block), add:

```ts
      // Keep the raw readings too. The fold above is lossy by design — max/leq/count
      // cannot be un-averaged — which is why a corrected Leq could not be applied to
      // anything already recorded. See docs/data-archive.md.
      if (this.currentKey) {
        sampleArchive.recordSpl(
          { serviceKey: this.currentKey, serviceDate: this.current.serviceDate },
          itemId,
          item.title,
          sample.metrics,
        );
      }
```

In `onLiveTick`, inside the `if (live.currentItemId !== this.lastItemId)` block, after `itemChanged = true;`, add:

```ts
          if (this.currentKey && this.current) {
            sampleArchive.recordEvent(
              { serviceKey: this.currentKey, serviceDate: this.current.serviceDate },
              "pco",
              "item",
              live.label ?? live.currentItemId,
            );
          }
```

In `finalizeRecord`, after `this.current.endedAt = now;`, add:

```ts
    // The record is closed: write the manifest and release the appenders.
    const ctx = { serviceKey: this.current.serviceKey, serviceDate: this.current.serviceDate };
    void sampleArchive.writeManifest(ctx).then(() => sampleArchive.closeService(ctx.serviceKey));
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. The existing `spl-recorder` tests must still pass — the archive call is additive and gated.

- [ ] **Step 7: Type-check and lint**

Run: `npm run type-check && npm run lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add main/services/archive/sample-archive.ts main/services/archive/sample-archive.test.ts main/services/archive/csv-appender.ts main/services/spl-recorder.ts
git commit -m "$(cat <<'EOF'
feat(archive): keep the raw SPL samples the recorder folds away

recordSample folds each 1 Hz reading into max/leq/count and discards it, which
is why the corrected Leq could not be applied to anything already recorded.
The reading is now also appended as a wide row -- all metrics on one line, one
row per tick -- alongside a sparse event row on each plan-item change.

Gated on serviceKey: no open service record means no key and nothing is
written, which keeps a Tuesday afternoon out of the archive.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
EOF
)"
```

---

## Task 5: Wire attendance and automation

**Files:**
- Modify: `main/services/attendance-recorder.ts` (at the `this.current.samples.push(sample)` call, ~line 155)
- Modify: `main/services/automation-engine.ts` (where it writes to `automationLog`)

**Interfaces:**
- Consumes: `sampleArchive.recordAttendance`, `sampleArchive.recordEvent` (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Read the two call sites**

Run:
```bash
grep -n "samples.push" -B 12 main/services/attendance-recorder.ts
grep -n "automationLog" -A 6 main/services/automation-engine.ts
```
Note the exact shape of `sample` (the attendance point) and of the automation log entry, and the field holding the current `serviceKey` / `serviceDate` on each recorder.

- [ ] **Step 2: Write the failing test**

```ts
// main/services/archive/sample-archive.test.ts — append to the existing file

test("attendance columns stay stable when a field is momentarily null", async () => {
  const ctx = { serviceKey: "st1:p2:t1", serviceDate: "2026-07-26" };
  sampleArchive.recordAttendance(ctx, { inside: 10, entries: 12, exits: 2 });
  sampleArchive.recordAttendance(ctx, { inside: null, entries: 13, exits: 3 });
  await sampleArchive.flush();
  const dir = path.join(dataDir, "archive", `${ctx.serviceDate}_${ctx.serviceKey.replace(/:/g, "-")}`);
  const rows = parseRows(await fs.readFile(path.join(dir, "attendance.csv"), "utf8"));
  assert.equal(rows.length, 3, "one file, not rolled");
  assert.deepEqual(rows[2], [rows[2][0], "13", "3", ""]);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --import tsx --test main/services/archive/sample-archive.test.ts`
Expected: FAIL — a null field currently produces the same column set, so this should actually PASS. If it passes, that confirms the behaviour is already right; keep the test as a regression guard and move on.

- [ ] **Step 4: Add the attendance call**

In `attendance-recorder.ts`, import:

```ts
import { sampleArchive } from "./archive/sample-archive.js";
```

Immediately after `this.current.samples.push(sample);`:

```ts
        // Attendance samples are already kept on the record, but only every 30s and
        // only as the shape the chart wants. Archive the same point so a future
        // calculation is not limited to today's fields.
        sampleArchive.recordAttendance(
          { serviceKey: this.current.serviceKey, serviceDate: this.current.serviceDate },
          { inside: sample.inside ?? null, entries: sample.entries ?? null, exits: sample.exits ?? null },
        );
```

Adjust the field names to match the sample shape found in Step 1. If a field does not exist on the sample, omit it rather than inventing one.

- [ ] **Step 5: Add the automation call**

In `automation-engine.ts`, at each point it appends to `automationLog`, add alongside it:

```ts
      const key = splRecorder.getCurrent();
      if (key) {
        sampleArchive.recordEvent(
          { serviceKey: key.serviceKey, serviceDate: key.serviceDate },
          "automation",
          entry.outcome ?? "fired",
          entry.ruleName ?? entry.ruleId,
        );
      }
```

Match `entry`'s real field names to the `AutomationLogEntry` shape. Import `splRecorder` from `./spl-recorder.js` and `sampleArchive` from `./archive/sample-archive.js`.

- [ ] **Step 6: Run the suite**

Run: `npm test && npm run type-check && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add main/services/attendance-recorder.ts main/services/automation-engine.ts main/services/archive/sample-archive.test.ts
git commit -m "$(cat <<'EOF'
feat(archive): archive attendance samples and automation fires

Attendance is already kept on the record, but only every 30s and only in the
shape the chart wants; the raw point is archived so a later calculation is not
limited to today's fields. Automation fires join the event log beside plan-item
changes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
EOF
)"
```

---

## Task 6: Build and inspect the archive bundle

**Files:**
- Create: `main/services/archive/archive-bundle.ts`
- Test: `main/services/archive/archive-bundle.test.ts`
- Modify: `package.json` (add `fflate`)

**Interfaces:**
- Consumes: `archiveRoot()` (Task 2); `splHistoryStore`, `attendanceStore`, `serviceTimelineStore`, `baptismStore`.
- Produces:
  ```ts
  export const ARCHIVE_KIND = "stage-utility-archive";
  export const ARCHIVE_VERSION = 1;
  export interface ArchiveServiceMeta { serviceKey: string; serviceDate: string; dir: string | null }
  export interface ArchiveManifest {
    kind: typeof ARCHIVE_KIND; version: number; appVersion: string; createdAt: string;
    services: ArchiveServiceMeta[];
  }
  export interface ImportPlan {
    manifest: ArchiveManifest;
    newServices: ArchiveServiceMeta[];
    presentServices: ArchiveServiceMeta[];
    newBaptismSessions: number;
  }
  export async function buildArchive(): Promise<Uint8Array>;
  export async function inspectArchive(zip: Uint8Array): Promise<ImportPlan>;
  ```

Why `fflate`: it is the only actively maintained zip library with **zero dependencies** (0.8.3, May 2026, MIT, 65M weekly downloads). `archiver` pulls four transitive deps for the same job.

- [ ] **Step 1: Add the dependency**

Run:
```bash
npm install fflate@^0.8.3
npm ls fflate
```
Expected: `fflate@0.8.3` with no children. If npm reports any transitive dependency, stop — that contradicts the zero-dep reason for choosing it.

- [ ] **Step 2: Write the failing test**

```ts
// main/services/archive/archive-bundle.test.ts
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { unzipSync } from "fflate";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-bundle-"));
process.env.STAGE_UTILITY_DATA = dataDir;

const { buildArchive, inspectArchive, ARCHIVE_KIND } = await import("./archive-bundle.js");
const { splHistoryStore } = await import("../spl-history-store.js");

function record(serviceKey: string, serviceDate: string) {
  return {
    serviceKey, serviceTypeId: "st1", serviceTypeName: "Sunday", planId: "p1",
    planTitle: "Plan", seriesTitle: null, serviceDate, serviceTimeId: "t9",
    serviceTimeStartsAt: null, meterId: null, metricKey: null,
    startedAt: `${serviceDate}T09:00:00.000Z`, endedAt: `${serviceDate}T10:15:00.000Z`, items: [],
  };
}

test("bundles the raw files and the derived records", async () => {
  await splHistoryStore.upsert(record("st1:p1:t9", "2026-07-26") as never);
  const dir = path.join(dataDir, "archive", "2026-07-26_st1-p1-t9");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "spl.csv"), "at,db\n2026-07-26T09:00:00.000Z,90\n");

  const files = unzipSync(await buildArchive());
  const names = Object.keys(files);
  assert.ok(names.includes("manifest.json"), names.join());
  assert.ok(names.includes("archive/2026-07-26_st1-p1-t9/spl.csv"), names.join());
  assert.ok(names.includes("stores/spl-history.json"), names.join());

  const m = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  assert.equal(m.kind, ARCHIVE_KIND);
  assert.equal(m.version, 1);
  assert.deepEqual(m.services.map((s: { serviceKey: string }) => s.serviceKey), ["st1:p1:t9"]);
});

test("inspect reports which services are new and which are already here", async () => {
  const zip = await buildArchive();
  const plan = await inspectArchive(zip);
  assert.equal(plan.presentServices.length, 1, "the service in the bundle is already on this box");
  assert.equal(plan.newServices.length, 0);

  await splHistoryStore.delete("st1:p1:t9");
  const after = await inspectArchive(zip);
  assert.equal(after.newServices.length, 1);
  assert.equal(after.presentServices.length, 0);
});

test("a config snapshot is rejected by name, not read as an empty archive", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const snapshot = zipSync({
    "manifest.json": strToU8(JSON.stringify({ kind: "stage-utility-config", version: 1, files: {} })),
  });
  await assert.rejects(
    () => inspectArchive(snapshot),
    /not a Stage Utility data archive/i,
  );
});

test("a newer schema version is refused with the version in the message", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const future = zipSync({
    "manifest.json": strToU8(JSON.stringify({ kind: ARCHIVE_KIND, version: 99, services: [] })),
  });
  await assert.rejects(() => inspectArchive(future), /version 99/);
});

test("a zip with no manifest is refused", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  await assert.rejects(() => inspectArchive(zipSync({ "spl.csv": strToU8("at,db\n") })), /no manifest/i);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --import tsx --test main/services/archive/archive-bundle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement build + inspect**

```ts
// archive-bundle.ts — the data archive: export, inspect, import.
//
// Separate from the config snapshot on purpose. History is excluded from that
// bundle because restoring it onto another install would fabricate services the
// machine never ran — true when cloning onto someone else's box, not true when
// rebuilding your own, which is what this exists for. Two bundles, two file names,
// two importers, so neither can be mistaken for the other.
//
// Import never overwrites: a serviceKey already on this box is skipped and
// reported. See `importArchive`.

import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { strToU8, unzipSync, zipSync } from "fflate";

import { attendanceStore } from "../attendance-store.js";
import { baptismStore } from "../baptism-store.js";
import { serviceTimelineStore } from "../service-timeline-store.js";
import { splHistoryStore } from "../spl-history-store.js";
import { archiveRoot, serviceDirName } from "./archive-paths.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const ARCHIVE_KIND = "stage-utility-archive";
export const ARCHIVE_VERSION = 1;

/** The derived history stores this bundle carries, beside the raw layer. These are
 *  RUNTIME_FILES in config-snapshot.ts — deliberately absent from a config backup
 *  and deliberately present here. */
const STORE_FILES = [
  "spl-history.json",
  "attendance-history.json",
  "service-timeline.json",
  "baptism.json",
] as const;

export interface ArchiveServiceMeta {
  serviceKey: string;
  serviceDate: string;
  /** Raw directory inside the zip, or null when the service predates the archive. */
  dir: string | null;
}

export interface ArchiveManifest {
  kind: typeof ARCHIVE_KIND;
  version: number;
  appVersion: string;
  createdAt: string;
  services: ArchiveServiceMeta[];
}

export interface ImportPlan {
  manifest: ArchiveManifest;
  newServices: ArchiveServiceMeta[];
  presentServices: ArchiveServiceMeta[];
  newBaptismSessions: number;
}

function pkgVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Every serviceKey this box knows about, from all three keyed stores. */
async function localServices(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of await splHistoryStore.list()) out.set(r.serviceKey, r.serviceDate);
  for (const r of await attendanceStore.list()) out.set(r.serviceKey, r.serviceDate);
  for (const r of await serviceTimelineStore.list()) out.set(r.serviceKey, r.serviceDate);
  return out;
}

async function readDirRecursive(root: string, prefix: string, into: Record<string, Uint8Array>): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return; // no archive dir yet — a box that has not recorded since this shipped
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) await readDirRecursive(full, `${prefix}${e.name}/`, into);
    else into[`${prefix}${e.name}`] = new Uint8Array(await fs.readFile(full));
  }
}

export async function buildArchive(): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};

  await readDirRecursive(archiveRoot(), "archive/", files);

  for (const name of STORE_FILES) {
    try {
      files[`stores/${name}`] = new Uint8Array(await fs.readFile(path.join(archiveRoot(), "..", name)));
    } catch {
      /* store absent — nothing recorded of that kind yet */
    }
  }

  const local = await localServices();
  const services: ArchiveServiceMeta[] = [...local.entries()].map(([serviceKey, serviceDate]) => {
    const dir = serviceDirName(serviceKey, serviceDate);
    return { serviceKey, serviceDate, dir: files[`archive/${dir}/spl.csv`] ? dir : null };
  });

  const manifest: ArchiveManifest = {
    kind: ARCHIVE_KIND,
    version: ARCHIVE_VERSION,
    appVersion: pkgVersion(),
    createdAt: new Date().toISOString(),
    services: services.sort((a, b) => a.serviceDate.localeCompare(b.serviceDate)),
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

  return zipSync(files, { level: 6 });
}

/** Unpack + validate. Throws with a readable reason rather than half-reading. */
function open(zip: Uint8Array): { files: Record<string, Uint8Array>; manifest: ArchiveManifest } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    throw new Error("That file is not a readable zip.");
  }
  const raw = files["manifest.json"];
  if (!raw) throw new Error("That archive has no manifest — it was not produced by Stage Utility.");
  let manifest: ArchiveManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error("That archive's manifest is unreadable.");
  }
  if (manifest.kind !== ARCHIVE_KIND) {
    throw new Error(
      manifest.kind === "stage-utility-config"
        ? "That is a config snapshot, not a Stage Utility data archive. Restore it under Backup & restore."
        : "Unrecognized file — not a Stage Utility data archive.",
    );
  }
  if (manifest.version > ARCHIVE_VERSION) {
    throw new Error(`That archive is version ${manifest.version}; this build reads up to ${ARCHIVE_VERSION}. Update first.`);
  }
  return { files, manifest };
}

export async function inspectArchive(zip: Uint8Array): Promise<ImportPlan> {
  const { files, manifest } = open(zip);
  const local = await localServices();
  const newServices = (manifest.services ?? []).filter((s) => !local.has(s.serviceKey));
  const presentServices = (manifest.services ?? []).filter((s) => local.has(s.serviceKey));

  const localIds = new Set((await baptismStore.listSessions()).map((s) => s.id));
  const incoming = readStore<{ sessions?: { id: string }[] }>(files, "baptism.json");
  const newBaptismSessions = (incoming?.sessions ?? []).filter((s) => !localIds.has(s.id)).length;

  return { manifest, newServices, presentServices, newBaptismSessions };
}

export function readStore<T>(files: Record<string, Uint8Array>, name: string): T | null {
  const raw = files[`stores/${name}`];
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as T;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --test main/services/archive/archive-bundle.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json main/services/archive/archive-bundle.ts main/services/archive/archive-bundle.test.ts
git commit -m "$(cat <<'EOF'
feat(archive): build and inspect the data archive bundle

A zip of the raw layer plus the derived history stores, with a manifest naming
every service inside. Inspect reports which services are new and which are
already on this box, so the readout can say what an import will do before it
does it.

A config snapshot handed to this importer is rejected by name and pointed at
Backup & restore, rather than read as an empty archive.

fflate for the zip: actively maintained, MIT, and the only one with no
transitive dependencies.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
EOF
)"
```

---

## Task 7: Import with merge rules

**Files:**
- Modify: `main/services/archive/archive-bundle.ts`
- Modify: `main/services/archive/archive-bundle.test.ts`

**Interfaces:**
- Consumes: `open`, `readStore`, `localServices` (Task 6).
- Produces:
  ```ts
  export interface ImportResult { added: string[]; skipped: string[]; replaced: string[]; baptismSessionsAdded: number }
  export async function importArchive(zip: Uint8Array, opts?: { replace?: string[] }): Promise<ImportResult>;
  ```

The rules, in order:

1. Match on `serviceKey`. Already present → skipped, and reported.
2. Replacing is explicit and per service (`opts.replace`), never blanket.
3. A service only in the archive is added — raw files and derived record together.
4. A derived record with no raw files is still imported (every pre-archive service looks like that) and its `dir` is null. Never the reverse.
5. Version and kind are checked before anything is read — done in `open`.
6. **Nothing is written until the whole archive has been read and validated.** Build the complete write set in memory, then commit.

Baptism sessions dedupe on `id`, not `serviceKey` — sessions are keyed by a UUID and one service can hold several.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/archive/archive-bundle.test.ts — append

test("importing a service this box does not have adds it, raw files and all", async () => {
  const { importArchive } = await import("./archive-bundle.js");
  await splHistoryStore.upsert(record("st1:pX:t1", "2026-08-02") as never);
  const dir = path.join(dataDir, "archive", "2026-08-02_st1-pX-t1");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "spl.csv"), "at,db\n2026-08-02T09:00:00.000Z,88\n");
  const zip = await buildArchive();

  await splHistoryStore.delete("st1:pX:t1");
  await fs.rm(dir, { recursive: true, force: true });

  const res = await importArchive(zip);
  assert.ok(res.added.includes("st1:pX:t1"), JSON.stringify(res));
  assert.ok(await splHistoryStore.get("st1:pX:t1"), "derived record restored");
  assert.equal(await fs.readFile(path.join(dir, "spl.csv"), "utf8"), "at,db\n2026-08-02T09:00:00.000Z,88\n");
});

test("importing the same archive twice is a no-op the second time", async () => {
  const { importArchive } = await import("./archive-bundle.js");
  const zip = await buildArchive();
  const first = await importArchive(zip);
  const second = await importArchive(zip);
  assert.equal(second.added.length, 0, JSON.stringify(second));
  assert.deepEqual(second.skipped.sort(), [...first.added, ...first.skipped].sort());
});

test("a service already present is skipped, not overwritten", async () => {
  const { importArchive } = await import("./archive-bundle.js");
  await splHistoryStore.upsert(record("st1:pY:t1", "2026-08-09") as never);
  const zip = await buildArchive();

  const mine = { ...record("st1:pY:t1", "2026-08-09"), planTitle: "MINE — do not clobber" };
  await splHistoryStore.upsert(mine as never);

  const res = await importArchive(zip);
  assert.ok(res.skipped.includes("st1:pY:t1"));
  assert.equal((await splHistoryStore.get("st1:pY:t1"))!.planTitle, "MINE — do not clobber");
});

test("replace is explicit and only touches the named service", async () => {
  const { importArchive } = await import("./archive-bundle.js");
  const zip = await buildArchive();
  const mine = { ...record("st1:pY:t1", "2026-08-09"), planTitle: "MINE" };
  await splHistoryStore.upsert(mine as never);

  const res = await importArchive(zip, { replace: ["st1:pY:t1"] });
  assert.deepEqual(res.replaced, ["st1:pY:t1"]);
  assert.equal((await splHistoryStore.get("st1:pY:t1"))!.planTitle, "Plan");
});

test("a corrupt member aborts the whole import with nothing written", async () => {
  const { importArchive } = await import("./archive-bundle.js");
  const { zipSync, strToU8 } = await import("fflate");
  const before = JSON.stringify(await splHistoryStore.list());

  const bad = zipSync({
    "manifest.json": strToU8(JSON.stringify({
      kind: ARCHIVE_KIND, version: 1, appVersion: "0", createdAt: "2026-08-09T00:00:00.000Z",
      services: [{ serviceKey: "st1:pZ:t1", serviceDate: "2026-08-16", dir: "2026-08-16_st1-pZ-t1" }],
    })),
    "stores/spl-history.json": strToU8("{ this is not json"),
  });

  await assert.rejects(() => importArchive(bad), /unreadable|invalid/i);
  assert.equal(JSON.stringify(await splHistoryStore.list()), before, "nothing was written");
});

test("a service with no raw files still imports its derived record", async () => {
  const { importArchive } = await import("./archive-bundle.js");
  const { zipSync, strToU8 } = await import("fflate");
  const rec = record("st1:pOld:t1", "2025-01-05");
  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify({
      kind: ARCHIVE_KIND, version: 1, appVersion: "0", createdAt: "2026-08-09T00:00:00.000Z",
      services: [{ serviceKey: "st1:pOld:t1", serviceDate: "2025-01-05", dir: null }],
    })),
    "stores/spl-history.json": strToU8(JSON.stringify([rec])),
  });
  const res = await importArchive(zip);
  assert.ok(res.added.includes("st1:pOld:t1"));
  assert.ok(await splHistoryStore.get("st1:pOld:t1"));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --test main/services/archive/archive-bundle.test.ts`
Expected: FAIL — `importArchive is not a function`.

- [ ] **Step 3: Implement**

Append to `archive-bundle.ts`:

```ts
export interface ImportResult {
  added: string[];
  skipped: string[];
  replaced: string[];
  baptismSessionsAdded: number;
}

/** Parse a store member, throwing rather than silently importing nothing. A
 *  corrupt member must abort the whole import — see the read-then-write split. */
function requireStore<T>(files: Record<string, Uint8Array>, name: string): T | null {
  const raw = files[`stores/${name}`];
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as T;
  } catch {
    throw new Error(`The archive's ${name} is unreadable — nothing was imported.`);
  }
}

/**
 * Merge an archive into this install.
 *
 * Read and validate everything first, then write. A corrupt member found halfway
 * through must not leave half a year imported, which is the failure this ordering
 * exists to prevent.
 */
export async function importArchive(zip: Uint8Array, opts: { replace?: string[] } = {}): Promise<ImportResult> {
  const { files, manifest } = open(zip);
  const replace = new Set(opts.replace ?? []);
  const local = await localServices();

  // ── Read phase: parse every member. Throws before anything is written. ──
  const spl = requireStore<{ serviceKey: string }[]>(files, "spl-history.json") ?? [];
  const attendance = requireStore<{ serviceKey: string }[]>(files, "attendance-history.json") ?? [];
  const timeline = requireStore<{ serviceKey: string }[]>(files, "service-timeline.json") ?? [];
  const baptisms = requireStore<{ sessions?: { id: string }[] }>(files, "baptism.json");

  const wanted = (manifest.services ?? []).filter((s) => !local.has(s.serviceKey) || replace.has(s.serviceKey));
  const wantedKeys = new Set(wanted.map((s) => s.serviceKey));
  const added = wanted.filter((s) => !local.has(s.serviceKey)).map((s) => s.serviceKey);
  const replaced = wanted.filter((s) => local.has(s.serviceKey)).map((s) => s.serviceKey);
  const skipped = (manifest.services ?? [])
    .filter((s) => local.has(s.serviceKey) && !replace.has(s.serviceKey))
    .map((s) => s.serviceKey);

  const localBaptismIds = new Set((await baptismStore.listSessions()).map((s) => s.id));
  const freshSessions = (baptisms?.sessions ?? []).filter((s) => !localBaptismIds.has(s.id));

  // ── Write phase: everything below is known-good. ──
  for (const r of spl) if (wantedKeys.has(r.serviceKey)) await splHistoryStore.upsert(r as never);
  for (const r of attendance) if (wantedKeys.has(r.serviceKey)) await attendanceStore.upsert(r as never);
  for (const r of timeline) if (wantedKeys.has(r.serviceKey)) await serviceTimelineStore.upsert(r as never);

  // Raw files for the services being brought in. A service whose dir is null
  // predates the archive and simply has none — its derived record is enough.
  for (const s of wanted) {
    if (!s.dir) continue;
    const prefix = `archive/${s.dir}/`;
    for (const [name, bytes] of Object.entries(files)) {
      if (!name.startsWith(prefix)) continue;
      const dest = path.join(archiveRoot(), s.dir, path.basename(name));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, bytes);
    }
  }

  // Baptism sessions dedupe on id, not serviceKey: the id is a UUID and one
  // service can hold several sessions.
  for (const s of freshSessions) await baptismStore.addSession(s as never);

  return { added, skipped, replaced, baptismSessionsAdded: freshSessions.length };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test main/services/archive/archive-bundle.test.ts`
Expected: PASS, 11/11.

- [ ] **Step 5: Prove the skip rule is not vacuous**

Change `wanted` to drop the `!local.has(...)` guard (`const wanted = manifest.services ?? []`). Re-run.
Expected: `a service already present is skipped, not overwritten` FAILS — `planTitle` comes back as `"Plan"`. Revert and confirm green.

- [ ] **Step 6: Prove the read-then-write split is not vacuous**

Move the `requireStore` calls below the first `splHistoryStore.upsert` loop. Re-run.
Expected: `a corrupt member aborts the whole import with nothing written` FAILS. Revert and confirm green.

- [ ] **Step 7: Commit**

```bash
git add main/services/archive/archive-bundle.ts main/services/archive/archive-bundle.test.ts
git commit -m "$(cat <<'EOF'
feat(archive): merge on import, never overwrite

A serviceKey already on this box is skipped and reported; replacing is
explicit and per service. Importing the same archive twice changes nothing.

Every member is parsed before anything is written, so a corrupt file found
halfway through cannot leave half a year imported. Baptism sessions dedupe on
id rather than serviceKey -- one service can hold several.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
EOF
)"
```

---

## Task 8: Routes

**Files:**
- Create: `main/services/routes/archive-routes.ts`
- Modify: `main/services/routes/context.ts` (add `readRawBody`)
- Modify: `main/services/remote-server.ts` (register the module)

**Interfaces:**
- Consumes: `buildArchive`, `inspectArchive`, `importArchive` (Tasks 6–7).
- Produces: `GET /api/archive/export` → `application/zip`; `POST /api/archive/inspect` → `ImportPlan`; `POST /api/archive/import` → `ImportResult`. Both POSTs take the raw zip as the request body.

The existing `readBody` parses JSON and would corrupt a zip, so a raw reader is needed. **Note the one rule in `context.ts`: a route must finish responding before it returns.**

- [ ] **Step 1: Add `readRawBody`**

In `main/services/routes/context.ts`, beside `readBody`:

```ts
/** The request body as bytes. `readBody` parses JSON and would mangle a binary
 *  upload, so anything that carries a file uses this instead. */
export async function readRawBody(req: http.IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}
```

- [ ] **Step 2: Write the route module**

```ts
// archive-routes.ts — the data archive: download, inspect, import.
//
// Separate from the config snapshot routes in system-routes.ts, and deliberately
// so: the two bundles restore different things and must not be confused. Inspect
// exists so the UI can say what an import will do before it does it.

import {
  buildArchive,
  importArchive,
  inspectArchive,
} from "../archive/archive-bundle.js";
import { error, json, readRawBody, type RouteCtx } from "./context.js";

export async function archiveRoutes({ req, res, pathname, method }: RouteCtx): Promise<void> {
  if (method === "GET" && pathname === "/api/archive/export") {
    const zip = await buildArchive();
    const fname = `stage-archive-${new Date().toISOString().slice(0, 10)}.zip`;
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fname}"`,
      "Content-Length": String(zip.byteLength),
    });
    res.end(Buffer.from(zip));
    return;
  }

  // What would an import do? Counts only — nothing is written.
  if (method === "POST" && pathname === "/api/archive/inspect") {
    try {
      json(res, await inspectArchive(await readRawBody(req)));
    } catch (err) {
      error(res, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (method === "POST" && pathname === "/api/archive/import") {
    try {
      const raw = await readRawBody(req);
      // `replace` rides in a header rather than the body, which is the zip itself.
      const header = req.headers["x-archive-replace"];
      const replace = typeof header === "string" && header ? header.split(",").map((s) => s.trim()) : [];
      json(res, await importArchive(raw, { replace }));
    } catch (err) {
      error(res, err instanceof Error ? err.message : String(err));
    }
    return;
  }
}
```

- [ ] **Step 3: Register it**

In `main/services/remote-server.ts`, find the domain-route list (just after the `── Domain routes ──` comment) and add `archiveRoutes` to it, importing it alongside the other route modules. Match the existing call style exactly.

- [ ] **Step 4: Verify by hand against the running dev server**

Run (the localhost dev server must be on this branch, per the standing convention):

```bash
curl -sS -D- -o /tmp/arch.zip "http://localhost:8788/api/archive/export" | head -5
node --input-type=module -e "
  import { unzipSync } from 'fflate';
  import { readFileSync } from 'node:fs';
  const f = unzipSync(new Uint8Array(readFileSync('/tmp/arch.zip')));
  console.log(Object.keys(f));
"
curl -sS -X POST --data-binary @/tmp/arch.zip http://localhost:8788/api/archive/inspect
```

Expected: a `200` with `Content-Type: application/zip`; the zip lists `manifest.json`, `stores/…`, and `archive/…` if anything has been recorded; inspect reports every service as present (this box produced them).

- [ ] **Step 5: Suite, types, lint**

Run: `npm test && npm run type-check && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add main/services/routes/archive-routes.ts main/services/routes/context.ts main/services/remote-server.ts
git commit -m "$(cat <<'EOF'
feat(archive): export, inspect and import routes

Inspect returns counts only and writes nothing, so the panel can state what an
import will do before offering the button.

readBody parses JSON and would mangle a zip, so binary uploads read the body as
bytes instead.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
EOF
)"
```

---

## Task 9: The Advanced panel, and docs

**Files:**
- Create: `renderer/settings/sections/data-archive-panel.tsx`
- Modify: `renderer/settings/sections/advanced-section.tsx` (~line 722, beside the `Backup & restore` collapsible)
- Create: `docs/data-archive.md`
- Modify: `docs/superpowers/specs/2026-07-31-data-archive-design.md` (the event-log scope note)

**Interfaces:**
- Consumes: `/api/archive/export`, `/api/archive/inspect`, `/api/archive/import`.
- Produces: `<DataArchivePanel />`.

Copy rules from the spec, because both exports now sit on one screen:

- **"Backup & restore — how the app is set up"** against **"Data archive — what the app recorded."** Neither says "export" unqualified.
- The import states what it will do — how many services are in the file, how many are already here and will be skipped, how many are new — **and only then offers the button.** Not a confirmation dialog, which is dismissed unread.
- No emojis. Lucide icons only, matching `advanced-section.tsx`'s existing imports.

- [ ] **Step 1: Write the panel**

```tsx
// data-archive-panel.tsx — download / restore everything the app has recorded.
//
// Sits beside Backup & restore, which does the other half: that one restores how
// the app is set up, this one restores what it recorded. They are one click apart,
// so the wording carries the distinction the layout does not.
//
// Import is deliberately two steps. Picking a file only inspects it and reports
// what would happen; the button appears after. A confirmation dialog would be
// dismissed unread, where a count of "3 new, 41 already here" makes an archive
// from the wrong box obvious while it is still a click away.

import { DownloadIcon, UploadIcon } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";

import {
  Button,
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  toast,
} from "../../components/ui";

interface ServiceMeta {
  serviceKey: string;
  serviceDate: string;
}
interface ImportPlan {
  newServices: ServiceMeta[];
  presentServices: ServiceMeta[];
  newBaptismSessions: number;
}

export function DataArchivePanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ file: File; plan: ImportPlan } | null>(null);
  const [busy, setBusy] = useState(false);

  function download() {
    window.location.assign("/api/archive/export");
  }

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const res = await fetch("/api/archive/inspect", { method: "POST", body: await file.arrayBuffer() });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Could not read that archive.");
      setPending({ file, plan: body as ImportPlan });
    } catch (err) {
      setPending(null);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await fetch("/api/archive/import", {
        method: "POST",
        body: await pending.file.arrayBuffer(),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Import failed.");
      toast.success(
        `Added ${body.added.length} service${body.added.length === 1 ? "" : "s"}, skipped ${body.skipped.length}.`,
      );
      setPending(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FieldSet flat>
      <FieldGroup>
        <Field orientation="vertical">
          <FieldContent>
            <FieldLabel>Data archive</FieldLabel>
            <FieldDescription>
              Everything the app has recorded — service history, SPL readings, attendance
              and baptism timings, including the raw samples behind them. Use it to move
              your history onto a rebuilt machine. This is separate from Backup &amp;
              restore above, which covers how the app is set up rather than what it
              recorded.
            </FieldDescription>
          </FieldContent>

          <div className="flex flex-wrap gap-2">
            <Button variant="filled" size="small" onClick={download} disabled={busy}>
              <DownloadIcon className="size-3.5 text-gray-9" /> Download archive
            </Button>
            <Button variant="filled" size="small" onClick={() => fileRef.current?.click()} disabled={busy}>
              <UploadIcon className="size-3.5 text-gray-9" /> Choose an archive
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/zip,.zip"
              className="hidden"
              onChange={onPick}
            />
          </div>

          {pending && (
            <div className="mt-2 flex flex-col gap-2 rounded-xl border border-gray-5 bg-gray-2 p-3">
              <span className="text-caption1 text-gray-12">{pending.file.name}</span>
              <span className="text-caption2 text-gray-9">
                {pending.plan.newServices.length} service
                {pending.plan.newServices.length === 1 ? "" : "s"} would be added.{" "}
                {pending.plan.presentServices.length} already here and will be left alone.
                {pending.plan.newBaptismSessions > 0
                  ? ` ${pending.plan.newBaptismSessions} baptism session${pending.plan.newBaptismSessions === 1 ? "" : "s"} would be added.`
                  : ""}
              </span>
              {pending.plan.newServices.length === 0 ? (
                <span className="text-caption2 text-gray-9">
                  Nothing to import — this box already has everything in that file.
                </span>
              ) : (
                <div className="flex gap-2">
                  <Button variant="accent" size="small" onClick={runImport} disabled={busy}>
                    Import {pending.plan.newServices.length} service
                    {pending.plan.newServices.length === 1 ? "" : "s"}
                  </Button>
                  <Button variant="transparent" size="small" onClick={() => setPending(null)} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          )}
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}
```

- [ ] **Step 2: Mount it**

In `advanced-section.tsx`, immediately after the existing `Backup & restore` collapsible (~line 722), add:

```tsx
        <Collapsible label="Data archive" summary="Download & restore recorded history" headerClassName="px-4 py-2.5">
          <DataArchivePanel />
        </Collapsible>
```

and import it at the top:

```tsx
import { DataArchivePanel } from "./data-archive-panel.js";
```

Then change the existing collapsible's summary from `"Save, download & recall config snapshots"` to `"Save, download & recall how the app is set up"`, so the two read as a pair rather than two exports.

- [ ] **Step 3: Check it in a browser**

Open `http://localhost:8788/settings` → Advanced. Confirm: both collapsibles present and distinguishable; Download archive produces `stage-archive-YYYY-MM-DD.zip`; choosing that same file reports every service as already here and offers no import button; light and dark mode both legible; no emojis.

- [ ] **Step 4: Write the docs**

Create `docs/data-archive.md`:

```markdown
# Data archive

What the app has recorded, kept and portable.

## What it holds

While a service is live the app writes append-only CSVs under
`<data>/archive/<date>_<serviceKey>/`:

| File | One row per |
|---|---|
| `spl.csv` | 1 Hz tick, all metrics on the row |
| `attendance.csv` | SenSource poll |
| `events.csv` | plan-item change, automation fire |
| `manifest.json` | — schema version and the files present |

Nothing is written outside a service: no open service record means no
`serviceKey`, and no key means every archive call is a no-op.

## Why it exists

The SPL recorder folds each 1 Hz reading into max/leq/count and discards the
sample. When the average was corrected from an arithmetic mean of decibels to an
energy average, every past service was stuck with the wrong figure — the maths
was recoverable, the data was not.

## Export and import

**Settings → Advanced → Data archive.** Download produces
`stage-archive-YYYY-MM-DD.zip`: the raw CSVs plus the derived history stores.

This is not the config snapshot. Backup & restore covers how the app is set up;
the archive covers what it recorded. They are separate files with separate
importers, and handing one to the other is refused by name.

Import merges rather than replaces:

- A `serviceKey` already on this box is **skipped** and reported.
- Replacing is explicit and per service.
- Importing the same archive twice changes nothing.
- Every member is parsed before anything is written, so a corrupt file cannot
  leave a half-imported year.
- Baptism sessions dedupe on their id, since one service can hold several.

The panel inspects a chosen file and states what would happen — how many
services are new, how many are already here — before offering the button.

## Not retroactive

Services recorded before this shipped kept only their aggregates. The raw layer
starts from the version that introduced it; nothing recovers what was already
discarded.

## Size

About 0.45 MB per service, roughly 47 MB a year at two services a week. There is
no automatic pruning.

## Not included

Wireless RF and battery are sampled at 1 Hz and still not stored. Nothing depends
on them yet and they are two thirds of the bytes, so they wait; the layout leaves
room for a `wireless.csv` beside the others.
```

- [ ] **Step 5: Amend the spec's scope note**

In `docs/superpowers/specs/2026-07-31-data-archive-design.md`, under **Out of scope**, add:

```markdown
- **OBS, REAPER and OSC in the event log.** They have no single change-detection
  chokepoint today — their state flows through the stage-state object rather than a
  dedicated broadcast — so wiring them means adding one, which is a separate change.
  `recordEvent(source, kind, detail)` is generic, so each is a one-line call once a
  chokepoint exists. v1 logs plan-item changes and automation fires.
```

- [ ] **Step 6: Full check**

Run: `npm test && npm run type-check && npm run lint && npm run build`
Expected: clean.

- [ ] **Step 7: Commit and open the PR**

```bash
git add renderer/settings/sections/data-archive-panel.tsx renderer/settings/sections/advanced-section.tsx docs/data-archive.md docs/superpowers/specs/2026-07-31-data-archive-design.md
git commit -m "$(cat <<'EOF'
feat(archive): Data archive panel in Advanced

Sits beside Backup & restore, which restores how the app is set up where this
restores what it recorded. One click apart, so the wording carries the
distinction the layout does not.

Import is two steps: choosing a file inspects it and reports what would happen,
and the button appears after. A confirmation dialog would be dismissed unread,
where "3 new, 41 already here" makes an archive from the wrong box obvious
while it is still a click away.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
EOF
)"
git push -u origin feat/data-archive
gh pr create --base beta --title "feat(archive): keep every raw sample, and make the history portable" --body "$(cat <<'EOF'
SPL is sampled at 1 Hz and folded straight into max/leq/count, so the samples are gone — which is why the corrected Leq could not be applied to anything already recorded.

Adds an append-only raw layer under `<data>/archive/<date>_<serviceKey>/`, gated on an open service record, plus a data archive export/import in Advanced kept separate from the config snapshot.

- One wide CSV row per 1 Hz tick; a changed column set rolls to a new file rather than a ragged one
- Attendance polls, plan-item changes and automation fires alongside
- Import merges by serviceKey — already present means skipped, replacing is explicit, twice is a no-op
- Every member parsed before anything is written, so a corrupt file cannot leave a half-imported year
- ~0.45 MB per service, ~47 MB a year

Wireless RF/battery stays unstored for now; the layout leaves room for it.

Docs: `docs/data-archive.md`. Spec: `docs/superpowers/specs/2026-07-31-data-archive-design.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Append-only CSV, header once, truncation-tolerant | 1, 3 |
| One directory per service occurrence, sanitised key | 2 |
| Wide row per tick, new file on column change | 3, 4 |
| SPL 1 Hz samples retained | 4 |
| Attendance polls, event log, baptism rows | 5, 6 (baptisms ride in the store, not a CSV — see below) |
| Gated on an open service record | 4 (`entry()` returns null without a key) |
| Manifest per service | 4 |
| Zip export incl. derived stores | 6 |
| Import merge rules 1–6 | 7 |
| Pre-import readout | 8 (route), 9 (UI) |
| Advanced placement, copy distinction, file naming | 9 |
| Not-retroactive stated in the UI | 9 (docs); **also add a line to the panel description** |
| Testing list | 1, 3, 4, 6, 7 |
| Size figures | 9 (docs) |

**Two deviations, both deliberate and noted in-plan:**

1. **`baptisms.csv` is not written.** The spec listed it, but per-person durations are *already* the raw data — there is no folding to undo — and they ride in `baptism.json`, which the bundle carries. A CSV would be a second copy of the same numbers. If a flat file is wanted for Excel, that is a derived-export concern (the History tab already exports baptisms per person), not a raw-layer one.
2. **The event log covers plan-item changes and automation fires only.** OBS/REAPER/OSC have no change chokepoint yet; Task 9 Step 5 amends the spec to say so rather than leaving the plan quietly short.

**Placeholder scan:** none — every step has runnable code or an exact command. Task 5 Steps 1/4/5 deliberately say "match the real field names found in Step 1", which is a read-the-code instruction with the grep given, not a TBD.

**Type consistency:** `ServiceCtx {serviceKey, serviceDate}` is used identically in Tasks 4, 5. `ArchiveServiceMeta.dir: string | null` is produced in Task 6 and consumed in Task 7's raw-file loop. `ImportPlan` fields (`newServices`, `presentServices`, `newBaptismSessions`) match between Task 6, Task 8's route and Task 9's UI. `CsvAppender.settled()` is added in Task 4 and used by `flush()` in the same task.

**One fix applied during review:** Task 4's first `flush()` draft appended an empty row; the corrected chain-settle version and the `settled()` addition to `CsvAppender` are both shown in-line.
