// main/services/video/feed-store.ts — the operator's feeds. Config: backed up.

import { DataStore } from "../data-store.js";
import { asArray, asObject, checked, refuse } from "../restore-check.js";
import { DEFAULT_VIDEO_PORTS, type VideoFeedsFile } from "../../types/video.js";
import { audioFieldsOf } from "./audio-input.js";
import { FEED_ID_PATTERN } from "./feed-id.js";
import { OFFERED_KINDS, parseFeedInput } from "./feed-input.js";
import { parsePorts } from "./ports.js";

/**
 * A restored video-feeds.json, held to what adding or editing a feed takes:
 * every feed through parseFeedInput, the same call the feed routes make, with
 * an id of the pattern feed ids have and no id twice; the relay ports through
 * parsePorts, after the defaulting loadFeedsFile applies. A password is never
 * in this file (it lives in the secrets store, which a restore cannot write),
 * so one found here is dropped.
 */
const restoreCheck = checked((raw) => {
  const file = asObject(raw, "the video feeds");
  const seen = new Set<string>();
  const feeds = asArray(file.feeds ?? [], "the video feeds").map((entry, i) => {
    const feed = asObject(entry, `video feed ${i + 1}`);
    const id = feed.id;
    if (typeof id !== "string" || !FEED_ID_PATTERN.test(id)) refuse(`video feed ${i + 1} has an id this server cannot use`);
    if (seen.has(id)) refuse(`the video feed id "${id}" is listed twice`);
    seen.add(id);
    const { password: _password, ...stored } = feed;
    const parsed = parseFeedInput(stored, OFFERED_KINDS);
    if (!parsed.ok) refuse(`video feed "${id}": ${parsed.error}`);
    // The audio fields as parseFeedInput normalised them (trimmed, defaults and a
    // kind that takes none left out): the address becomes part of a command line.
    const { audioConversion: _conversion, audioSourceUrl: _audioUrl, ...rest } = stored;
    return { ...rest, name: parsed.name, source: parsed.source, ...audioFieldsOf(parsed) };
  });
  if (file.ports === undefined) return { ...file, feeds };
  const ports = parsePorts({ ...DEFAULT_VIDEO_PORTS, ...asObject(file.ports, "the relay ports") });
  if (!ports.ok) refuse(`the relay ports: ${ports.error}`);
  return { ...file, feeds, ports: ports.ports };
});

export const videoFeedsStore = new DataStore<VideoFeedsFile>(
  "video-feeds.json",
  { feeds: [], ports: DEFAULT_VIDEO_PORTS },
  "config",
  { restoreCheck },
);

/** The file with every missing field defaulted. A file written by an older build
 *  (or restored from one) has no `ports`, or only some; each gets its default. */
export async function loadFeedsFile(): Promise<VideoFeedsFile> {
  const raw = (await videoFeedsStore.load()) as Partial<VideoFeedsFile> | null;
  return {
    feeds: Array.isArray(raw?.feeds) ? raw.feeds : [],
    ports: { ...DEFAULT_VIDEO_PORTS, ...(raw?.ports ?? {}) },
  };
}
