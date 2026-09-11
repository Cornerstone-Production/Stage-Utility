// resi-service.ts — is the Resi encoder streaming, and since when.
//
// THIS RIDES AN UNDOCUMENTED API, DELIBERATELY.
//
// Resi's published "Go Live API" (api.resi.io) cannot answer the question this
// integration exists for. It has no way to list active schedules — the only
// source of a scheduleId is the POST that starts a stream — so it can report
// only on streams this app itself started. Many operators' Resi goes live on
// Resi's own schedule, which that API cannot see at all. There are no webhooks:
// the words do not appear in its OpenAPI spec, and /v1/schedules and /v1/events
// both 404. Bitfocus's own resi-studio module confirms the shape by persisting
// the schedule ids it created, because it cannot discover them either.
//
// The internal Web API behind central.resi.io reports ENCODER state, which is
// true whoever started the stream. That is the whole reason this file talks to
// an endpoint Resi does not document, and the risk is real: it may change
// without notice. When it does, this integration reports a clear error and
// everything else keeps working — which is why the failure path below never
// throws past its caller.
//
// Two quirks worth knowing before editing:
//   - The auth header is `X-Bearer`, not `Bearer`.
//   - The token endpoint wants grant_type "password_cookie" with the account
//     username and password. There is no scoped credential for this API.
//
// TWO ENDPOINTS, because one of them cannot answer on its own.
//
//   /encoders/status?wide=true  is the live state — and ONLY the live state.
//     Its rows are {uuid, status, operationalState, lastUpdate,
//     preferredVersion, updateRequired}. There is no name on them and no start
//     time on them, which is how two raw uuids ended up on a wall.
//   /events                     is the broadcast list, and carries both:
//     {uuid, name, encoderName, encoderId, scheduleId, startTime, stopAfter,
//      hlsUrl, cloudUrl, codec, format}. Joined on `encoderId` it supplies the
//     encoder NAME for the sub-line and a REAL broadcast start time.
//
// The join is cached and is allowed to fail. A names lookup that went down must
// never take the live/off-air readout with it, so refreshEvents() returns its
// failure to connect() rather than throwing through it.
//
// /schedules exists and answers HTTP 400 "No valid filtering field was
// provided" — it wants a filter nobody has identified. Not used.

import { errorMessage } from "./errors.js";
import { scrub } from "./scrub.js";
import type { StreamStatusDTO } from "../types/stage.js";
import { StatusIntegration } from "./integration-base.js";
import { streamStartStore } from "./stream-start-store.js";

const API = "https://central.resi.io/api/v3";
const API_V2 = "https://central.resi.io/api_v2.svc";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * RESI_DEBUG=1 logs one encoder object, once per connection, in full.
 *
 * This integration reads exactly one field -- `status` -- because that is the
 * only one whose meaning was ever confirmed. The payload carries far more, and
 * the question that keeps coming up is whether one of those other fields
 * distinguishes "the encoder is running" from "the stream is live to viewers".
 * Those are different moments: an encoder started for a soundcheck an hour early
 * is `started` while nothing is going out.
 *
 * Naming a guess in code would be worse than not guessing -- see the header on
 * why this file only reads what it has seen. So this prints the real shape once,
 * scrubbed, and the field is chosen afterwards from evidence.
 */
const RESI_DEBUG = process.env.RESI_DEBUG === "1";
/** While something is watching. Resi's own status is ~20s fresh, so faster than
 *  this buys nothing but requests. */
const POLL_MS = 15_000;
/** Nobody watching: the automation engine still wants to know we went live. */
const IDLE_POLL_MS = 120_000;
/**
 * How long the /events join is reused before it is asked for again.
 *
 * Independent of POLL_MS on purpose. Encoder names change roughly never, and a
 * broadcast's start time is worth having within a minute of it appearing — so a
 * minute buys everything a 15-second poll would and costs a quarter of the
 * requests on an API this file is a guest on.
 */
const EVENTS_CACHE_MS = 60_000;

