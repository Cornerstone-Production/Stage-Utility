// Planning Center CALENDAR client (/calendar/v2), beside the /services/v2 one.
//
// A separate class, but NOT a second transport: the concurrency gate, the retry
// budget, the backoff, the auth header and the scrubbed logging all belong to
// pco-service.ts and are reached through `pcoService.requestProduct`. That
// method's docstring has the reasoning.
//
// What is local is what genuinely differs: a different base URL, a different
// query dialect, different shapes, and its own response cache (see below).

import type {
  CalendarEventDTO,
  CalendarSourceDTO,
  CalendarTagDTO,
  CalendarTagRefDTO,
  CalendarWindow,
} from "../types/calendar.js";
import type { PcoNode, PcoResponse } from "./pco-service.js";
import { nextOffset, pcoService, withOffset } from "./pco-service.js";
import { scrub } from "./scrub.js";

const CALENDAR_BASE = "https://api.planningcenteronline.com/calendar/v2";

/**
 * The Calendar API version this client is written against.
 *
 * PCO versions each product by DATE, selected with an `X-PCO-API-Version:
 * YYYY-MM-DD` header and resolved to the newest published version at or before
 * it. Send no header and the version is whatever is configured as the app's
 * default in PCO's developer console — a setting that lives outside this
 * repository, differs between installs, and is older than whatever the code was
 * written against.
 *
 * Deliberately an exact date, never a "newest" sentinel: a floating request lets
 * a PCO release change field names, defaults or pagination under a running
 * install with no change here.
 *
 * Services pins the same date, on purpose: one app, one stated contract date.
 * To bump, take the newest date from the version selector at
 * https://api.planningcenteronline.com/docs/apps/calendar, read its changelog
 * entry for field or pagination changes, then change this string.
 */
const CALENDAR_API_VERSION = "2018-11-01";

/**
 * Its own cache, not the /services/v2 client's.
 *
 * That client bounds its cache at 200 entries and evicts oldest-first. A month
 * grid browsed back and forth writes an entry per window per filter set, so
 * sharing the map would let idle calendar browsing evict the service types, plan
 * items and plan times the live path depends on — the one code path that must
 * not get slower while a service is running. Two maps cost about fifteen lines;
 * one shared map costs the live path its cache at the worst possible moment.
 */
const MAX_CACHE_ENTRIES = 200;
/** Event instances: an operator moves an event and expects to see it move. */
const TTL_EVENTS_MS = 3 * 60_000;
/** Calendars and tags: an org's vocabulary, effectively static within a session. */
const TTL_METADATA_MS = 15 * 60_000;
/**
 * How long an EMPTY answer is held.
 *
 * Not a failure TTL — a failed request throws out of these readers and never
 * reaches the cache at all. This covers the request that succeeded and returned
 * nothing, which is far more likely to be a blip than an org with no calendars,
 * and holding that for the metadata TTL would make one blip look permanent.
 */
const TTL_EMPTY_MS = 30_000;

const PER_PAGE = 100;
/** Pagination ceiling. 100 × 12 is far past the busiest month this has to draw,
 *  and a bound is what stops a malformed next-link becoming an infinite loop. */
const MAX_PAGES = 12;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** A non-empty trimmed string, or null. */
function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** `#rrggbb` lowercased, or null for anything that is not one. PCO's tag colours
 *  are real hex; anything else is not a colour we can hand to CSS. */
