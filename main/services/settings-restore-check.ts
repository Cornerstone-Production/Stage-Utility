// settings-restore-check.ts — what a config restore may put in settings.json.
//
// settings.json is written by some thirty routes, each patching its own keys,
// so its check is a table with one entry per key of SettingsData. The table's
// type demands an entry for every key, so a key added to the settings without a
// rule here does not compile. Each entry applies what that key's setter applies
// on a save, through the same function (settings-rules.ts and the modules it
// names), clamping where the setter clamps. A key the table does not have is
// one no code reads: it is dropped, and the drop is logged.
//
// Not checked here, because a restore cannot: whether a service type or plan id
// exists in Planning Center (the setters ask PCO), whether a branding image a
// key refers to is on this box (the images ride in the same bundle), whether a
// screen's message groups exist (they are messaging.json's), and whether a
// screen's address has since become a built-in page (the start-up migration
// renames one that has, and says so).

import { isRotation, isVideoMode } from "../types/output-format.js";
import { isUpdateMode } from "../types/state.js";
import { isStorableTextSize } from "../types/text-size.js";
import { isDisplayKind } from "../types/views.js";
import { ICON_IMAGE_KEYS, iconPngProblem, parseCrop, type IconImageField } from "./app-icon.js";
import { isValidTimeZone } from "./app-timezone.js";
import { brandingImageProblem, looksLikeStoredRef } from "./branding-image-store.js";
import { SLUG_PATTERN, isReservedSlug, validateSlug } from "./reserved-slugs.js";
import {
  asArray,
  asObject,
  checked,
  optional,
  refuse,
  required,
  safeKeys,
  textList,
  textOrNull,
  uniqueIds,
} from "./restore-check.js";
import { isSafeKey } from "./safe-key.js";
import { scrub } from "./scrub.js";
import type { SettingsData } from "./settings-store.js";
import {
  CAPTION_COLOR,
  ICON_COLOR,
  ICON_GLYPH,
  MAX_TESTIMONY_KEYWORD,
  RECONNECT_RANGES,
  TAPER_RANGES,
  clampAutoUpdateDay,
  clampAutoUpdateHour,
  clampFields,
  clampMeterRate,
  clampOscFeedbackPort,
  clampSchedule,
  isHex6,
  isHttpBaseUrl,
  isIconKey,
  normalizeBaseUrl,
  normalizeCaptionColor,
} from "./settings-rules.js";

type KeyCheck = (value: unknown, key: string) => unknown;

/** Only `fields` of `o`, as the routes copy only the fields they know. */
function pick(o: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((f) => Object.hasOwn(o, f)).map((f) => [f, o[f]]));
}

const bool: KeyCheck = (v, k) => {
  required(v, "boolean", k);
  return v;
};

const text: KeyCheck = (v, k) => {
  textOrNull(v, k);
  return v;
};

const texts: KeyCheck = (v, k) => textList(v, k);

const oneOf =
  (...allowed: string[]): KeyCheck =>
  (v, k) => {
    if (!allowed.includes(v as string)) refuse(`${k} must be one of ${allowed.join(", ")}`);
    return v;
  };

const number = (v: unknown, k: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) refuse(`${k} must be a number`);
  return v;
};

/** POST /api/branding: brandingImageProblem, with a stored reference allowed
 *  on every key, because settings.json holds one once an image is saved. */
const image: KeyCheck = (v, k) => {
  const problem = brandingImageProblem(v, true);
  if (problem) refuse(`${k} ${problem}`);
  return v;
};

/**
 * One of the icon's images, as parseAppIcon takes it and the settings store
 * keeps it: a stored image (what a saved icon becomes), or a PNG of the exact
 * size it is served at. That the five come as a set is checked across keys,
 * in iconSetProblem.
 */
