// settings-restore-check.ts — what a config restore may put in settings.json.
//
// settings.json is written by some thirty routes, each patching its own keys,
// so its check is a table: one entry per key, applying what that key's route
// applies on a save. A key that is not in the table (one this build does not
// know, or one only the server writes) passes as it is. The routes' clamps are
// applied as clamps, so a value a route would have clamped is clamped here too
// rather than refused.
//
// Not checked here, because a restore cannot: whether a service type or plan id
// exists in Planning Center (the routes ask PCO), whether a stored branding
// image is on this box (the images ride in the same bundle), and whether an
// output's slug is reserved (the boot migration renames one that is).

import { isRotation, isVideoMode } from "../types/output-format.js";
import { isStorableTextSize } from "../types/text-size.js";
import { isValidTimeZone } from "./app-timezone.js";
import { looksLikeStoredRef } from "./branding-image-store.js";
import { clamp } from "./clamp.js";
import { asArray, asObject, checked, optional, refuse, required, safeKeys } from "./restore-check.js";

type KeyCheck = (value: unknown, key: string) => unknown | Promise<unknown>;

const bool: KeyCheck = (v, k) => {
  required(v, "boolean", k);
  return v;
};

const oneOf =
  (...allowed: string[]): KeyCheck =>
  (v, k) => {
    if (!allowed.includes(v as string)) refuse(`${k} must be one of ${allowed.join(", ")}`);
    return v;
  };

const textOrNull: KeyCheck = (v, k) => {
  if (v !== null && typeof v !== "string") refuse(`${k} must be text or null`);
  return v;
};

const textList: KeyCheck = (v, k) => {
  if (!asArray(v, k).every((s) => typeof s === "string")) refuse(`${k} must be a list of text`);
  return v;
};

/** A number the route clamps into [lo, hi]. */
const clamped =
  (lo: number, hi: number): KeyCheck =>
  (v, k) => {
    if (typeof v !== "number" || !Number.isFinite(v)) refuse(`${k} must be a number`);
    return clamp(v, lo, hi);
  };

/** POST /api/branding's validateImage: null, an image data URL of at most
 *  ~1.5 MB, or a stored branding image. */
const image: KeyCheck = (v, k) => {
  if (v === null || looksLikeStoredRef(v)) return v;
  if (typeof v !== "string" || !v.startsWith("data:image/")) refuse(`${k} must be an image or null`);
  if (v.length > 2_000_000) refuse(`${k} is too large (max ~1.5 MB)`);
  return v;
};

const crop: KeyCheck = (v, k) => {
  if (v === null) return v;
  const c = asObject(v, k);
  for (const f of ["scale", "x", "y"]) required(c[f], "number", `${k}.${f}`);
  return v;
};

/** POST /api/icon-colors and /api/icon-glyphs: writeIconEntry's key rule and
 *  each route's value rule. */
const iconMap =
  (valueRule: RegExp, what: string): KeyCheck =>
  (v, k) => {
    const map = asObject(v, k);
    for (const [key, value] of Object.entries(map)) {
      if (!/^[A-Za-z0-9/_-]{1,64}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) {
        refuse(`${k} has a key that is not an id or a tool path`);
      }
      if (typeof value !== "string" || !valueRule.test(value)) refuse(`${k}.${key} must be ${what}`);
    }
    return v;
  };

