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

  /** Drop the in-memory appenders for a finalised record. */
  closeService(serviceKey: string): void {
    this.services.delete(serviceKey);
  }
}

export const sampleArchive = new SampleArchive();
