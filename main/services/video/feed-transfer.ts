// main/services/video/feed-transfer.ts — moving feeds between servers.
//
// The pure half of the video-only export and import: the file's shape and its
// refusals, the export query, and the comparison that both the review screen and
// the import itself read. One comparison, so what the review promises is what the
// import does.
//
// Nothing here writes a store or logs. VideoService owns the writes (it holds the
// reconcile and publish machinery) and the log lines.

import { appVersion } from "../config-snapshot.js";
import { settingsStore } from "../settings-store.js";
import {
  type FeedDifference,
  type ImportFeedPreview,
  type ImportPreview,
  type VideoFeed,
  type VideoFeedsBundle,
  type VideoFeedsFile,
  type VideoPorts,
  type VideoSource,
  type VideoSourceKind,
} from "../../types/video.js";
import { FEED_ID_PATTERN } from "./feed-id.js";
import { parseFeedInput } from "./feed-input.js";
import { PORT_KEYS, parsePorts } from "./ports.js";

export const VIDEO_FEEDS_BUNDLE_KIND = "stage-utility-video-feeds";

/** What a push feed's publish password looks like: the base62 `generatePushPassword`
 *  makes. A file's own is held to the same shape, because it ends up inside an SRT
 *  stream id, an RTMP query and the relay's config. */
const PUSH_PASSWORD_FORMAT = /^[A-Za-z0-9]{16,64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ── The file ────────────────────────────────────────────────────────────────

/**
 * Refuses a file that is not a usable video feeds export, by naming what is
 * wrong. Structural problems only: a feed whose OWN content this build cannot
 * take (a kind it does not offer, say) is not a reason to refuse the file; the
 * review marks it invalid and the import skips it.
 */
export function assertVideoBundle(raw: unknown): VideoFeedsBundle {
  if (!isRecord(raw)) throw new Error("That is not a video feeds file.");
  if (raw.kind !== VIDEO_FEEDS_BUNDLE_KIND) {
    const found = typeof raw.kind === "string" && raw.kind !== "" ? `"${raw.kind.slice(0, 60)}"` : "unknown";
    throw new Error(`That is a ${found} file, not a video feeds export.`);
  }
  if (raw.version !== 1) {
    throw new Error(`This video feeds file is version ${String(raw.version).slice(0, 20)}; this server reads version 1.`);
  }
  if (!Array.isArray(raw.feeds)) throw new Error("That file has no list of feeds in it.");

  const seen = new Set<string>();
  for (const [i, entry] of raw.feeds.entries()) {
    if (!isRecord(entry)) throw new Error(`Feed ${i + 1} in the file is not an object.`);
    const id = entry.id;
    if (typeof id !== "string" || !FEED_ID_PATTERN.test(id)) {
      throw new Error(`Feed ${i + 1} in the file has an id this server cannot use.`);
    }
    if (seen.has(id)) throw new Error(`The file lists the feed id "${id}" more than once.`);
    seen.add(id);
  }

  let ports: VideoPorts | undefined;
  if (raw.ports !== undefined) {
    const parsed = parsePorts(raw.ports);
    if (!parsed.ok) throw new Error(`The relay ports in the file are not usable: ${parsed.error}`);
    ports = parsed.ports;
  }

  return {
    kind: VIDEO_FEEDS_BUNDLE_KIND,
    version: 1,
    appVersion: typeof raw.appVersion === "string" ? raw.appVersion : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    source: { server: isRecord(raw.source) && typeof raw.source.server === "string" ? raw.source.server : "" },
    feeds: raw.feeds as VideoFeedsBundle["feeds"],
    ...(ports ? { ports } : {}),
  };
}

// ── Export ──────────────────────────────────────────────────────────────────

export interface ExportOptions {
  /** Feed ids to export; null means every feed. */
  feeds: string[] | null;
  ports: boolean;
  passwords: boolean;
}

/** `?feeds=a,b`: the ids to export, null for every feed. A refusal names the reason. */
export function parseFeedIds(
  raw: string | null,
  localIds: ReadonlySet<string>,
): { ok: true; ids: string[] | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, ids: null };
  const ids = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (ids.length === 0) return { ok: false, error: "feeds names no feed; leave it out to export every feed." };
  const unknown = ids.filter((id) => !localIds.has(id));
  if (unknown.length) {
    return { ok: false, error: `No such feed: ${unknown.slice(0, 5).map((id) => id.slice(0, 40)).join(", ")}.` };
  }
  return { ok: true, ids: [...new Set(ids)] };
}

/**
 * The export file. A password is read from `readPassword` (the stored secret) and
 * only for a pull or push feed that has one; nothing is ever minted here.
 */
export async function buildVideoBundle(
  file: VideoFeedsFile,
  options: ExportOptions,
  readPassword: (feedId: string) => Promise<string | undefined>,
): Promise<VideoFeedsBundle> {
  const wanted = options.feeds ? new Set(options.feeds) : null;
  const feeds: VideoFeedsBundle["feeds"] = [];
  for (const f of file.feeds) {
    if (wanted && !wanted.has(f.id)) continue;
    const entry: VideoFeedsBundle["feeds"][number] = { id: f.id, name: f.name, source: f.source };
    if (options.passwords && (f.source.kind === "pull" || f.source.kind === "push")) {
      const password = await readPassword(f.id);
      if (password) entry.password = password;
    }
    feeds.push(entry);
  }
  const settings = await settingsStore.load();
  return {
    kind: VIDEO_FEEDS_BUNDLE_KIND,
    version: 1,
    appVersion: appVersion(),
    createdAt: new Date().toISOString(),
    source: { server: settings.appName || "Stage Utility" },
    feeds,
    ...(options.ports ? { ports: file.ports } : {}),
  };
}