/** setCaptionChannelColor: a channel name and a hex colour. */
const captionColors: KeyCheck = (v, k) => {
  const map = asObject(v, k);
  safeKeys(map, k);
  for (const [channel, c] of Object.entries(map)) {
    if (typeof c !== "string" || !/^#?[0-9a-f]{3,8}$/i.test(c)) refuse(`${k}.${channel} must be a hex colour`);
  }
  return v;
};

/** The Outputs routes, field by field: a name, the view shown, and the
 *  per-screen settings each with the rule its own route applies. */
const outputs: KeyCheck = (v, k) =>
  asArray(v, k).map((entry, i) => {
    const o = asObject(entry, `screen ${i + 1}`);
    const what = `screen "${typeof o.name === "string" ? o.name.slice(0, 40) : i + 1}"`;
    required(o.id, "string", `${what}'s id`);
    required(o.name, "string", `${what}'s name`);
    optional(o.slug, "string", `${what}'s address`);
    if (o.viewId !== undefined) textOrNull(o.viewId, `${what}'s view`);
    for (const f of ["blackout", "locked", "hideTopBar", "allowHls"]) optional(o[f], "boolean", `${what}'s ${f}`);
    if (o.groups !== undefined) textList(o.groups, `${what}'s message groups`);
    if (o.textSize !== undefined && !isStorableTextSize(o.textSize)) refuse(`${what}'s text size is not one a screen takes`);
    if (o.rotation !== undefined && !isRotation(o.rotation)) refuse(`${what}'s rotation is not one a screen takes`);
    if (o.videoMode !== undefined && !isVideoMode(o.videoMode)) refuse(`${what}'s video mode is not one a screen takes`);
    return o;
  });

/**
 * POST /api/integrations/:id/config, through foldConfigEntries' rules: a key
 * of the shape config keys have, and never a credential, which that route puts
 * in secrets.bin and a restore cannot write. A key either rule drops is
 * dropped here too, as the route drops it.
 */
const integrationConfigs: KeyCheck = async (v, k) => {
  const all = asObject(v, k);
  safeKeys(all, k);
  // Lazily: integration-manager imports this store.
  const { secretKeysFor } = await import("./integration-manager.js");
  return Object.fromEntries(
    Object.entries(all).map(([id, config]) => {
      const secret = secretKeysFor(id);
      const kept = Object.entries(asObject(config, `${k}.${id}`)).filter(
        ([key]) => /^[A-Za-z][A-Za-z0-9]*$/.test(key) && key !== "constructor" && key !== "prototype" && !secret.includes(key),
      );
      return [id, Object.fromEntries(kept)];
    }),
  );
};

const integrationEnabled: KeyCheck = (v, k) => {
  const map = asObject(v, k);
  safeKeys(map, k);
  for (const [id, on] of Object.entries(map)) required(on, "boolean", `${k}.${id}`);
  return v;
};

/** POST /api/baptism/auto-start: a boolean, and a keyword cut to 80. */
const baptismAutoStart: KeyCheck = (v, k) => {
  const b = asObject(v, k);
  optional(b.enabled, "boolean", `${k}.enabled`);
  optional(b.testimonyKeyword, "string", `${k}.testimonyKeyword`);
  return typeof b.testimonyKeyword === "string" ? { ...b, testimonyKeyword: b.testimonyKeyword.slice(0, 80) } : b;
};

/** POST /api/auto-update: the mode, the day and the hour, clamped as there. */
const autoUpdate: KeyCheck = (v, k) => {
  const a = asObject(v, k);
  if (a.mode !== undefined) oneOf("manual", "auto-install", "auto-full")(a.mode, `${k}.mode`);
  optional(a.enabled, "boolean", `${k}.enabled`);
  const out: Record<string, unknown> = { ...a };
  if (a.hour !== undefined) out.hour = clamped(0, 23)(a.hour, `${k}.hour`);
  if (a.dayOfWeek !== undefined && a.dayOfWeek !== null) out.dayOfWeek = clamped(0, 6)(a.dayOfWeek, `${k}.dayOfWeek`);
  return out;
};

/** An object whose numeric fields the route clamps, each into its own range. */
const clampedFields =
  (ranges: Record<string, [number, number]>, flags: string[] = []): KeyCheck =>
  async (v, k) => {
    const o = asObject(v, k);
    const out: Record<string, unknown> = { ...o };
    for (const f of flags) optional(o[f], "boolean", `${k}.${f}`);
    for (const [f, [lo, hi]] of Object.entries(ranges)) {
      if (o[f] !== undefined) out[f] = await clamped(lo, hi)(o[f], `${k}.${f}`);
    }
    return out;
  };

/** POST /api/backup/schedule, through clampSchedule. */
const backupSchedule: KeyCheck = async (v, k) => {
  const out = (await clampedFields({ intervalDays: [1, 365], keep: [1, 100] }, ["enabled", "includeArchive"])(v, k)) as Record<
    string,
    unknown
  >;
  optional(out.destination, "string", `${k}.destination`);
  if (typeof out.destination === "string") out.destination = out.destination.trim();
  return out;
};

/** Every key a settings route writes, with what that route applies. */
const KEYS: Record<string, KeyCheck> = {
  // Branding
  appName: (v, k) => {
    required(v, "string", k);
    return (v as string).trim() || "Stage Utility";
  },
  accentColor: (v, k) => {
    if (v !== null && !(typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v))) refuse(`${k} must be a #rrggbb hex or null`);
    return v;
  },
  appLogo: image,
  appLogoOriginal: image,
  appLogoCrop: crop,
  appLogoMonochrome: bool,
  emptySlotLogo: image,
  emptySlotLogoOriginal: image,
  emptySlotLogoCrop: crop,
  defaultAvatar: image,
  defaultAvatarOriginal: image,
  defaultAvatarCrop: crop,
  appIcon: image,
  appIconOriginal: image,
  appIconCrop: crop,
  appIconApple: image,
  appIcon192: image,
  appIcon512: image,
  appIconMaskable: image,
  appIconBackground: (v, k) => {
    if (!(typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v))) refuse(`${k} must be a #rrggbb hex`);
    return v;
  },
  // Display settings
  showQr: bool,
  kioskDiscovery: bool,
  autoUpdateMachines: bool,
  onboardingDismissed: bool,
  ndiEnabled: bool,
  followProdcomColors: bool,
  baptismAutoStart,
  publicUrl: textOrNull,
  iconColors: iconMap(/^(#[0-9a-f]{6})?$/, 'a "#rrggbb" colour'),
  iconGlyphs: iconMap(/^([A-Za-z][A-Za-z0-9]{0,63})?$/, "a glyph name"),
  captionChannelColors: captionColors,
  // Plans and service types
  planSwitcherMode: oneOf("within-type", "upcoming"),
  planMode: oneOf("auto", "manual"),
  allowedServiceTypeIds: textList,
  serviceTypeId: textOrNull,
  serviceTypeName: textOrNull,
  planId: textOrNull,
  planTitle: textOrNull,
  planSeriesTitle: textOrNull,
  planDates: textOrNull,
  // System
  autoUpdate,
  reconnectSchedule: clampedFields({ leadMin: [0, 1440], tailMin: [0, 1440], dormantMin: [1, 1440] }, ["enabled"]),
  taperWindow: clampedFields({ preMin: [0, 240], postMin: [0, 240] }),
  checklistNoteCategories: textList,
  checklistNoteTeams: textList,
  timezone: (v, k) => {
    if (v !== null && !(typeof v === "string" && isValidTimeZone(v))) refuse(`${k} is not a time zone`);
    return v;
  },
  hourCycle: oneOf("12h", "24h"),
  backupSchedule,
  // Screens and integrations
  outputs,
  integrationConfigs,
  integrationEnabled,
  splVisibleMetrics: textList,
  splTrendShown: bool,
  splTrendMetric: textOrNull,
  oscFeedbackPort: (v, k) => clamped(1, 65535)(typeof v === "number" ? Math.floor(v) : v, k),
  // POST /api/wireless/meter-rate, floored at the manager's minimum. Lazily:
  // the wireless manager imports this store.
  wirelessMeterRateMs: async (v, k) => {
    const { MIN_METER_RATE_MS } = await import("./wireless-manager.js");
    return clamped(MIN_METER_RATE_MS, Number.MAX_SAFE_INTEGER)(v, k);
  },
};

/** The keys the table checks, sorted: for the test that pins it. */
export const CHECKED_SETTINGS_KEYS = Object.keys(KEYS).sort();

export const settingsRestoreCheck = checked(async (raw) => {
  const settings = asObject(raw, "the settings");
  safeKeys(settings, "the settings");
  const out: Record<string, unknown> = { ...settings };
  for (const [key, value] of Object.entries(settings)) {
    // Absent and undefined are the same to every route; JSON has no undefined.
    if (!Object.hasOwn(KEYS, key)) continue;
    out[key] = await KEYS[key](value, key);
  }
  return out;
});