const OFFLINE: StreamStatusDTO = {
  connected: false,
  live: false,
  startedAt: null,
  detail: null,
};

/** One encoder, as much of it as we rely on. The payload carries far more;
 *  naming only what is read keeps a field rename from looking like a rewrite. */
export interface ResiEncoder {
  uuid: string;
  /** NOT sent by /encoders/status. Kept because the field would be free to read
   *  if Resi ever added it, and because a reader who sees it here should know
   *  that today the name comes from the /events join instead. */
  name?: string | null;
  status?: string | null;
  videoInputSource?: unknown;
  /** "stop" while the encoder is not running. Contradicts a stale `status`. */
  operationalState?: string | null;
  lastUpdate?: string | null;
  /** Not observed on this endpoint either. A start time comes from the matching
   *  /events row — see `startedAtFrom`, which reads all three. */
  startedAt?: string | null;
  startTime?: string | null;
}

/**
 * One broadcast, from `GET /customers/{id}/events`.
 *
 * The rows are newest-first as Resi returns them, but nothing here relies on
 * that: both readers below pick by `startTime` so a change of ordering cannot
 * quietly put last month's name on today's encoder.
 */
export interface ResiEvent {
  uuid?: string;
  /** The BROADCAST's name ("11:30a"), not the encoder's. */
  name?: string | null;
  encoderId?: string | null;
  encoderName?: string | null;
  scheduleId?: string | null;
  /** ISO. The real moment this broadcast began. */
  startTime?: string | null;
  /** ISO. Resi's own scheduled auto-stop for it. */
  stopAfter?: string | null;
}

/**
 * How long past its scheduled stop an event row still describes a live encoder.
 *
 * `stopAfter` is Resi's own auto-stop, and in a capture of eleven rows the
 * windows for one encoder never overlapped — consecutive services sat five
 * minutes apart. So "now is inside the window" is a reliable match, and this
 * grace covers a broadcast that runs past its scheduled end WITHOUT letting last
 * week's row vouch for today's stream.
 *
 * Erring short on purpose. A start time we cannot justify is worse than none —
 * that is the whole lesson of `startedFor` below, where an unjustified clock put
 * 0:00 on the wall over an hour-old broadcast.
 */
const EVENT_OVERRUN_GRACE_MS = 15 * 60_000;

/**
 * Encoder id -> encoder name, from the broadcast list.
 *
 * THE fix for two raw uuids on a wall: the status endpoint has no name field at
 * all, so this is the only place a name can come from. Newest row per encoder
 * wins, so an encoder renamed in Resi reads as its new name rather than
 * whichever row happened to come back first.
 */
export function encoderNamesFrom(events: readonly ResiEvent[]): Map<string, string> {
  const best = new Map<string, { name: string; start: number }>();
  for (const row of events) {
    const id = row.encoderId?.trim();
    const name = row.encoderName?.trim();
    if (!id || !name) continue;
    const parsed = Date.parse(row.startTime ?? "");
    const start = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    const prev = best.get(id);
    if (!prev || start > prev.start) best.set(id, { name, start });
  }
  return new Map([...best].map(([id, v]) => [id, v.name]));
}

/**
 * The event row describing what this encoder is broadcasting RIGHT NOW, or null.
 *
 * Deliberately strict. A row qualifies only when it has both a start that has
 * passed and a stop that has not (plus the grace above); anything missing a
 * usable window is skipped rather than guessed at, and the caller falls back to
 * the start we observed ourselves.
 *
 * UNCONFIRMED: whether Resi adds a row while a stream is running or only once it
 * finishes. Written to work either way — if rows only appear afterwards, nothing
 * matches mid-broadcast and the observed start still answers.
 */
export function currentEventFor(
  events: readonly ResiEvent[],
  encoderId: string,
  now: number,
): ResiEvent | null {
  let best: { row: ResiEvent; start: number } | null = null;
  for (const row of events) {
    if (row.encoderId?.trim() !== encoderId) continue;
    const start = Date.parse(row.startTime ?? "");
    if (!Number.isFinite(start) || start > now) continue;
    const stop = Date.parse(row.stopAfter ?? "");
    if (!Number.isFinite(stop) || now > stop + EVENT_OVERRUN_GRACE_MS) continue;
    if (!best || start > best.start) best = { row, start };
  }
  return best?.row ?? null;
}