// ── Import: one comparison for the review and the write ──────────────────────

/** One file feed, compared with what is here. `parsed` is set unless invalid. */
export interface FeedPlan {
  preview: ImportFeedPreview;
  parsed?: { name: string; source: VideoSource; password?: string };
}

function sourceDifferences(here: VideoSource, file: VideoSource): FeedDifference[] {
  if (here.kind !== file.kind) return [{ field: "kind", here: here.kind, file: file.kind }];
  const out: FeedDifference[] = [];
  const diff = (field: FeedDifference["field"], a: string, b: string): void => {
    if (a !== b) out.push({ field, here: a, file: b });
  };
  if (here.kind === "pull" && file.kind === "pull") {
    diff("url", here.url, file.url);
    diff("username", here.username, file.username);
  } else if (here.kind === "push" && file.kind === "push") {
    diff("protocol", here.protocol, file.protocol);
  } else if (here.kind === "embed" && file.kind === "embed") {
    diff("player", here.player, file.player);
    diff("ref", here.ref, file.ref);
  } else if (here.kind === "external" && file.kind === "external") {
    diff("url", here.url, file.url);
  }
  return out;
}

/** The password this file carries for a feed, or why it cannot be used. Only a
 *  pull or push feed has one; on any other kind it is ignored. */
function filePassword(
  entry: Record<string, unknown>,
  parsed: { source: VideoSource; password?: string },
): { ok: true; password?: string } | { ok: false; error: string } {
  const kind = parsed.source.kind;
  if (kind !== "pull" && kind !== "push") return { ok: true };
  if (entry.password === undefined) return { ok: true };
  if (typeof entry.password !== "string") return { ok: false, error: "The password must be text." };
  if (entry.password === "") return { ok: true };
  if (kind === "pull") return { ok: true, password: parsed.password };
  if (!PUSH_PASSWORD_FORMAT.test(entry.password)) {
    return { ok: false, error: "The publish password in the file is not one this server accepts." };
  }
  return { ok: true, password: entry.password };
}

/** Every feed in the file, classified against `here`. */
export async function planImport(
  bundle: VideoFeedsBundle,
  here: VideoFeed[],
  readPassword: (feedId: string) => Promise<string | undefined>,
  kinds: ReadonlySet<VideoSourceKind>,
): Promise<FeedPlan[]> {
  const local = new Map(here.map((f) => [f.id, f]));
  const plans: FeedPlan[] = [];
  for (const entry of bundle.feeds as unknown as Record<string, unknown>[]) {
    const id = entry.id as string;
    const source = isRecord(entry.source) ? entry.source : null;
    const rawKind = source && typeof source.kind === "string" ? source.kind : "unknown";
    const label = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id;
    const invalid = (error: string): FeedPlan => ({
      preview: { id, name: label, kind: rawKind, status: "invalid", differences: [], error },
    });

    const parsed = parseFeedInput(entry, kinds);
    if (!parsed.ok) {
      plans.push(invalid(parsed.error));
      continue;
    }
    const pw = filePassword(entry, parsed);
    if (!pw.ok) {
      plans.push(invalid(pw.error));
      continue;
    }

    const base = {
      id,
      name: parsed.name,
      kind: parsed.source.kind as string,
      ...(pw.password !== undefined ? { filePassword: true } : {}),
    };
    const parsedOut = { name: parsed.name, source: parsed.source, ...(pw.password !== undefined ? { password: pw.password } : {}) };
    const existing = local.get(id);
    if (!existing) {
      plans.push({ preview: { ...base, status: "new", differences: [] }, parsed: parsedOut });
      continue;
    }

    const differences: FeedDifference[] = [];
    if (existing.name !== parsed.name) differences.push({ field: "name", here: existing.name, file: parsed.name });
    differences.push(...sourceDifferences(existing.source, parsed.source));
    // Only a password the file carries is compared, against the stored one, and
    // the difference names neither value.
    if (pw.password !== undefined && pw.password !== (await readPassword(id))) differences.push({ field: "password" });
    plans.push({
      preview: { ...base, status: differences.length ? "differs" : "same", differences },
      parsed: parsedOut,
    });
  }
  return plans;
}

export function samePorts(a: VideoPorts, b: VideoPorts): boolean {
  return PORT_KEYS.every((k) => a[k] === b[k]);
}

export function buildPreview(bundle: VideoFeedsBundle, plans: FeedPlan[], here: VideoFeedsFile): ImportPreview {
  const inFile = new Set(bundle.feeds.map((f) => f.id));
  return {
    server: bundle.source.server,
    createdAt: bundle.createdAt,
    hasPasswords: plans.some((p) => p.preview.filePassword),
    feeds: plans.map((p) => p.preview),
    absent: here.feeds.filter((f) => !inFile.has(f.id)).map((f) => f.name),
    ...(bundle.ports ? { ports: { file: bundle.ports, here: here.ports, same: samePorts(bundle.ports, here.ports) } } : {}),
  };
}

