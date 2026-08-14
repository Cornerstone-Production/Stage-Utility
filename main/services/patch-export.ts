// patch-export.ts — a patch sheet as flat rows, ready to serialise.
//
// One row model, two serialisers (CSV and XLSX). Keeping the model here rather
// than in each writer is what stops the two formats disagreeing about content,
// and building it on the same resolver the editor uses is what stops the file
// disagreeing with the screen.
//
// The exported document is the thing that gets printed and taped to a rack, so
// two rules govern it: never drop a hop (a missing hop misstates the signal path,
// which is the whole point of the sheet), and never invent one either — a hop
// whose device has been deleted renders its raw id rather than vanishing.

import type { PatchDevice, PatchEndpoint, PatchHop, PatchSheet } from "../types/stage.js";
import { zonedDateKey } from "./app-timezone.js";
import { mergeOverrides, resolvePatch } from "./patch-resolve.js";

export interface ExportRow {
  rackCh: string;
  console: string;
  dir: string;
  label: string;
  source: string;
  phantom: string;
  rack: string;
  path: string;
  owner: string;
  notes: string;
}

/**
 * Column order is reading order for an engineer holding the sheet.
 *
 * The names are not arbitrary: each is one the patch IMPORTER's column detection
 * already recognises, so a sheet exported from here re-imports without hand-mapping.
 * Getting this wrong is not cosmetic — an earlier draft called the console channel
 * "Channel", which the importer auto-maps to the RACK channel number, silently
 * shifting every row's identity on the way back in. Changing a header here means
 * checking autoMap() in patch-import.tsx, and patch-export-roundtrip.test.ts fails
 * if the two stop agreeing.
 */
export const EXPORT_HEADERS = [
  "Rack ch",
  "Console",
  "Dir",
  "Source / Name",
  "Mic / Feed",
  "48V",
  "Rack",
  "Path",
  "Owner",
  "Notes",
] as const;

/** Device name for an id, falling back to the raw id when the device is gone.
 *  Dropping the reference instead would quietly misstate the patch. */
function deviceName(devices: PatchDevice[], id: string): string {
  if (!id) return "";
  return devices.find((d) => d.id === id)?.name ?? id;
}

/**
 * The connector label this endpoint occupies on its own rack.
 *
 * A device may carry custom labels ("B-1", "S11") from "Generate labels"; when it
 * does, the sheet is patched against those and a bare index would be wrong. `index`
 * is 1-based in the UI, so it indexes the label list from zero.
 */
function rackConnector(devices: PatchDevice[], e: PatchEndpoint): string {
  const d = devices.find((x) => x.id === e.rackId);
  const labels = e.dir === "in" ? d?.inLabels : d?.outLabels;
  return labels?.[e.index - 1] ?? String(e.index);
}

/** The ordered hop chain, as an engineer traces it. */
function renderPath(devices: PatchDevice[], hops: PatchHop[] | undefined): string {
  const list = hops ?? [];
  if (list.length === 0) return "";
  return list.map((h) => `${deviceName(devices, h.deviceId)}:${h.connector}`).join(" -> ");
}

/** What is plugged in: the mic for an input, the feed type for an output. */
function sourceOf(e: PatchEndpoint): string {
  return ((e.dir === "in" ? e.mic : e.feedType) ?? "").trim();
}

/**
 * Rows, in rack order then direction then index — the order the table shows, so
 * the file matches the screen. `consoleChannel` is a free-text label ("01", "TB")
 * and is deliberately NOT sorted on: it is not always numeric and not always set.
 */
function inRackOrder(devices: PatchDevice[]) {
  const rank = new Map(devices.map((d, i) => [d.id, i] as const));
  return (a: PatchEndpoint, b: PatchEndpoint): number =>
    (rank.get(a.rackId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.rackId) ?? Number.MAX_SAFE_INTEGER) ||
    a.rackId.localeCompare(b.rackId) ||
    (a.dir === b.dir ? 0 : a.dir === "in" ? -1 : 1) ||
    a.index - b.index;
}

export interface ExportOptions {
  /** Include endpoints marked unused. Off by default: they are blank rows on
   *  paper, and a patch sheet is read at a glance. */
  includeUnused?: boolean;
  /**
   * Export what a given plan actually runs: default → standing variant →
   * per-plan variant → that week's tweaks, via resolvePatch. Takes precedence
   * over `variantId`, which cannot express a week.
   *
   * Without this the "This week" tab had nothing to send. It passed
   * variantId=null, so the download was the untouched DEFAULT patch while the
   * screen showed the variant plus this Sunday's tweaks — an engineer who
   * swapped a mic for the week taped a sheet to the rack showing the old patch,
   * with nothing in the file or its name to say anything had been dropped.
   */
  plan?: { planId: string | null; serviceTypeId: string | null };
}

/**
 * Rows for a sheet. `variantId` null exports the default patch; a variant is
 * merged through the same resolver the editor uses, so the export is the patch
 * the operator is looking at rather than a second interpretation of it.
 */
export function exportRows(
  sheet: PatchSheet,
  variantId: string | null = null,
  options: ExportOptions = {},
): ExportRow[] {
  const variant = variantId ? sheet.variants.find((v) => v.id === variantId) : null;
  const endpoints = options.plan
    ? resolvePatch(sheet, options.plan).endpoints
    : variant
      ? mergeOverrides(sheet.endpoints, variant.overrides)
      : sheet.endpoints;
  const devices = sheet.devices ?? [];

  return [...endpoints]
    .filter((e) => (options.includeUnused ? true : e.unused !== true))
    .sort(inRackOrder(devices))
    .map((e) => ({
      rackCh: rackConnector(devices, e),
      console: (e.consoleChannel ?? "").trim(),
      dir: e.dir === "in" ? "in" : "out",
      label: (e.label ?? "").trim(),
      source: sourceOf(e),
      // A value the importer's truthy() accepts, so phantom survives a round trip
      // as a boolean rather than as prose folded into the mic cell.
      phantom: e.phantom ? "48V" : "",
      rack: deviceName(devices, e.rackId),
      path: renderPath(devices, e.path),
      owner: (e.owner ?? "").trim(),
      notes: (e.notes ?? "").trim(),
    }));
}

/** A row as the flat cell list the serialisers write, in EXPORT_HEADERS order. */
export function rowCells(r: ExportRow): string[] {
  return [r.rackCh, r.console, r.dir, r.label, r.source, r.phantom, r.rack, r.path, r.owner, r.notes];
}

/**
 * Slugified, variant-named, dated.
 *
 * These get emailed and then sit in a downloads folder for a year; "patch.csv" is
 * worthless by then, and two of them in the same folder are worse.
 */
export function exportFilename(
  sheetName: string,
  variantName: string | null,
  ext: string,
  at: number = Date.now(),
): string {
  const slug = (s: string) =>
    s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "patch";
  // The app's zone, not the server's clock. toISOString() here dated a file
  // exported at 22:35 in Chicago as the NEXT day, which is how you end up with
  // two "different" patch sheets from one evening.
  const parts = [slug(sheetName), variantName ? slug(variantName) : null, zonedDateKey(at)];
  return `${parts.filter(Boolean).join("-")}.${ext}`;
}