/**
 * How long an encoder record may go unrefreshed before it stops being evidence.
 *
 * A running encoder reports constantly -- the one that was genuinely idle in the
 * capture had checked in 30 seconds earlier. Ten minutes is far past any normal
 * gap and well short of the 25 HOURS the stale record had been sitting.
 */
const ENCODER_STALE_AFTER_MS = 10 * 60_000;

/**
 * Is this encoder streaming?
 *
 * `status === "started"` alone is not evidence, and this is what that cost: the
 * widget read LIVE at 10pm on a Wednesday with nothing going out. A capture off
 * the real account showed why.
 *
 *   encoder A  status "stopped"  operationalState "stop"  lastUpdate 30s ago
 *   encoder B  status "started"  operationalState "stop"  lastUpdate 25h ago
 *
 * B had finished a stream the previous evening and stopped reporting at 02:25,
 * minutes before that event's scheduled end. Its `status`
 * has been frozen on the last thing it said ever since. Resi does not clear it,
 * so a field that means "what this encoder was doing when it last spoke" was
 * being read as "what it is doing now".
 *
 * Two independent disqualifiers, both already in the payload we fetch:
 *
 *   operationalState -- said "stop" on BOTH encoders. A record whose own two
 *     fields disagree is not describing a live stream.
 *   lastUpdate -- nothing has refreshed it. A stale record is not evidence of
 *     anything, which is the same rule the wireless drivers apply to a battery
 *     sentinel and prodcom applies to an orphaned partial.
 *
 * Either alone would have caught this one. Both are checked because they fail
 * independently: an encoder yanked off the network goes stale with a plausible
 * operationalState, and a clean stop updates operationalState while staying
 * fresh.
 *
 * `status` is still compared case-insensitively -- an undocumented API is free to
 * change casing without telling anybody, and a live indicator that goes dark over
 * a capital letter is the worst possible failure here.
 */
export function encoderIsLive(e: ResiEncoder, now: number = Date.now()): boolean {
  if ((e.status ?? "").trim().toLowerCase() !== "started") return false;

  // Only a stop-ish value disqualifies. An unknown word is not treated as proof
  // of anything either way, because this field is undocumented too.
  const op = (e.operationalState ?? "").trim().toLowerCase();
  if (op.startsWith("stop")) return false;

  const seen = Date.parse(e.lastUpdate ?? "");
  if (Number.isFinite(seen) && now - seen > ENCODER_STALE_AFTER_MS) return false;

  return true;
}

/**
 * A start time Resi itself reports for this encoder, if there is one.
 *
 * Three sources, in order. The first two are fields on the encoder payload that
 * Resi has never been seen to send — kept because they would be free to read the
 * day it does. The third is the real one: the `startTime` of the /events row
 * whose window contains `now`.
 *
 * Anything unparseable is treated as absent rather than passed on, so a garbage
 * stamp cannot become a wrong clock.
 */