const iconImage =
  (field: IconImageField): KeyCheck =>
  (v, k) => {
    if (v === null || looksLikeStoredRef(v)) return v;
    const problem = iconPngProblem(field, v, k);
    if (problem) refuse(problem);
    return v;
  };

/** parseAppIcon takes a whole icon or none: all five images, or no image. */
function iconSetProblem(settings: Record<string, unknown>): string | null {
  const keys = Object.values(ICON_IMAGE_KEYS);
  const set = keys.filter((key) => settings[key] !== undefined && settings[key] !== null);
  return set.length === 0 || set.length === keys.length ? null : `the app icon has ${set.join(", ")} but not all of ${keys.join(", ")}`;
}

/** POST /api/branding reads a crop with parseCrop, which makes a bad one null. */
const crop: KeyCheck = (v) => (v === null ? null : parseCrop(v));

const hex6: KeyCheck = (v, k) => {
  if (!isHex6(v)) refuse(`${k} must be a #rrggbb hex`);
  return v;
};

/** setIconColor / setIconGlyph: writeIconEntry's key rule and the setter's value rule. */
const iconMap =
  (valueRule: RegExp, what: string): KeyCheck =>
  (v, k) => {
    for (const [key, value] of Object.entries(asObject(v, k))) {
      if (!isIconKey(key)) refuse(`${k} has a key that is not an id or a tool path`);
      if (typeof value !== "string" || !valueRule.test(value)) refuse(`${k}.${key} must be ${what}`);
    }
    return v;
  };

/** setCaptionChannelColor: a channel name and CAPTION_COLOR, stored with its `#`. */
const captionColors: KeyCheck = (v, k) => {
  const map = asObject(v, k);
  safeKeys(map, k);
  return Object.fromEntries(
    Object.entries(map).map(([channel, c]) => {
      if (typeof c !== "string" || !CAPTION_COLOR.test(c.trim())) refuse(`${k}.${channel} must be a hex colour`);
      return [channel, normalizeCaptionColor(c)];
    }),
  );
};

/** Every other screen's address. */
function addressesBesides(list: readonly Record<string, unknown>[], self: Record<string, unknown>): string[] {
  return list
    .filter((other) => other !== self)
    .map((other) => (typeof other.slug === "string" ? other.slug.trim().toLowerCase() : ""))
    .filter((s) => s !== "");
}

/** An output id: what the allocator and every older build gave one. */
const OUTPUT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The screens, as the Outputs routes keep them: a unique id of the allocator's
 * shape, a name, an address held to validateSlug against every other screen's
 * id and address and stored as setOutputSlug stores it (trimmed, lowercased,
 * absent when empty), and each per-screen setting held to its setter's rule.
 * Two validateSlug refusals are let through. An address that has since become
 * a built-in page: the start-up migration renames it and logs it. An address
 * equal only to another screen's id: addOutput once minted ids without looking
 * at addresses, so a real install can hold one, and the start-up migration
 * leaves it as it is. It is logged here, at start-up and on a restore.
 */