function hexColor(value: unknown): string | null {
  const s = trimmedOrNull(value)?.toLowerCase() ?? null;
  return s && /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

/**
 * Reject anything that is not an explicit instant.
 *
 * PCO reads a bare `2026-03-01` in the ORG's time zone, which is not necessarily
 * the app's. The whole error is one day wide and entirely silent: the grid simply
 * starts or ends on the wrong square and no request fails. Throwing here makes a
 * caller that forgot the time-of-day fail loudly at the boundary instead.
 */
function assertInstant(value: string, label: string): void {
  // A date and a time, with an explicit offset or Z. `2026-03-01` and
  // `2026-03-01T06:00:00` (floating, no zone) both fail.
  const explicit = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value);
  if (!explicit || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an explicit ISO instant with a zone, got "${scrub(value)}"`);
  }
}

/** Every tag in an `included` array, by id. */
function tagsById(included: PcoNode[] | undefined): Map<string, CalendarTagRefDTO> {
  const out = new Map<string, CalendarTagRefDTO>();
  for (const node of included ?? []) {
    if (node.type !== "Tag") continue;
    const name = trimmedOrNull(node.attributes.name);
    if (!name) continue;
    out.set(node.id, { id: node.id, name, color: hexColor(node.attributes.color) });
  }
  return out;
}

/** The ids on a to_many relationship, whichever shape PCO sent it in. */
function relatedIds(node: PcoNode, key: string): string[] {
  const data = node.relationships?.[key]?.data;
  if (Array.isArray(data)) return data.map((d) => d.id);
  return data ? [data.id] : [];
}

/**
 * One event instance → CalendarEventDTO, or null when it cannot be placed.
 *
 * `published_starts_at` is a real ISO instant and is SOMETIMES NULL on real
 * events — verified live during planning. Code that assumes it is always present
 * renders a blank row, so the published value is a preference, not a source.
 *
 * @returns null only when the instance has no start at all under either name, in
 *   which case there is no square to draw it on. Counted and logged by the
 *   caller rather than dropped in silence.
 */
function mapEventInstance(node: PcoNode, tags: Map<string, CalendarTagRefDTO>): CalendarEventDTO | null {
  const a = node.attributes;
  const startsAt = trimmedOrNull(a.published_starts_at) ?? trimmedOrNull(a.starts_at);
  if (!startsAt) return null;
  // An instance with a start but no end is a point in time, not an error.
  const endsAt = trimmedOrNull(a.published_ends_at) ?? trimmedOrNull(a.ends_at) ?? startsAt;

  return {
    id: node.id,
    name: trimmedOrNull(a.name) ?? "Untitled",
    startsAt,
    endsAt,
    allDay: a.all_day_event === true,
    location: trimmedOrNull(a.location),
    churchCenterUrl: trimmedOrNull(a.church_center_url),
    // An untagged event is KEPT, with an empty list. Which events an operator
    // wants is the operator's choice, expressed in the tag filter; a client that
    // drops the untagged ones has made that choice for them, invisibly.
    tags: relatedIds(node, "tags")
      .map((id) => tags.get(id))
      .filter((t): t is CalendarTagRefDTO => t !== undefined),
  };
}

class PcoCalendarService {
  private cache = new Map<string, CacheEntry<unknown>>();

  private cacheGet<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  private cacheSet<T>(key: string, value: T, ttlMs: number): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * THE request for this client. Everything below goes through it.
   *
   * It adds nothing but the base URL and the version pin. A PcoAuthError raised
   * by the shared transport propagates unchanged, so a caller on a timer still
   * stands down on a 401 rather than asking again every tick.
   *
   * This is also the seam a test swaps to stand in for PCO — the same one
   * pco-plan-notes.test.ts uses on the other client.
   */
  private request<T extends PcoNode = PcoNode>(
    url: string,
    appId: string,
    secret: string,
  ): Promise<PcoResponse<T>> {
    return pcoService.requestProduct<T>(url, appId, secret, CALENDAR_API_VERSION);
  }

  /**
   * Every page of a collection, flattened.
   *
   * Written once for all three readers below. Pagination that is right in one of
   * three places and subtly wrong in the other two is this repository's most
   * expensive recurring mistake, and the offset rules here are exactly the kind
   * that drift: strictly forward, bounded, and carrying an INTEGER rather than a
   * URL out of the response body.
   *
   * Reaching MAX_PAGES is LOGGED. A bound is the right defence against a runaway
   * loop, but exiting on it is otherwise indistinguishable from having read
   * everything, and a caller cannot tell a whole month from the first 1200 of
   * it. Absence with no signal is the failure this whole file is written against.
   */
  private async readAll(
    firstUrl: string,
    appId: string,
    secret: string,
  ): Promise<{ data: PcoNode[]; included: PcoNode[] }> {
    const data: PcoNode[] = [];
    const included: PcoNode[] = [];
    const seenIds = new Set<string>();
    // Highest offset already asked for, so a next-link that does not move
    // forward ends the loop instead of fetching one page for ever. PCO does not
    // do that, which is precisely why nothing would catch it if it started.
    let seenOffset = -1;
    let url: string | null = firstUrl;

    for (let page = 0; url && page < MAX_PAGES; page++) {
      const json: PcoResponse & { links?: { next?: string } } = await this.request(url, appId, secret);
      for (const node of Array.isArray(json.data) ? json.data : [json.data]) {
        if (seenIds.has(node.id)) continue;
        seenIds.add(node.id);
        data.push(node);
      }
      included.push(...(json.included ?? []));
      // An OFFSET, not a URL. `links.next` arrives in a response BODY and the
      // request it would feed carries the operator's App ID and secret; an
      // integer cannot carry a host, a path or a scheme, so no string from PCO
      // reaches fetch() at all.
      const offset = nextOffset(json.links?.next);
      url = offset === null || offset <= seenOffset ? null : withOffset(url, offset);
      seenOffset = offset ?? seenOffset;
    }

    if (url) {
      console.warn(
        `[pco-calendar] page limit reached after ${scrub(data.length)} row(s); the rest of this collection was not read`,
      );
    }
    return { data, included };
  }

  /**
   * The event instances OVERLAPPING a window.
   *
   * `starts_at <= windowEnd AND ends_at >= windowStart`, both clauses, ANDed —
   * verified against the real API during planning. It is NOT a `starts_at`
   * range, and the difference is the whole point: a range asks "which events
   * begin inside the grid", so a retreat that began on the Thursday before a
   * grid starting Saturday is simply absent. Nothing errors, nothing logs, and
   * the event that most needed to be on the wall is the one that is missing.
   *
   * Filtering is server-side. `where[calendar_ids]` and `where[tag_ids]` both
   * work, so a busy month is narrowed by PCO rather than pulled in full and
   * sifted here. Note PCO's own semantics for several tags: OR within a tag
   * group, AND across groups.
   *
   * `kind` is deliberately not sent. It reads "standard" for events, vans, rooms
   * and childcare alike, so it separates nothing.
   */
  async listEventInstances(appId: string, secret: string, opts: CalendarWindow): Promise<CalendarEventDTO[]> {
    assertInstant(opts.fromIso, "fromIso");
    assertInstant(opts.toIso, "toIso");

    const calendarIds = [...opts.calendarIds].filter((id) => id !== "");
    const tagIds = [...opts.tagIds].filter((id) => id !== "");

    const cacheKey = `events:${appId}:${opts.fromIso}:${opts.toIso}:${calendarIds.join(",")}:${tagIds.join(",")}`;
    const cached = this.cacheGet<CalendarEventDTO[]>(cacheKey);
    if (cached) return cached;

    // Literal brackets, because that is how PCO documents the filter and how it
    // reads in a log line. Only the VALUES are escaped; URL() percent-encodes the
    // brackets on the way to fetch, which PCO decodes back to the same key.
    const query = [
      `where[starts_at][lte]=${encodeURIComponent(opts.toIso)}`,
      `where[ends_at][gte]=${encodeURIComponent(opts.fromIso)}`,
      "include=tags",
      "order=starts_at",
      `per_page=${PER_PAGE}`,
    ];
    // Omitted, not empty. `where[calendar_ids]=` is a different request from no
    // filter at all — it asks PCO to match the empty set.
    if (calendarIds.length > 0) {
      query.push(`where[calendar_ids]=${encodeURIComponent(calendarIds.join(","))}`);
    }
    if (tagIds.length > 0) {
      query.push(`where[tag_ids]=${encodeURIComponent(tagIds.join(","))}`);
    }

    const { data, included } = await this.readAll(
      `${CALENDAR_BASE}/event_instances?${query.join("&")}`,
      appId,
      secret,
    );

    const tags = tagsById(included);
    const events: CalendarEventDTO[] = [];
    let unplaceable = 0;
    for (const node of data) {
      const event = mapEventInstance(node, tags);
      if (event) events.push(event);
      else unplaceable++;
    }
    if (unplaceable > 0) {
      console.warn(`[pco-calendar] ${scrub(unplaceable)} instance(s) had no start time and were not drawn`);
    }

    this.cacheSet(cacheKey, events, TTL_EVENTS_MS);
    return events;
  }

  /** Every calendar the org has, for the picker. */
  async listCalendars(appId: string, secret: string): Promise<CalendarSourceDTO[]> {
    const cacheKey = `calendars:${appId}`;
    const cached = this.cacheGet<CalendarSourceDTO[]>(cacheKey);
    if (cached) return cached;

    const { data } = await this.readAll(`${CALENDAR_BASE}/calendars?per_page=${PER_PAGE}`, appId, secret);

    const result: CalendarSourceDTO[] = [];
    for (const node of data) {
      const name = trimmedOrNull(node.attributes.name);
      if (!name) continue;
      result.push({ id: node.id, name });
    }
    result.sort((a, b) => a.name.localeCompare(b.name));

    this.cacheSet(cacheKey, result, result.length > 0 ? TTL_METADATA_MS : TTL_EMPTY_MS);
    return result;
  }

  /**
   * Every tag the org has defined, with its group, for the picker.
   *
   * Tag order is PCO's `position` — the operator's own ordering in the Calendar
   * UI — rather than alphabetical, so the picker reads the way their calendar
   * does.
   */
  async listCalendarTags(appId: string, secret: string): Promise<CalendarTagDTO[]> {
    const cacheKey = `tags:${appId}`;
    const cached = this.cacheGet<CalendarTagDTO[]>(cacheKey);
    if (cached) return cached;

    const { data, included } = await this.readAll(
      `${CALENDAR_BASE}/tags?include=tag_group&order=position&per_page=${PER_PAGE}`,
      appId,
      secret,
    );

    const groupNames = new Map<string, string>();
    for (const node of included) {
      if (node.type !== "TagGroup") continue;
      const name = trimmedOrNull(node.attributes.name);
      if (name) groupNames.set(node.id, name);
    }

    const result: CalendarTagDTO[] = [];
    for (const node of data) {
      const name = trimmedOrNull(node.attributes.name);
      if (!name) continue;
      const [groupId] = relatedIds(node, "tag_group");
      result.push({
        id: node.id,
        name,
        color: hexColor(node.attributes.color),
        // PCO's own name for the ungrouped bucket in its UI, so a picker can
        // group on this field without special-casing an empty string.
        groupName: (groupId ? groupNames.get(groupId) : null) ?? "Individual Tags",
      });
    }

    this.cacheSet(cacheKey, result, result.length > 0 ? TTL_METADATA_MS : TTL_EMPTY_MS);
    return result;
  }
}

export const pcoCalendarService = new PcoCalendarService();
