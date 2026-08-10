// sample-archive.ts — the raw layer's front door.
//
// The recorders call this on the live tick, so nothing here blocks or throws:
// every record method returns void, writes queue on the appender's chain, and a
// failure is logged there. Losing a sample is survivable; taking the live service
// down to record one is not.
//
// Gated on serviceKey. No open service record means no key, and no key means every
// call is a no-op — which is what keeps a Tuesday afternoon out of the archive.
//
// Why this exists: the SPL recorder folds each 1 Hz reading into max/leq/count and
// discards it. That fold cannot be undone, which is why a corrected Leq could not
// be applied to anything already recorded. See docs/data-archive.md.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { atomicWrite } from "../write-queue.js";
import { serviceDirPath } from "./archive-paths.js";
import { readArchiveRows, rolledFiles, type ArchiveRow } from "./archive-rows.js";
import { CsvAppender } from "./csv-appender.js";
import { encodeRow } from "./csv.js";

export interface ServiceCtx {
  serviceKey: string;
  serviceDate: string;
}

const MANIFEST_VERSION = 1;

/** Every source this archive writes. Merging has to move all of them, so the
 *  list is named once rather than inferred from whatever happens to be on disk. */
const SOURCES = ["spl", "attendance", "events"] as const;

interface ServiceEntry {
  ctx: ServiceCtx;
  dir: string;
  appenders: Map<string, CsvAppender>;
}

class SampleArchive {
  private services = new Map<string, ServiceEntry>();

  /** The open service's writers, or null when nothing is recording. */
  private entry(ctx: ServiceCtx): ServiceEntry | null {
    if (!ctx.serviceKey) return null;
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

  /**
   * One wide row per tick — every metric on one line.
   *
   * A row per metric per tick is four times the bytes for the same information and
   * does not pivot directly. Keys are sorted so a meter reporting the same metrics
   * in a different order does not look like a changed column set and roll the file.
   */
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

  /** Sparse state changes — a plan item going live, an automation rule firing. */
  recordEvent(ctx: ServiceCtx, source: string, kind: string, detail: string): void {
    const e = this.entry(ctx);
    if (!e) return;
    void this.appender(e, "events").append(
      ["at", "source", "kind", "detail"],
      [new Date().toISOString(), source, kind, detail],
    );
  }

  /** Settle every queued write. Tests await this; the live path does not need to. */
  async flush(): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const e of this.services.values()) for (const a of e.appenders.values()) waits.push(a.settled());
    await Promise.all(waits);
  }

  /** Record what this service produced, so an importer knows what to expect. */
  async writeManifest(ctx: ServiceCtx): Promise<void> {
    const e = this.entry(ctx);
    if (!e) return;
    await this.flush(); // name the files that actually landed, not the ones queued
    const files = [...new Set([...e.appenders.values()].flatMap((a) => a.files()))].sort();
    if (files.length === 0) return; // nothing was recorded — leave no empty directory
    await fs.mkdir(e.dir, { recursive: true });
    await fs.writeFile(
      path.join(e.dir, "manifest.json"),
      JSON.stringify(
        { version: MANIFEST_VERSION, serviceKey: ctx.serviceKey, serviceDate: ctx.serviceDate, files },
        null,
        2,
      ),
      "utf8",
    );
  }

  /**
   * Move one service's raw rows into another's, then remove the source.
   *
   * The archive is the source of truth, not a copy: a restart resumes SPL by
   * rebuilding the record from these rows. So a history merge that only combined
   * the derived records undid itself — forget(targetKey) is exactly what triggers
   * the rebuild, and the rebuild read the target's own directory, which had never
   * heard of the merged-in items. The operator saw the merge succeed and the next
   * restart silently put it back.
   *
   * Rewritten rather than appended, for two reasons. Order: the merge panel
   * offers every same-day recording, so the source is as often the earlier
   * fragment as the later tail, and rebuild takes each item's last row as its
   * end — appending an earlier fragment onto the end would date every item to
   * the wrong moment. Columns: two recordings of the same service can carry
   * different metric sets, and a full rewrite can widen every row to the union
   * instead of leaving a ragged file that only the roll logic can read.
   *
   * Returns rows moved per source, for the caller to log. Throws: unlike the
   * record path this is an operator action with a caller waiting on the answer,
   * so a failure must reach them rather than be logged past.
   */
  async mergeInto(source: ServiceCtx, target: ServiceCtx): Promise<Record<string, number>> {
    const srcDir = serviceDirPath(source.serviceKey, source.serviceDate);
    const tgtDir = serviceDirPath(target.serviceKey, target.serviceDate);
    if (srcDir === tgtDir) return {};

    const moved: Record<string, number> = {};
    for (const base of SOURCES) {
      const srcRows = await readArchiveRows(srcDir, base);
      if (!srcRows || srcRows.length === 0) continue;
      const tgtRows = (await readArchiveRows(tgtDir, base)) ?? [];

      const all = sortByTime([...tgtRows, ...srcRows]);
      const header = unionHeader(all);
      await fs.mkdir(tgtDir, { recursive: true });
      const body = [encodeRow(header), ...all.map((r) => encodeRow(header.map((h) => r[h] ?? "")))].join("");
      await atomicWrite(path.join(tgtDir, `${base}.csv`), body);
      // The union lives in `${base}.csv` now, so every rolled file this source
      // had is stale. Left in place they would be read back as duplicate rows.
      for (const name of await rolledFiles(tgtDir, base)) {
        if (name !== `${base}.csv`) await fs.rm(path.join(tgtDir, name), { force: true });
      }
      moved[base] = srcRows.length;
    }

    // Both, not just the source. The target's in-memory appender still points at
    // the file that was just rewritten under it, holding the pre-merge column
    // set — its next append would write short rows against the wider header.
    this.closeService(source.serviceKey);
    this.closeService(target.serviceKey);
    await fs.rm(srcDir, { recursive: true, force: true });
    await this.rewriteManifest(target, tgtDir);
    return moved;
  }

  /** Restate a manifest from what is actually on disk — after a merge the
   *  appenders' record of what they wrote no longer describes the directory. */
  private async rewriteManifest(ctx: ServiceCtx, dir: string): Promise<void> {
    const files: string[] = [];
    for (const base of SOURCES) files.push(...(await rolledFiles(dir, base)));
    if (files.length === 0) return;
    await atomicWrite(
      path.join(dir, "manifest.json"),
      JSON.stringify(
        { version: MANIFEST_VERSION, serviceKey: ctx.serviceKey, serviceDate: ctx.serviceDate, files: files.sort() },
        null,
        2,
      ),
    );
  }

  /** Drop the in-memory appenders for a finalised record. */
  closeService(serviceKey: string): void {
    this.services.delete(serviceKey);
  }
}

/** Chronological, with unparseable timestamps left where they were — sort is
 *  stable, so returning 0 for a bad `at` keeps it beside its neighbours rather
 *  than herding every damaged row to one end. */
function sortByTime(rows: ArchiveRow[]): ArchiveRow[] {
  return rows.sort((a, b) => {
    const ta = Date.parse(a.at ?? "");
    const tb = Date.parse(b.at ?? "");
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
    return ta - tb;
  });
}

/** Every column across the rows, `at` first, then first-seen order. */
function unionHeader(rows: ArchiveRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  seen.delete("at");
  return ["at", ...seen];
}

export const sampleArchive = new SampleArchive();