const outputs: KeyCheck = (v, k) => {
  const list = asArray(v, k).map((entry, i) => asObject(entry, `screen ${i + 1}`));
  const out = list.map((o, i) => {
    const what = `screen "${typeof o.name === "string" ? o.name.slice(0, 40) : i + 1}"`;
    required(o.id, "string", `${what}'s id`);
    if (!OUTPUT_ID.test(o.id as string) || !isSafeKey(o.id as string)) refuse(`${what}'s id is not allowed`);
    required(o.name, "string", `${what}'s name`);
    optional(o.slug, "string", `${what}'s address`);
    const slug = typeof o.slug === "string" ? o.slug.trim().toLowerCase() : "";
    if (slug) {
      const addresses = addressesBesides(list, o);
      const idOf = list.find((other) => other !== o && typeof other.id === "string" && other.id.toLowerCase() === slug);
      const builtInOnly = SLUG_PATTERN.test(slug) && isReservedSlug(slug) && !addresses.includes(slug);
      // Held to the other addresses alone: the ids are checked below, with the
      // collision logged rather than refused.
      const verdict = validateSlug(slug, addresses);
      if (!verdict.ok && !builtInOnly) refuse(`${what}'s address: ${verdict.reason}`);
      if (idOf) {
        console.warn(
          `[config-snapshot] settings.json: ${scrub(what)}'s address /${scrub(slug)} is also the id of screen "${scrub(String(idOf.name ?? idOf.id))}"; kept as it is. Change one screen's address in Screens.`,
        );
      }
    }
    textOrNull(o.viewId, `${what}'s view`);
    for (const f of ["blackout", "locked", "hideTopBar", "allowHls"]) optional(o[f], "boolean", `${what}'s ${f}`);
    if (o.groups !== undefined) textList(o.groups, `${what}'s message groups`);
    if (o.textSize !== undefined && !isStorableTextSize(o.textSize)) refuse(`${what}'s text size is not one a screen takes`);
    if (o.rotation !== undefined && !isRotation(o.rotation)) refuse(`${what}'s rotation is not one a screen takes`);
    if (o.videoMode !== undefined && !isVideoMode(o.videoMode)) refuse(`${what}'s video mode is not one a screen takes`);
    const { slug: _slug, ...rest } = o;
    return slug ? { ...rest, slug } : rest;
  });
  uniqueIds(out, "the screens");
  return out;
};

/**
 * The legacy per-display list. Read once, on the first start with no screens,
 * and turned into views and screens, so it is held to the rules those have:
 * an id that is a safe key, a name, a kind the app has, an NDI source that is
 * text or null. Every settings.json still carries the default one.
 */
const displays: KeyCheck = (v, k) => {
  const list = asArray(v, k).map((entry, i) => {
    const what = `legacy display ${i + 1}`;
    const d = asObject(entry, what);
    required(d.id, "string", `${what}'s id`);
    if (!isSafeKey(d.id as string)) refuse(`${what}'s id is not allowed`);
    required(d.name, "string", `${what}'s name`);
    if (d.kind !== undefined && !isDisplayKind(d.kind)) refuse(`${what} has a kind this app does not have`);
    textOrNull(d.ndiSource, `${what}'s NDI source`);
    return d;
  });
  uniqueIds(list, "the legacy displays");
  return list;
};

/**
 * POST /api/integrations/:id/config, through the save's own foldConfigEntries:
 * a key of the shape config keys have, and never a credential, which that route
 * puts in secrets.bin and a restore cannot write. What it drops it logs, as on
 * a save. Imported lazily: integration-manager imports the settings store.
 */
const integrationConfigs: KeyCheck = async (v, k) => {
  const all = asObject(v, k);
  safeKeys(all, k);
  const { foldConfigEntries, secretKeysFor } = await import("./integration-manager.js");
  return Object.fromEntries(
    Object.entries(all).map(([id, config]) => [
      id,
      { ...foldConfigEntries(asObject(config, `${k}.${id}`), secretKeysFor(id), id).config },
    ]),
  );
};

const integrationEnabled: KeyCheck = (v, k) => {
  const map = asObject(v, k);
  safeKeys(map, k);
  for (const [id, on] of Object.entries(map)) required(on, "boolean", `${k}.${id}`);
  return v;
};

/** setBaptismAutoStart: a boolean, and a keyword cut to MAX_TESTIMONY_KEYWORD. */
const baptismAutoStart: KeyCheck = (v, k) => {
  const b = pick(asObject(v, k), ["enabled", "testimonyKeyword"]);
  optional(b.enabled, "boolean", `${k}.enabled`);
  optional(b.testimonyKeyword, "string", `${k}.testimonyKeyword`);
  return typeof b.testimonyKeyword === "string" ? { ...b, testimonyKeyword: b.testimonyKeyword.slice(0, MAX_TESTIMONY_KEYWORD) } : b;
};

