// validate.ts — what a publish body must be before anything stores it.
//
// Every function takes what was parsed and returns the value to use or the reason
// it is refused, which the caller turns into a 400, or a 413 where the reason is size.
// None throws: a refusal is an answer, not a failure of this code.

import {
  ASSET_PATH_PREFIX,
  FRAME_DOCS,
  PUBLISH_MAX_BODY_BYTES,
  PUBLISH_MAX_VERSION_LENGTH,
  filterPublicState,
  isAssetName,
  isDocKey,
  isFrameChannel,
  isRecord,
  type FixedDocKey,
  type PublicState,
} from "../../../main/types/servicecue-publish.js";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; status: 400 | 413 };

const refuse = (error: string, status: 400 | 413 = 400): { ok: false; error: string; status: 400 | 413 } => ({ ok: false, error, status });

/** The most entries a manifest may list of either kind. A rundown per plan per service type stays far under it. */
export const MANIFEST_MAX_ENTRIES = 5000;

/** The body as UTF-8 JSON: the value, and the exact text it came from. */
export function parseJson(bytes: Uint8Array): Parsed<{ text: string; json: unknown }> {
  let text: string;
  try {
    // A BOM, if there is one, is dropped (ignoreBOM false is the default, spelled
    // out because the Workers typings ask for both options).
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return refuse("The body is not valid UTF-8");
  }
  try {
    return { ok: true, value: { text, json: JSON.parse(text) } };
  } catch (err) {
    return refuse(`The body is not JSON: ${err instanceof Error ? err.message : "it could not be parsed"}`);
  }
}

// ── The state ─────────────────────────────────────────────────────────────────

const ACCENT_COLOR = /^#[0-9a-fA-F]{6}$/;

function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Why a state cannot be shown, or null when every field it carries can. A field that
 * is there and wrong is refused rather than dropped: the page draws a clock from the
 * zone and an image from the logo, and a bad value crashes it for everyone who opens it.
 */
export function publicStateProblem(state: Partial<PublicState>): string | null {
  const nullOr = (value: unknown, ok: (v: unknown) => boolean) => value === null || ok(value);
  const checks: [keyof PublicState, string, (v: unknown) => boolean][] = [
    ["accentColor", "a #rrggbb colour or null", (v) => nullOr(v, (c) => typeof c === "string" && ACCENT_COLOR.test(c))],
    [
      "appLogo",
      `${ASSET_PATH_PREFIX}<an image name> or null`,
      (v) => nullOr(v, (l) => typeof l === "string" && l.startsWith(ASSET_PATH_PREFIX) && isAssetName(l.slice(ASSET_PATH_PREFIX.length))),
    ],
    ["appLogoMonochrome", "true or false", (v) => typeof v === "boolean"],
    ["hourCycle", '"12h" or "24h"', (v) => v === "12h" || v === "24h"],
    ["pcoConfigured", "true or false", (v) => typeof v === "boolean"],
    ["timezone", "a time zone name or null", (v) => nullOr(v, isTimeZone)],
  ];
  for (const [field, expected, valid] of checks) {
    if (Object.hasOwn(state, field) && !valid(state[field])) return `The state's ${field} must be ${expected}`;
  }
  return null;
}

// ── Docs and frames ───────────────────────────────────────────────────────────

const LIVE_DOC_KEYS: ReadonlySet<string> = new Set(FRAME_DOCS.values());

/**
 * The text of a doc that viewers also follow as a frame: the state, cut down to the
 * public fields and checked, or an object, or null (nothing live, nothing recording).
 * `label` is what a refusal calls it.
 *
 * Re-serialised, so it is measured again: `1e20` comes back as twenty-one digits, and
 * a body under the cap can stringify over what a row of storage holds.
 */
function liveDocText(key: FixedDocKey, json: unknown, label: string): Parsed<string> {
  let value = json;
  if (key === "state") {
    const state = filterPublicState(json);
    if (state === null) return refuse(`${label} must be an object`);
    const problem = publicStateProblem(state);
    if (problem !== null) return refuse(problem);
    value = state;
  } else if (json !== null && !isRecord(json)) {
    return refuse(`${label} must be an object, or null`);
  }
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > PUBLISH_MAX_BODY_BYTES) {
    return refuse(`${label} is over ${PUBLISH_MAX_BODY_BYTES} bytes once it is stored`, 413);
  }
  return { ok: true, value: text };
}

/** The text to store for a doc: as it was sent, except for the three that are frames too. */
export function docText(key: string, text: string, json: unknown): Parsed<string> {
  return LIVE_DOC_KEYS.has(key) ? liveDocText(key as FixedDocKey, json, `The ${key} doc`) : { ok: true, value: text };
}

/** A frame is a write of the doc its channel is stored as: which, and the text. */
export function frameBody(json: unknown): Parsed<{ docKey: FixedDocKey; text: string }> {
  if (!isRecord(json)) return refuse("A frame must be an object with a channel and data");
  const { channel } = json;
  if (!isFrameChannel(channel)) return refuse("The channel is not one that can be published to");
  if (!Object.hasOwn(json, "data")) return refuse("A frame must carry data");
  const docKey = FRAME_DOCS.get(channel)!;
  const text = liveDocText(docKey, json.data, `${channel} data`);
  return text.ok ? { ok: true, value: { docKey, text: text.value } } : text;
}

// ── Heartbeat and manifest ────────────────────────────────────────────────────

/** A heartbeat: when the publisher says it is, and which version it is. */
export function heartbeatBody(json: unknown): Parsed<{ sentAt: number; version: string }> {
  if (!isRecord(json)) return refuse("A heartbeat must be an object with at and version");
  const { at, version } = json;
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return refuse("at must be a time in milliseconds");
  if (typeof version !== "string" || version.length < 1 || version.length > PUBLISH_MAX_VERSION_LENGTH) {
    return refuse(`version must be a string of 1 to ${PUBLISH_MAX_VERSION_LENGTH} characters`);
  }
  return { ok: true, value: { sentAt: at, version } };
}

/** A manifest: every doc key and asset name to keep. One bad entry refuses it whole, so a typo cannot delete what it meant to keep. */
export function manifestBody(json: unknown): Parsed<{ docs: string[]; assets: string[] }> {
  if (!isRecord(json)) return refuse("A manifest must be an object with docs and assets");
  const { docs, assets } = json;
  if (!Array.isArray(docs) || !Array.isArray(assets)) return refuse("docs and assets must both be lists");
  if (docs.length > MANIFEST_MAX_ENTRIES || assets.length > MANIFEST_MAX_ENTRIES) {
    return refuse(`A manifest lists at most ${MANIFEST_MAX_ENTRIES} of each`);
  }
  const badDoc = docs.find((d) => !isDocKey(d));
  if (badDoc !== undefined) return refuse(`${JSON.stringify(badDoc)} is not a doc key`);
  const badAsset = assets.find((a) => !isAssetName(a));
  if (badAsset !== undefined) return refuse(`${JSON.stringify(badAsset)} is not an asset name`);
  return { ok: true, value: { docs: docs as string[], assets: assets as string[] } };
}