export function startedAtFrom(
  e: ResiEncoder,
  events: readonly ResiEvent[] = [],
  now: number = Date.now(),
): string | null {
  const reported = currentEventFor(events, e.uuid, now)?.startTime ?? null;
  for (const v of [e.startedAt, e.startTime, reported]) {
    if (typeof v !== "string" || !v) continue;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

/** Pick the encoders this integration reports on. Empty selection means "all of
 *  them", so an operator who has not chosen yet still sees the truth. */
export function selectedEncoders(all: ResiEncoder[], wanted: readonly string[]): ResiEncoder[] {
  if (!wanted.length) return all;
  const want = new Set(wanted);
  return all.filter((e) => want.has(e.uuid));
}

class ResiService extends StatusIntegration<StreamStatusDTO> {
  private username: string | null = null;
  private password: string | null = null;
  private encoderIds: string[] = [];

  private token: string | null = null;
  private tokenExpiresAt = 0;
  private customerId: string | null = null;

  /** RESI_DEBUG: whether the one-off payload dump has already gone out. */
  private loggedShape = false;

  /** Encoder id -> name, for the sub-line. Built from the /events join. */
  private names = new Map<string, string>();

  /** The cached /events join, and when it was last asked for. */
  private events: ResiEvent[] = [];
  private eventsFetchedAt = 0;
  /** Why the join is currently unavailable, or null. Held so connect() logs the
   *  transition rather than the same line every poll. */
  private eventsError: string | null = null;

  constructor() {
    super("resi", "resi:status", OFFLINE);
  }

  protected get configured(): boolean {
    return !!this.username && !!this.password;
  }

  configure(username: string, password: string, encoderIds: string[] = []): void {
    const nextUser = username?.trim() || null;
    const nextPass = password || null;
    // Credentials changed: the cached token belongs to the old account, and so
    // do the encoder names and broadcast rows joined with it.
    if (nextUser !== this.username || nextPass !== this.password) {
      this.token = null;
      this.tokenExpiresAt = 0;
      this.customerId = null;
      this.events = [];
      this.eventsFetchedAt = 0;
      this.eventsError = null;
      this.names.clear();
    }
    this.username = nextUser;
    this.password = nextPass;
    this.encoderIds = encoderIds.filter(Boolean);
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.configured) return;
    console.log("[resi] polling encoder status");
    super.start();
  }

  /** One-shot check for the Integrations "Test connection" button. */
  async test(username: string, password: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const { token } = await this.fetchToken(username, password);
      const customerId = await this.fetchCustomerId(token);
      const encoders = await this.fetchEncoderStatus(token, customerId);
      if (RESI_DEBUG && encoders[0] && !this.loggedShape) {
        this.loggedShape = true;
        // One encoder, once. The status poll runs every few seconds and this is
        // for identifying a field, not for watching one.
        console.log(`[resi] encoder payload shape: ${scrub(JSON.stringify(encoders[0]))}`);
      }
      const live = encoders.filter(encoderIsLive).length;
      return {
        ok: true,
        message: `Connected to Resi — ${encoders.length} encoder${encoders.length === 1 ? "" : "s"}, ${live} streaming`,
      };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  /**
   * Encoders to choose from, for the picker. Throws so the caller can report.
   *
   * The /events join is the SAME fix the sub-line needed: `e.name` is never
   * there, so this picker offered a list of bare uuids to choose between. The
   * join is fetched unconditionally here rather than read from the cache — the
   * operator has just opened the picker, so a fresh answer is worth one request.
   */
  async listEncoders(): Promise<{ id: string; name: string }[]> {
    const token = await this.ensureToken();
    const customerId = await this.ensureCustomerId(token);
    const [list, events] = await Promise.all([
      this.fetchEncoderStatus(token, customerId),
      // A picker that can still name most encoders beats one that errors
      // because the join blinked. An empty list names none, which is the old
      // behaviour rather than a new failure.
      this.fetchEvents(token, customerId).catch(() => [] as ResiEvent[]),
    ]);
    const named = encoderNamesFrom(events);
    return list.map((e) => ({ id: e.uuid, name: e.name || named.get(e.uuid) || e.uuid }));
  }

  private async json<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      // 401 is the one worth naming: on an undocumented API it usually means
      // the credentials are wrong, not that the shape changed.
      if (res.status === 401) throw new Error("Resi rejected the username or password");
      throw new Error(`Resi returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /** Sign in. The one place the credentials are sent, so the test button and the
   *  poll cannot drift apart about how Resi is asked. */
  private async fetchToken(username: string, password: string): Promise<{ token: string; expiresInSec: number }> {
    const body = await this.json<{ access_token?: string; expires_in?: number }>(`${API}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, grant_type: "password_cookie" }),
    });
    if (!body.access_token) throw new Error("Resi returned no access token");
    return { token: body.access_token, expiresInSec: body.expires_in ?? 3600 };
  }

  private async ensureToken(): Promise<string> {
    // 60s of headroom: a token that expires mid-request would surface as a
    // spurious auth error and a needless reconnect.
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    if (!this.username || !this.password) throw new Error("Resi is not configured");
    const { token, expiresInSec } = await this.fetchToken(this.username, this.password);
    this.token = token;
    this.tokenExpiresAt = Date.now() + expiresInSec * 1000;
    return this.token;
  }

  private async fetchCustomerId(token: string): Promise<string> {
    const me = await this.json<{ customerId?: string }>(`${API_V2}/users/me`, {
      headers: { Authorization: `X-Bearer ${token}` },
    });
    if (!me.customerId) throw new Error("Resi did not return a customer id");
    return me.customerId;
  }

  private async ensureCustomerId(token: string): Promise<string> {
    if (this.customerId) return this.customerId;
    this.customerId = await this.fetchCustomerId(token);
    return this.customerId;
  }

  private async fetchEncoderStatus(token: string, customerId: string): Promise<ResiEncoder[]> {
    const list = await this.json<ResiEncoder[]>(
      `${API}/customers/${encodeURIComponent(customerId)}/encoders/status?wide=true`,
      { headers: { Authorization: `X-Bearer ${token}` } },
    );
    return Array.isArray(list) ? list : [];
  }

  private async fetchEvents(token: string, customerId: string): Promise<ResiEvent[]> {
    const list = await this.json<ResiEvent[]>(
      `${API}/customers/${encodeURIComponent(customerId)}/events`,
      { headers: { Authorization: `X-Bearer ${token}` } },
    );
    return Array.isArray(list) ? list : [];
  }

  /**
   * Refresh the cached /events join if it is due.
   *
   * RETURNS the failure rather than throwing it or swallowing it. Throwing would
   * put the whole integration into its error path over a missing NAME; swallowing
   * would leave an operator with a wall full of uuids and nothing to read. The
   * caller decides, and logs the transition.
   *
   * A failed attempt still stamps `eventsFetchedAt`, so a join that has stopped
   * answering is retried on the same cadence as one that works rather than on
   * every poll.
   *
   * @returns null on success, or why the join is unavailable.
   */
  private async refreshEvents(token: string, customerId: string): Promise<string | null> {
    if (this.eventsFetchedAt && Date.now() - this.eventsFetchedAt < EVENTS_CACHE_MS) return this.eventsError;
    try {
      const rows = await this.fetchEvents(token, customerId);
      this.eventsFetchedAt = Date.now();
      this.events = rows;
      // Merged, not replaced: an encoder whose last broadcast has aged off the
      // list keeps the name we already learned rather than reverting to a uuid.
      for (const [id, name] of encoderNamesFrom(rows)) this.names.set(id, name);
      return null;
    } catch (err) {
      this.eventsFetchedAt = Date.now();
      return errorMessage(err);
    }
  }

  protected async connect(): Promise<void> {
    if (!this.running || !this.configured) return;
    try {
      const token = await this.ensureToken();
      const customerId = await this.ensureCustomerId(token);
      const all = await this.fetchEncoderStatus(token, customerId);
      if (!this.running) return;

      // Deliberately AFTER the status call and deliberately not fatal: this is
      // the join that supplies names and a reported start, and the readout it
      // decorates has to survive without it.
      const eventsError = await this.refreshEvents(token, customerId);
      if (eventsError !== this.eventsError) {
        this.eventsError = eventsError;
        if (eventsError) {
          console.warn(
            `[resi] broadcast list unavailable (${eventsError}) — encoder names fall back to ids and the elapsed clock to what we observed`,
          );
        } else {
          console.log("[resi] broadcast list readable again — encoder names and reported start times are back");
        }
      }

      for (const e of all) if (e.name) this.names.set(e.uuid, e.name);
      const watched = selectedEncoders(all, this.encoderIds);
      const live = watched.filter(encoderIsLive);

      if (!this.last.connected) {
        this.resetBackoff();
        this.report("connected", `Connected to Resi — watching ${watched.length || "all"} encoder(s)`);
      }

      this.emitIfChanged({
        connected: true,
        live: live.length > 0,
        startedAt: this.startedFor(live),
        detail: this.nameList(live.length ? live : watched),
      });

      this.scheduleIn(this.inDemand ? POLL_MS : IDLE_POLL_MS);
    } catch (err) {
      const msg = errorMessage(err);
      if (this.attempt === 0) console.warn(`[resi] status unavailable (${msg}) — backing off quietly`);
      // A rejected token is worth dropping so the next attempt re-authenticates
      // rather than replaying a credential Resi has already refused.
      this.token = null;
      this.report("error", `Can't reach Resi — ${msg}`);
      this.goOffline();
      this.scheduleReconnect();
    }
  }

  /**
   * The sub-line: what these encoders are called.
   *
   * ONE writer, because there were three — live, watched, and the settings
   * picker — each spelling the same uuid fallback by hand, and the wall showed
   * `5a905d3b-… + eb43036d-…` because all three were reading a `name` field the
   * status endpoint does not send. Falling back to the uuid is still right when
   * the join has never answered; it is just no longer the normal case.
   */
  private nameList(encoders: readonly ResiEncoder[]): string | null {
    return encoders.map((e) => this.names.get(e.uuid) ?? e.uuid).join(" + ") || null;
  }

  /**
   * Whether a previous successful poll found Resi reachable and NOT streaming.
   *
   * This is what makes an elapsed clock honest. Resi's encoder status carries a
   * state and no start time (see the header — the published Go Live API cannot
   * answer this at all), so the only start we can derive is the moment we
   * watched it change. Having watched it change is precisely what this records.
   *
   * In memory on purpose. It is a fact about THIS process's observations, and
   * persisting it would let yesterday's sighting vouch for today's stream.
   */
  private sawOffAir = false;

  /**
   * When the stream started.
   *
   * Three answers, in order of how much they can be trusted:
   *
   *   1. A start time Resi reports — today, the `startTime` of the /events row
   *      whose window contains now. `startedAtFrom` finds it and it wins.
   *   2. A start we already established for this stream — either reported or
   *      from watching it go live. Persisted, so a server restarted
   *      mid-service still agrees with the number that was on the wall a minute
   *      ago, rather than resetting to zero at exactly the moment somebody is
   *      looking at it.
   *   3. Nothing. We found it already streaming and never saw it start.
   *
   * Case 3 used to return `new Date()`, which is how a stream forty minutes old
   * came up reading 0:00 the moment the integration was configured — the clock
   * timed how long the INTEGRATION had been running, not the broadcast. Null
   * now, and the widgets show LIVE with no number, which is the truth.
   *
   * Case 3 is also still reachable with the join working: if Resi only writes an
   * event row once a broadcast has FINISHED, no row matches mid-service and this
   * falls straight back to what it always did.
   */
  private startedFor(live: ResiEncoder[]): string | null {
    if (!live.length) {
      // Off air, and we are watching: the next stream to start is one we will
      // have seen begin.
      streamStartStore.clear("resi");
      this.sawOffAir = true;
      return null;
    }

    const now = Date.now();
    const reported = live.map((e) => startedAtFrom(e, this.events, now)).filter((x): x is string => !!x);
    if (reported.length) {
      const earliest = new Date(Math.min(...reported.map((x) => Date.parse(x)))).toISOString();
      streamStartStore.remember("resi", earliest);
      return earliest;
    }

    const known = streamStartStore.known("resi");
    if (known) return known;

    // First sighting of this stream. Only trust a clock we started ourselves.
    return this.sawOffAir ? streamStartStore.observe("resi") : null;
  }

  override stop(): void {
    super.stop();
    this.token = null;
    this.tokenExpiresAt = 0;
  }
}

export const resiService = new ResiService();