/** POST /api/update/auto through setAutoUpdate's clamps. */
const autoUpdate: KeyCheck = (v, k) => {
  // `enabled` is the pre-mode flag, kept so migrateAutoUpdate can read an old backup.
  const a = pick(asObject(v, k), ["mode", "enabled", "dayOfWeek", "hour"]);
  if (a.mode !== undefined && !isUpdateMode(a.mode)) refuse(`${k}.mode is not an update mode`);
  optional(a.enabled, "boolean", `${k}.enabled`);
  const out: Record<string, unknown> = { ...a };
  if (a.hour !== undefined) out.hour = clampAutoUpdateHour(number(a.hour, `${k}.hour`));
  if (a.dayOfWeek !== undefined) out.dayOfWeek = clampAutoUpdateDay(a.dayOfWeek === null ? null : number(a.dayOfWeek, `${k}.dayOfWeek`));
  return out;
};

/** An object whose numeric fields a setter rounds and clamps (clampFields). */
const clampedFields =
  (ranges: Record<string, readonly [number, number]>, flags: string[] = []): KeyCheck =>
  (v, k) => {
    const o = pick(asObject(v, k), [...flags, ...Object.keys(ranges)]);
    for (const f of flags) optional(o[f], "boolean", `${k}.${f}`);
    for (const f of Object.keys(ranges)) if (o[f] !== undefined) number(o[f], `${k}.${f}`);
    return clampFields(o, ranges);
  };

/** POST /api/backup/schedule through clampSchedule. */
const backupSchedule: KeyCheck = (v, k) => {
  const o = pick(asObject(v, k), ["enabled", "includeArchive", "intervalDays", "keep", "destination", "lastRunAt", "lastError"]);
  for (const f of ["enabled", "includeArchive"]) optional(o[f], "boolean", `${k}.${f}`);
  for (const f of ["intervalDays", "keep"]) if (o[f] !== undefined) number(o[f], `${k}.${f}`);
  optional(o.destination, "string", `${k}.destination`);
  // What runNow writes after a run: an ISO time, and the failure's message.
  if (o.lastRunAt !== undefined && o.lastRunAt !== null && !(typeof o.lastRunAt === "string" && !Number.isNaN(Date.parse(o.lastRunAt)))) {
    refuse(`${k}.lastRunAt must be a time or null`);
  }
  textOrNull(o.lastError, `${k}.lastError`);
  return clampSchedule(o);
};

/**
 * setPublicUrl: normalizeBaseUrl, and only an http or https address. One that
 * does not parse is restored as null and logged rather than refused: builds
 * before 1.27.0 saved whatever normalizeBaseUrl returned, so a real backup can
 * hold "http://stage box", and refusing it refused the whole restore.
 */
const publicUrl: KeyCheck = (v, k) => {
  textOrNull(v, k);
  const normalized = normalizeBaseUrl((v ?? null) as string | null);
  if (normalized !== null && !isHttpBaseUrl(normalized)) {
    console.warn(`[config-snapshot] settings.json: ${scrub(k)} "${scrub(normalized)}" is not an http or https address; restored as none`);
    return null;
  }
  return normalized;
};

const timezone: KeyCheck = (v, k) => {
  if (v !== null && !(typeof v === "string" && isValidTimeZone(v))) refuse(`${k} is not a time zone`);
  return v;
};

/** The id high-water marks: mergeIdFloors in config-snapshot reads each one
 *  and drops, with a log line, any that is not a number. */
const idFloors: KeyCheck = (v, k) => asObject(v, k);

const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minted by the server (randomUUID) and never rewritten; a restore carries it
 *  so a replacement box keeps the devices bound to the old one. */
const serverId: KeyCheck = (v, k) => {
  if (v !== null && !(typeof v === "string" && SERVER_ID.test(v))) refuse(`${k} must be a server id or null`);
  return v;
};

/** No setter: a UDP port, only ever hand-edited. */
const kioskDiscoveryPort: KeyCheck = (v, k) => {
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 65535) refuse(`${k} must be a port from 1 to 65535`);
  return v;
};

/**
 * Every settings key, and what a restore holds it to. The three migration
 * flags (layoutDefaultsCleaned, cardHairlineRaised, screenRolesFromView) are
 * restored with the backup's views.json, which they describe: a backup taken
 * after a pass carries views that pass already changed, and dropping the flag
 * would run it again over them (the first of those passes, run twice, took the
 * operator's own alignment away). A backup from before a pass has no flag, and
 * the pass runs on its views at the next start, as it should.
 */
const KEYS: { [K in keyof Required<SettingsData>]: KeyCheck } = {
  // Branding
  appName: (v, k) => {
    required(v, "string", k);
    return (v as string).trim() || "Stage Utility";
  },
  accentColor: (v, k) => (v === null ? null : hex6(v, k)),
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
  appIcon: iconImage("art"),
  appIconOriginal: image,
  appIconCrop: crop,
  appIconApple: iconImage("apple"),
  appIcon192: iconImage("any192"),
  appIcon512: iconImage("any512"),
  appIconMaskable: iconImage("maskable"),
  appIconBackground: hex6,
  // Display settings
  showQr: bool,
  kioskDiscovery: bool,
  kioskDiscoveryPort,
  autoUpdateMachines: bool,
  onboardingDismissed: bool,
  ndiEnabled: bool,
  followProdcomColors: bool,
  baptismAutoStart,
  baptismDefaultMode: oneOf("per-person", "grouped"),
  publicUrl,
  iconColors: iconMap(ICON_COLOR, 'a "#rrggbb" colour'),
  iconGlyphs: iconMap(ICON_GLYPH, "a glyph name"),
  captionChannelColors: captionColors,
  // Plans and service types
  planSwitcherMode: oneOf("within-type", "upcoming"),
  planMode: oneOf("auto", "manual"),
  allowedServiceTypeIds: texts,
  serviceTypeId: text,
  serviceTypeName: text,
  planId: text,
  planTitle: text,
  planSeriesTitle: text,
  planDates: text,
  // System
  autoUpdate,
  reconnectSchedule: clampedFields(RECONNECT_RANGES, ["enabled"]),
  taperWindow: clampedFields(TAPER_RANGES),
  checklistNoteCategories: texts,
  checklistNoteTeams: texts,
  timezone,
  hourCycle: oneOf("12h", "24h"),
  backupSchedule,
  serverId,
  idFloors,
  // Screens and integrations
  outputs,
  displays,
  integrationConfigs,
  integrationEnabled,
  splVisibleMetrics: texts,
  splTrendShown: bool,
  splTrendMetric: text,
  oscFeedbackPort: (v, k) => clampOscFeedbackPort(number(v, k)),
  wirelessMeterRateMs: (v, k) => clampMeterRate(number(v, k)),
  // Start-up migrations that have run: see above.
  layoutDefaultsCleaned: bool,
  cardHairlineRaised: bool,
  screenRolesFromView: bool,
};

/** The keys the table checks, sorted: for the test that pins it. */
export const CHECKED_SETTINGS_KEYS = Object.keys(KEYS).sort();

export const settingsRestoreCheck = checked(async (raw) => {
  const settings = asObject(raw, "the settings");
  safeKeys(settings, "the settings");
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (!Object.hasOwn(KEYS, key)) {
      dropped.push(key);
      continue;
    }
    out[key] = await KEYS[key as keyof SettingsData](value, key);
  }
  const iconProblem = iconSetProblem(out);
  if (iconProblem) refuse(iconProblem);
  if (dropped.length > 0) {
    console.warn(`[config-snapshot] settings.json: dropped ${scrub(dropped.length)} key(s) this build does not read: ${scrub(dropped.join(", "), 400)}`);
  }
  return out;
});
