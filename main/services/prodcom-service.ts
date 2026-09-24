// prodcom-service.ts — Subscribes to ProdCom's live transcription feed and
// broadcasts it on "prodcom:transcript" for the dashboard / transcription display.
//
// ProdCom (prodcom.io) exposes an HTTP + WebSocket Application API (default port
// 24480). It PUBLISHES ITS OWN SPECIFICATION: `GET /api/v1/openapi.yaml` is a
// complete OpenAPI 3.1 document, browsable at `/docs`. Nothing here is
// reverse-engineered — every field name below is read from that spec's
// `TranscriptEntry` and `Channel` schemas and was verified against 2.3.2 on the
// LAN. Fetch the spec from the box before changing this file; do not guess field
// names, and do not add "likely" fallbacks. An earlier version of this comment
// claimed the field names were undocumented, which is how five colour keys that
// have never existed on a transcript entry survived here as dead code.
//
// Transport: the SSE endpoint `GET /api/v1/transcript/stream` is the live
// transport from the moment this service connects, and stays live for as long
// as the WebSocket is unproven — which on ProdCom 2.3.2 is always: its `GET
// /api/v1/ws` accepts the upgrade, sends `{"type":"welcome"}` and a 30-second
// `{"type":"ping"}` heartbeat, and never once published a transcript frame
// (measured against the live box with six concurrent clients held open while
// nine lines were spoken). Withholding captions while that socket was tested —
// this file's previous design — is what let a heartbeat-only connection sit
// "connected" for two days with an empty captions strip, and what cut captions
// for a minute on every silent-box re-test afterward.
//
// So the WebSocket is opened BESIDE the SSE stream, never instead of it. The
// first transcript entry it actually delivers promotes it — the SSE stream
// closes, and the WebSocket becomes the live transport (this is also how a
// ProdCom build that starts publishing on the socket takes over automatically).
// If a promoted socket later dies, captions fall straight back to SSE, and the
// existing backfill covers whatever gap that leaves. While both are open, a
// line can legitimately arrive on each; entries are deduped by ProdCom's own
// `id` so nothing is applied or broadcast twice.
//
// The SSE endpoint sends NO keepalive of any kind — held open through a quiet
// evening it delivers zero bytes — so the only thing that notices a dead ProdCom
// on that path is a 15-minute data-silence timer. That used to be the sole
// transport and flapped the panel ~140 times a month on a quiet evening; now it
// only has to catch a box whose WebSocket also never proves itself.

import * as crypto from "node:crypto";
import * as http from "http";

import type { ProdcomChannelDTO, TranscriptLineDTO } from "../types/stage.js";
import { broadcast, channelInDemand } from "./broadcaster.js";
import { errorMessage } from "./errors.js";
import { scrub } from "./scrub.js";
import { ConnectionLifecycle } from "./integration-base.js";
import { DEFAULT_SETTLE_MS, OutageLog } from "./repeat-log.js";
import { createSseReader, keepSocketAlive, parseSseBlock, SSE_MAX_BUFFER, type SseEvent } from "./sse-reader.js";

const RECONNECT_MS = 4000;
/**
 * How often TCP probes the peer once the SSE fallback goes quiet.
 *
 * Only the fallback needs this. A half-open socket (the box unplugged, its
 * switch port dropped) emits neither 'end' nor 'error', so scheduleReconnect was
 * unreachable and the panel kept reading "Streaming from host:port" while the
 * captions display showed the last line from before the drop, for the rest of
 * the service. TCP keepalive assumes nothing about the payload: a live peer's
 * kernel answers the probe even when the application has nothing to say.
 *
 * The WebSocket path does not use it — ProdCom's own 30-second heartbeat is a
 * stronger signal, because it proves the APPLICATION is alive, not just its
 * kernel.
 */
const SOCKET_KEEPALIVE_MS = 30_000;

/**
 * Backstop for the SSE fallback only: a peer whose TCP stack still answers while
 * the application has stopped producing.
 *
 * This used to be the primary reconnect driver, and its own comment insisted it
 * was "a last resort, not the mechanism" and "set far beyond any plausible
 * silence so it cannot flap through a service". Both were wrong: the SSE stream
 * has no keepalive, so a quiet building looks identical to a dead box, and prod's
 * log carried 140 `no transcript data for 900s` lines in five weeks, firing on
 * the quarter hour all night. It survives only because the fallback path has
 * nothing better; the WebSocket path replaces it with a real heartbeat.
 */
const STREAM_IDLE_MS = 15 * 60_000;

/**
 * How long the WebSocket may go without ANY frame before it is treated as dead.
 *
 * ProdCom sends `{"type":"ping"}` every 30 s (measured on 2.3.2 over a 25-minute
 * idle capture: 30.0 s apart, no drift). Three missed in a row is a dead link,
 * and unlike STREAM_IDLE_MS above this cannot fire during a quiet service —
 * silence here means the heartbeat stopped, not that nobody spoke.
 */
const WS_HEARTBEAT_TIMEOUT_MS = 90_000;

/**
 * While on the SSE fallback, retry the WebSocket every this many reconnects.
 *
 * Deliberately tied to reconnects rather than to a clock: a healthy SSE stream
 * is degraded, not broken, and tearing it down on a timer to probe would clear
 * every in-flight partial and re-run backfill for nothing. The cases where the
 * WebSocket starts working — ProdCom restarted, ProdCom upgraded, its API
 * toggled — all drop the connection anyway, so a reconnect is exactly when it is
 * worth asking again. Small, because retrying on EVERY reconnect wastes a
 * refused upgrade each time against a box that genuinely has no WebSocket.
 */
const WS_RETRY_EVERY = 3;

/**
 * WS_RETRY_EVERY, once the box has been shown to accept a socket and carry
 * nothing on it (see WS_SILENCE_CHECK_MS).
 *
 * A refused upgrade is free — the fallback never stops carrying captions, since
 * it is never touched by the attempt. A socket that OPENS is not entirely free
 * either: it still gets one check interval to prove itself before it is dropped,
 * and every re-test is a REST call and a closed socket at the end of it. Three
 * reconnects of a flapping fallback is seconds apart, which on such a box is a
 * re-test every few seconds. Twenty is far enough apart that a ProdCom that has
 * been fixed or restarted is still found without restarting this server, without
 * probing a known-silent box on every reconnect.
 */
const WS_SILENT_RETRY_EVERY = 20;

/**
 * While on the SSE fallback, also retry the WebSocket on this timer.
 *
 * WS_RETRY_EVERY alone is unreachable on a HEALTHY fallback: it only counts
 * reconnects, and a quiet SSE stream that stays open never reconnects. On
 * 18 Sep 2026 ProdCom refused every upgrade until it restarted at 00:38Z, and
 * the client then sat on the fallback for a further 34 minutes — the stream was
 * fine, so nothing counted, so nothing asked again.
 *
 * Both rules are kept. The counter is what handles a box that is dropping the
 * fallback anyway (no point waiting five minutes when a reconnect is happening
 * now); this is what handles the case the counter cannot see. Five minutes
 * bounds the damage — the fallback has no keepalive, so the longer it is held
 * the longer a dead box goes unnoticed — while costing one refused upgrade every
 * five minutes against a box that genuinely has no WebSocket.
 */
const WS_RETRY_INTERVAL_MS = 5 * 60_000;

/**
 * WS_RETRY_INTERVAL_MS, once the box has been shown to accept a socket and carry
 * nothing on it (see WS_SILENCE_CHECK_MS).
 *
 * Five minutes is right for a box that REFUSES the upgrade: the attempt is made
 * beside the live fallback, fails, and costs nothing. It is wrong for a box that
 * ACCEPTS one and says nothing on it, because that socket is then given a whole
 * check interval to prove itself before it is dropped again — a REST call and a
 * closed socket every five minutes, for ever, which is worse than waiting longer
 * between re-tests of a box already known to carry nothing.
 *
 * Widened rather than removed. `useWebSocket` is only ever turned back on by
 * these two retry rules, so dropping the timer would leave a ProdCom that has
 * been fixed in place undiscovered until this server restarts — and the
 * 18 Sep 2026 incident in WS_RETRY_INTERVAL_MS above is the case on record where
 * the reconnect counter alone did not notice a box that had recovered. Half an
 * hour cuts the worst case to one REST call and a closed socket every thirty
 * minutes against a box already known to carry nothing — captions themselves
 * never move off the SSE fallback for the re-test, so a wider interval costs
 * nothing a caption display shows, only how quickly a fixed box is found again.
 */
const WS_SILENT_RETRY_INTERVAL_MS = 30 * 60_000;

/**
 * How long a WebSocket may be the live transport, having delivered NO transcript
 * entry at all, before REST is asked whether anything was missed.
 *
 * ProdCom 2.3.2 accepts the upgrade, sends `{"type":"welcome"}` listing the
 * transcript stream, answers every heartbeat, and — on prod, over seven
 * connections across two days — delivered not one transcript entry. Every
 * liveness check in this file was satisfied: the heartbeat watchdog and
 * noteWebSocketHealthy both treat ANY frame as proof of life, and the heartbeats
 * kept arriving, so nothing ever dropped and the SSE fallback never engaged. The
 * captions display was empty for two days while the integration card read
 * connected.
 *
 * A heartbeat proves the PEER is alive. It does not prove the SUBSCRIPTION is
 * delivering, and that is the gap this closes: one cheap REST question, asked
 * only while the socket has delivered nothing, and never again once it has.
 */
const WS_SILENCE_CHECK_MS = 60_000;

/**
 * Page size for that question.
 *
 * It is not a count, it is a yes/no: did anybody speak since this socket opened?
 * One page of twenty answers it for any real service. A page that is entirely
 * `typed` or `automation` rows reads as "no" and the question is simply asked
 * again — the wrong answer in that direction costs nothing, where the wrong
 * answer in the other tears down a transport that is working.
 */
const WS_SILENCE_CHECK_PAGE_SIZE = 20;

/**
 * How far the question may page forward before giving up on it.
 *
 * Only reached while every row so far has been `typed` or `automation`, which on
 * a box whose channels all transcribe their own audio is never — so the normal
 * cost of the whole check stays one request. A hundred rows of nothing but typed
 * comms traffic since the socket opened is where it stops, and that answers as
 * "nobody spoke", which is the safe direction: the check simply asks again.
 */
const WS_SILENCE_CHECK_MAX_PAGES = 5;

/** What the integration card says once a box's WebSocket is known to carry
 *  nothing, between re-tests. `report()` dedupes on the message as well as the
 *  state, so this is also what makes the card update at all — the SSE stream had
 *  already reported ("connected", "Streaming from host:port"). */
const SILENT_SOCKET_CARD_MESSAGE = "Fallback stream — the websocket carried no transcript";

/** What the card says for the minute a known-silent box's socket is being
 *  re-tested. The SSE stream is still the live transport throughout — this only
 *  names what the WebSocket is doing in the background, since `Streaming from
 *  host:port` alone would read as though nothing about this box were in question. */
const RETESTING_CARD_MESSAGE = "Re-testing the websocket that carried no transcript";

/** The outage KIND for noteWebSocketDown's dedupe. Constant per the rule there:
 *  no counts, no timestamps, nothing that varies per attempt. */
const SILENT_SOCKET_REASON = "opened but delivered no transcript";

/** An interval as an operator would say it. Reads off the live value rather than
 *  the constant so a log line stays true under the tests' overridden seams,
 *  where "30 min" rounds to "0 min" and asserts something that will not happen. */
function everyMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

/** Socket-inactivity timeout for the refused-upgrade probe. Same 4 s as every
 *  other one-shot read in this file (test(), getJson). NOT on its own enough —
 *  see PROBE_DEADLINE_MS. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Wall-clock ceiling on the whole probe, from the request going out to an answer
 * or nothing.
 *
 * Node's `timeout` option measures INACTIVITY, and a peer that keeps sending
 * resets it indefinitely: a refusal answered with a chunked body trickling one
 * chunk a second holds the probe open for ever, and with it the fallback that is
 * waiting on it. The deadline is the thing the peer cannot push back. Generous
 * enough that a slow-but-finite answer still gets read, short enough that the
 * captions are back inside a few seconds either way.
 */
const PROBE_DEADLINE_MS = 6000;

/** How much of a refused handshake's body is worth keeping. Enough for
 *  ProdCom's own `{"error":{"code":…,"message":…}}`, short enough that a box
 *  answering with an HTML error page cannot fill a log line. */
const PROBE_BODY_BYTES = 200;

/** What the probe calls itself, so it is not mistaken for the live client.
 *  Exported because the tests separate the two by it. */
export const PROBE_USER_AGENT = "stage-utility-upgrade-probe";

const MAX_LINES = 100;

/**
 * How old a finalised caption may be before it is dropped from the buffer and
 * skipped on backfill.
 *
 * This is live captions, not history — History has its own records, and a
 * caption older than a few hours on a display is never wanted there. A
 * service runs roughly ninety minutes, so two services back-to-back in a
 * morning both stay visible; yesterday's does not. This horizon also bounds
 * backfill(): a reconnect legitimately re-imports the service in progress
 * from ProdCom's own history, but must not re-import a service from days ago
 * just because ProdCom's history still happens to hold it — which is exactly
 * what put Thursday's lines on a display on a later day.
 */
const LINE_MAX_AGE_MS = 4 * 60 * 60_000;

/** Page size for backfill. 200 is the spec's documented maximum; the box clamps
 *  anything larger down to it rather than erroring. */
const BACKFILL_PAGE_SIZE = 200;

/**
 * Hard stop on backfill paging.
 *
 * `GET /api/v1/transcript` is ascending from the OLDEST entry and its pagination
 * is mandatory, so "fetch until hasMore is false" is the only correct way to
 * read it — and an unbounded loop against a box whose clock is wrong (making
 * `since` match everything) would walk its entire history. Twenty pages is 4000
 * lines, far more than four hours of speech, and hitting it is logged.
 */
const BACKFILL_MAX_PAGES = 20;

/** Don't re-fetch the channel list more often than this when a transcript line
 *  arrives on a channel id we have no colour for. A channel added mid-service is
 *  rare; a line on an unknown channel arriving many times a second is not. */
const CHANNEL_REFRESH_MIN_MS = 60_000;

// Coalesce interim partials (which arrive many/sec while someone speaks) into at most
// one full-buffer broadcast per this window; finals still push immediately.
const TRANSCRIPT_THROTTLE_MS = 250;

/**
 * How long an un-updated partial may sit in the buffer before it is dropped.
 *
 * A partial is removed when a FINAL arrives on the same channel key. That is the
 * only exit, and it stops being reachable the moment the channel key changes --
 * which is what renaming or re-routing a channel in ProdCom mid-service does. The
 * final for the speech already in flight then arrives under a NEW key, the old
 * entry is never deleted, and because getBuffer() appends partials after finals
 * it is pinned to the bottom of the display for the life of the process. That is
 * exactly what happened at a kickoff: one grey line stuck under everything all
 * night, reappearing at the bottom as real lines scrolled past it.
 *
 * Partials update many times a second while somebody is speaking, so an entry
 * untouched for this long is not slow speech -- it is speech whose final went
 * somewhere else. Generous enough that a real pause mid-sentence cannot trip it.
 */
const PARTIAL_TTL_MS = 30_000;

/**
 * How often the stale-partial sweep runs while a partial is held.
 *
 * pruneStalePartials() used to run only inside getBuffer(), which only executes
 * on a broadcast or an HTTP read. In a quiet room — nobody else speaking, no
 * poll hitting the backfill endpoint — a partial that went stale by the TTL
 * above would sit on every open display until the next unrelated line from
 * anyone nudged getBuffer(). This timer is the thing that notices on its own;
 * it only runs while `partials` is non-empty, and stops the moment it empties
 * (a final, a TTL drop, a clear, or a disconnect) so a quiet integration with no
 * partial in flight has nothing ticking in the background.
 */
const PARTIAL_SWEEP_MS = 5_000;

/**
 * A partial that has been in progress this long is worth a log line even when
 * it is behaving correctly (still updating, so the TTL above never touches
 * it) — an operator watching a stuck-looking line at 9pm on a Sunday needs to
 * be able to tell "this has genuinely been open for four minutes" from "the
 * display froze". Measured from firstSeenAt, not seenAt, so it reflects how
 * long the CHANNEL has been occupied, not how recently it last changed.
 */
const PARTIAL_LOG_AFTER_MS = 60_000;
/** How often the still-open log repeats for a partial that keeps surviving. */
const PARTIAL_LOG_REPEAT_MS = 5 * 60_000;

/**
 * Where a transcript entry can sit inside a WebSocket frame.
 *
 * The spec documents the control frames (`welcome`, `ping`) and the four stream
 * names, but NOT the envelope an event arrives in, and a 25-minute idle capture
 * of the live box produced only heartbeats — nobody spoke. So the envelope is the
 * one thing here that is not pinned. It is handled by looking for the entry
 * itself, identified by the two fields the spec marks required on every
 * TranscriptEntry (`text` and `channelId`), at the top level or one level down
 * in one of these keys — never by trusting an envelope name. Whichever shape
 * turns up is logged once per connection so the next person on site during a
 * service can pin it and delete the rest.
 */
const WS_ENTRY_CONTAINERS = ["data", "entry", "transcript", "payload"] as const;

/** `source` on a TranscriptEntry: what produced the line. Only `audio` is
 *  somebody speaking; see shouldCaption(). */
type EntrySource = "audio" | "typed" | "automation";

/**
 * The `source` of an entry that is NOT somebody speaking, or null when it is.
 *
 * The one place the rule lives. Two callers ask it for different reasons —
 * shouldCaption() decides what reaches a wall, and the silence check asks REST
 * whether anything was said while the socket was quiet — and a second copy of
 * "`audio`, or no field at all" would be a rule to forget to change twice.
 *
 * An entry with no `source` is speech: the field is required by the current
 * schema, but a build that predates it should not lose its captions, and must
 * not read as "nobody spoke" either. Returning the source rather than a boolean
 * is what lets shouldCaption name it in its log line without reading the field
 * a second time, or asserting a narrowing the type system cannot see.
 */
function nonAudioSource(entry: Record<string, unknown>): EntrySource | null {
  const source = str(entry, "source");
  return source === null || source === "audio" ? null : (source as EntrySource);
}

/** Is this entry somebody speaking? The same rule, read the other way round. */
function isSpokenAudio(entry: Record<string, unknown>): boolean {
  return nonAudioSource(entry) === null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === "string" && v.trim() ? v : null;
}
function bool(o: Record<string, unknown>, k: string): boolean | null {
  const v = o[k];
  return typeof v === "boolean" ? v : null;
}

/**
 * ISO 8601 to WHOLE SECONDS, which is the only form `?since=` accepts.
 *
 * ProdCom 2.3.2 parses `2026-09-11T00:00:00Z` and `2026-09-11T00:00:00+00:00`
 * and filters correctly. Given `2026-09-11T00:00:00.000Z` — exactly what
 * `Date#toISOString()` returns — it does not error, does not warn, and silently
 * ignores the parameter: `totalCount` comes back as the whole 3001-row history
 * and the first page is the oldest entry, five days old. The four-hour filter
 * then throws all fifty rows away and the display stays empty. Verified against
 * the live box: `.000Z` → totalCount 3001, `Z` → totalCount 387.
 */
function sinceParam(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Normalize a raw color value to a CSS color string, or null. Accepts hex with
 *  or without a leading "#" (3/4/6/8 digits) and passes through named colors. */
function normalizeColor(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^#?[0-9a-f]{3,8}$/i.test(s)) return s.startsWith("#") ? s : `#${s}`;
  return /^[a-z]+$/i.test(s) ? s : null; // CSS named color, else ignore
}

// ── Sensitive-keyword redaction ───────────────────────────────────────────────
//
// ProdCom has a first-class keyword system, global and per channel, and each
// keyword carries `isSensitive`. ProdCom's own interface replaces matched text
// with asterisks; this app rendered the same transcript verbatim on stage and
// lobby walls, so a word the operator explicitly marked sensitive was hidden on
// their screen and shown in full to the room.
//
// Two rules shape everything below:
//
//   The KEYWORD LIST NEVER LEAVES THE SERVER. If the flagged words are a
//   person's name, a diagnosis or "resignation", the list is exactly as
//   sensitive as the transcript. So no client-side matching, and no keyword in a
//   log line, an error message or a broadcast payload — only counts.
//
//   The BUFFER KEEPS THE RAW LINE. Redaction happens on the way out, in
//   getBuffer(), which is the one accessor every outward path goes through (the
//   SSE broadcast and GET /api/prodcom/transcript). getRawBuffer() is the
//   unredacted read, and only the token-gated diagnostic route calls it.

/**
 * Matching semantics, read from ProdCom's own OpenAPI document
 * (`GET /api/v1/openapi.yaml`, `components.schemas.Keyword`) rather than
 * invented here:
 *
 *   `text` — "Substring to match (case-insensitive)". SUBSTRING, so "cast"
 *            matches inside "broadcast"; no word boundaries are applied. That is
 *            deliberately wider than a word match: too narrow leaks the word.
 *   `isSensitive` — "When true, matched text is replaced with asterisks in the
 *            UI".
 *
 * The specification does NOT say how MANY asterisks, and it could not be probed:
 * the live box has no keywords configured at all (global and all 17 channel
 * lists came back empty) and creating one is a write against production gear.
 *
 * ONE ASTERISK PER MATCHED CHARACTER. Decided by the maintainer on 13 Sep 2026;
 * this is settled, not an open question. It keeps the sentence the same shape
 * and the same length, which is what a fixed-width caption feed wants. Do not
 * change it to a fixed run of asterisks to match some other product: preserving
 * the character count is the intent.
 *
 * A compiled regex per keyword, built once when the list is loaded rather than
 * per line: the alternative — lower-casing the haystack and using indexOf — is
 * wrong for a handful of characters whose lower-case form is a different LENGTH
 * (U+0130 "İ" lower-cases to two code units), which silently shifts every index
 * after it and redacts the wrong span.
 */
function keywordPattern(text: string): RegExp | null {
  const trimmed = text.trim();
  // An empty keyword would match at every position and asterisk the whole line.
  if (!trimmed) return null;
  return new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
}

/**
 * Replace every match of `patterns` in `text` with asterisks.
 *
 * Matches are collected over the ORIGINAL text and merged before anything is
 * replaced, so the result does not depend on the order of the keyword list: two
 * keywords that overlap, or that sit end to end, produce one asterisk run rather
 * than a different answer depending on which was applied first. `redactions` is
 * the number of contiguous runs — the same thing a reader could count off the
 * screen, so it tells an operator that something was hidden without telling them
 * how many words or which.
 *
 * Exported so the semantics above can be asserted directly; the service also
 * drives this on the real path.
 */
export function redactText(text: string, patterns: readonly RegExp[]): { text: string; redactions: number } {
  if (!text || patterns.length === 0) return { text, redactions: 0 };

  const spans: { start: number; end: number }[] = [];
  for (const pattern of patterns) {
    // matchAll does not advance the shared pattern's lastIndex — it works on an
    // internal clone — so one compiled regex is safe to reuse across lines.
    for (const m of text.matchAll(pattern)) {
      if (m[0].length === 0) continue;
      spans.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  if (spans.length === 0) return { text, redactions: 0 };

  spans.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    // `<=`, not `<`: two runs that touch render as one run of asterisks, so
    // counting them as two would report a boundary nothing on screen shows.
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  let out = "";
  let cursor = 0;
  for (const span of merged) {
    out += text.slice(cursor, span.start) + "*".repeat(span.end - span.start);
    cursor = span.end;
  }
  return { text: out + text.slice(cursor), redactions: merged.length };
}

/**
 * Compile the patterns for the keyword rows that are marked sensitive.
 *
 * Rows arrive as `GET /api/v1/keywords` and `GET /api/v1/channels/{id}/keywords`
 * return them. Only the two fields this app acts on are read; `shouldHighlight`,
 * `highlightColor` and `replacementText` are ProdCom's own display concerns and
 * are deliberately ignored — this masks what ProdCom masks, it does not restyle
 * the transcript.
 *
 * `isSensitive` must be exactly `true`. A missing flag is not sensitive: the
 * field is required by the schema, and treating absent as sensitive would
 * asterisk every highlight keyword on a box that omitted it.
 *
 * Exported for the semantics guard, which drives this and redactText() — the
 * same two functions the service calls.
 */
export function sensitivePatterns(rows: unknown[]): RegExp[] {
  const out: RegExp[] = [];
  for (const row of rows) {
    const rec = asRecord(row);
    if (!rec || bool(rec, "isSensitive") !== true) continue;
    const text = str(rec, "text");
    const pattern = text && keywordPattern(text);
    if (pattern) out.push(pattern);
  }
  return out;
}

/** One channel's in-progress partial, plus the bookkeeping the long-lived-
 *  partial diagnostics below read. */
type PartialEntry = {
  line: TranscriptLineDTO;
  /** OUR receive time of the last CHANGE (text or id differed) — drives the TTL. */
  seenAt: number;
  /** OUR receive time this channel's partial first appeared — drives the
   *  "in progress for Ns" diagnostic, independent of whether it keeps changing. */
  firstSeenAt: number;
  /** Identical re-sends (same id, same text) since firstSeenAt. */
  resendsUnchanged: number;
  /** Re-sends where the text actually differed from the previous one. */
  textChanges: number;
  /** Last time the "in progress" log fired for this entry, or null if never. */
  lastLoggedAt: number | null;
};

/** One finalised line plus OUR receive time — bookkeeping private to this
 *  service, the same way PartialEntry keeps its fields off the DTO the
 *  renderer sees. Only read when the line's own `at` (ProdCom's timestamp)
 *  doesn't parse, as the fallback age reference for LINE_MAX_AGE_MS. */
type FinalEntry = {
  line: TranscriptLineDTO;
  receivedAt: number;
};

/** What one backfill run did. Returned rather than logged in place so the caller
 *  owns the operator-facing line and a failure is not swallowed. */
export type BackfillResult = {
  added: number;
  skipped: number;
  pages: number;
  /** Set when a page failed; `added` still reports what landed before it. */
  error?: string;
};

/** What `/api/v1/channels` says about one channel. The colour lives HERE — a
 *  transcript entry has never carried one. */
type ChannelMeta = { name: string | null; color: string | null };

export class ProdComService extends ConnectionLifecycle {
  /** Wall clock, overridable so a test can age a partial without waiting 30s. */
  protected now(): number {
    return Date.now();
  }

  private host: string | null = null;
  private port: number | null = null;
  private apiKey: string | null = null;

  /**
   * The SSE fallback's request.
   *
   * Open from the moment this service connects until the WebSocket proves
   * itself, and reopened immediately if a promoted WebSocket later dies — never
   * torn down merely to let an unproven WebSocket attempt take its place.
   */
  private req: http.ClientRequest | null = null;
  /**
   * Whether the SSE fallback is actually streaming right now — true only from
   * its 200 response, false the moment that response ends, errors, or is torn
   * down (dropFallbackStream, which promotion and teardown both go through).
   *
   * `req` is not this: it is non-null from the instant the GET is issued, well
   * before ProdCom has answered at all, so a websocket attempt that finishes
   * (open, refused, or given up on) while that request is still connecting —
   * or after it already failed and the retry hasn't fired yet — must not read
   * `req` and conclude captions are flowing. Only a live response does that.
   */
  private sseUp = false;
  /** The WebSocket, whenever an attempt is open — proven or not. */
  private ws: WebSocket | null = null;
  /** Whether `ws` has completed its handshake, independent of whether it has
   *  been PROMOTED (see `onWebSocket`). Set in onopen, cleared by closeSocket(). */
  private wsOpen = false;
  private sseIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private wsHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  /** Armed while no WebSocket attempt is open and none is due yet — see
   *  WS_RETRY_INTERVAL_MS. */
  private wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Armed while a WebSocket attempt is open and has delivered no transcript
   *  entry yet — see WS_SILENCE_CHECK_MS. Disarmed for good the moment one
   *  arrives. */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * How many rows `GET /api/v1/transcript` held when the current socket opened.
   *
   * The silence check's baseline, and deliberately a COUNT rather than a time.
   *
   * A ProdCom is an appliance and its clock is its own — the Ultritouch panel on
   * this network runs about seven hours fast, with no NTP. "Are there rows dated
   * after <a time from OUR clock>" is therefore not a question about whether
   * anybody spoke; it is a question about the difference between two clocks, and
   * it fails in both directions. A box stamping fast answers yes for lines
   * spoken before the socket ever opened, so a healthy socket is condemned,
   * `wsSilentBox` latches, and `/log` accuses the vendor of a bug that is not
   * there. A box stamping slow answers no for ever, so the bug this check exists
   * for goes undetected with the suite green.
   *
   * The row count has no such failure: ProdCom's transcript is append-only and
   * ascending from the oldest row, so "rows beyond the count we saw at open" is
   * exactly "rows added since we opened", decided without reading a timestamp on
   * either side. applyBackfillRows's four-hour horizon is the same hazard
   * handled differently, and it works there only because four hours absorbs the
   * skew; a sixty-second window absorbs none of it.
   *
   * Null when no WebSocket attempt is open, or when the count could not be
   * read — and the check does nothing at all without it, because not knowing is
   * not the same as knowing nothing was missed.
   */
  private wsBaselineRows: number | null = null;
  /** Whether the current socket has ever delivered a transcript entry — once
   *  true, PROMOTED. Does not mean the silence check is done for good: it
   *  keeps running post-promotion too (see wsDeliveredThisWindow), because
   *  ProdCom 2.3.2's websocket is known to deliver once and then go quiet
   *  while still answering heartbeats. */
  private wsDelivered = false;
  /**
   * Delivered at least one transcript entry since the silence check's timer
   * was last armed — the post-promotion equivalent of `!wsDelivered` above,
   * which the check can no longer use once `wsDelivered` is permanently true.
   *
   * Read and reset to false at the start of each post-promotion check: a
   * window where this is true is a window the socket proved itself in, no
   * REST call needed. A window where it is false is what triggers asking
   * ProdCom whether anything was actually said.
   */
  private wsDeliveredThisWindow = false;
  /** Per-connection: whether the "continuing from row N" line has already
   *  fired once for a check that ran out of pages without finding either a
   *  spoken row or the end of ProdCom's history. See
   *  advanceSilenceCheckBaseline(). */
  private silenceCheckCapLogged = false;

  /**
   * Whether `{"type":"subscribe","events":["transcript"]}` is suspected of being
   * the thing that swallows the transcript, so it is no longer sent.
   *
   * Set when a socket that DID send it was shown to have missed spoken lines.
   * ProdCom's own OpenAPI document specifies that frame for exactly this
   * purpose, so it is sent first; if asking for the transcript stream yields
   * nothing while the default (nothing sent) yields everything, the filter is
   * broken and this is what carries that finding to the next connection.
   *
   * Survives a reconnect — a vendor bug does not fix itself between sockets —
   * and is cleared only by configure(), so an operator pointing the integration
   * at a different box, or at a build that has been upgraded, starts clean.
   */
  private wsSubscribeFilterSuspect = false;

  /**
   * Whether this box accepts a WebSocket and carries nothing on it, in EITHER
   * subscription mode.
   *
   * Two things key off it, and both are about not thrashing: the socket stops
   * being preferred (WS_SILENT_RETRY_EVERY, WS_SILENT_RETRY_INTERVAL_MS), and a
   * socket opened to such a box is on probation — it gets one check interval to
   * deliver something and is dropped otherwise, with no REST call, because the
   * question has already been answered for this box.
   *
   * Cleared the moment any socket delivers a transcript entry, and by
   * configure().
   */
  private wsSilentBox = false;
  /**
   * Whether the MOST RECENT attempt to end (give up, or drop after promotion)
   * did so because the box carried nothing, as opposed to any other reason —
   * refused, dropped, timed out.
   *
   * `wsSilentBox` alone is not this: it says the box has EVER been shown
   * silent, and stays true across a later attempt that was refused outright, a
   * different and fresher problem. connectSse's own card message used to read
   * `wsSilentBox` directly, so an SSE reconnect after a known-silent box
   * started refusing the upgrade kept blaming the old silence instead of
   * matching what giveUpOnUnprovenWebSocket had just reported about THIS
   * attempt. Reset by configure(); not read while promoted, since SSE is not
   * running then.
   */
  private wsLastGiveUpWasSilence = false;

  /** Whether a WebSocket attempt is due right now — true after configure() and
   *  the moment a socket proves delivery, false the moment an attempt gives up
   *  without proving itself. Consulted by connect() (an SSE reconnect is also a
   *  chance to try again) and by armWebSocketRetry() (no need for a clock while
   *  one is already due or already open). Reset by configure(), so an operator
   *  who has just fixed the box gets an immediate attempt rather than waiting
   *  out the counter. */
  private useWebSocket = true;
  private sseReconnects = 0;
  /** One refused-upgrade probe at a time — two sockets closing before open must
   *  not put two extra requests on a box that is already unhappy. */
  private wsProbeInFlight = false;
  /** The probe's request while it is in flight, so teardown() can take its
   *  socket with it rather than leaving it reading from a box the operator has
   *  just disconnected from. */
  private wsProbeRequest: http.ClientRequest | null = null;
  /** Bumped by teardown(), so work that was in flight when a stop() or a
   *  configure() landed can tell that it no longer speaks for this service. */
  private connectionEpoch = 0;
  /**
   * Whether the WebSocket has been PROMOTED: it has delivered at least one
   * transcript entry on the current connection, and the SSE fallback has been
   * closed in its favour. This — not merely having opened — is "the live
   * transport is the websocket" everywhere in this file, including the
   * `onWebSocketTransport` test seam.
   */
  private onWebSocket = false;

  /**
   * The WebSocket's outage, so a give-up or a fall-back says so ONCE.
   *
   * A box with the API off fails the upgrade on every single reconnect, and the
   * fallback line used to be unconditional: an outage wrote "websocket
   * unavailable … falling back" every few seconds for as long as it lasted. Same
   * rule as SenSource's and OBS's — first failure, a reminder every 15 minutes
   * carrying the attempt count, and one line when it comes back.
   */
  private readonly wsOutages = new OutageLog(this.wsOutageSettleMs);

  /** id → {name, colour} from GET /api/v1/channels. */
  private channels = new Map<string, ChannelMeta>();
  private channelsFetchedAt = 0;
  private channelRefreshInFlight = false;
  /** Serialised form of the last "prodcom:channels" broadcast, so a throttled
   *  refresh that came back identical (the common case) does not push a frame
   *  nobody's list actually changed. Null until the first broadcast. */
  private lastChannelsBroadcast: string | null = null;

  /**
   * Compiled patterns for every keyword ProdCom marks `isSensitive`, split the
   * way ProdCom scopes them: global ones apply to every line, channel-scoped
   * ones only to that channel.
   *
   * These are the only place the flagged words exist in this process, and
   * nothing reads them except redactLine(). They are never serialised, never
   * broadcast and never logged.
   */
  private globalSensitive: RegExp[] = [];
  private channelSensitive = new Map<string, RegExp[]>();
  /** Counts of the last load, so the log line fires on a CHANGE rather than on
   *  every throttled refresh. Null until the first load of a connection. */
  private lastKeywordSummary: string | null = null;
  /** One "redaction is running" line per connection — see noteRedaction(). */
  private redactionLogged = false;

  /**
   * Whether sensitive keywords are hidden on the way out. ON by default, because
   * ProdCom's own interface redacts them and matching that is the unsurprising
   * behaviour. Off restores the previous behaviour exactly.
   *
   * This decides what crosses the wire, not what a browser draws with: a
   * client-side toggle would mean the raw text had already left the server.
   */
  private redactSensitive = true;

  /** Per-connection "log this once" flags, cleared in teardown(). */
  private wsEnvelopeLogged = false;
  private wsUnknownFrameLogged = false;
  /** One line per connection the first time a line arriving on both transports
   *  is suppressed as a duplicate rather than broadcast twice — see ingest(). */
  private duplicateFinalLogged = false;
  private skippedSources = new Map<string, number>();

  private seq = 0;
  private transcriptTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptDirty = false;

  /** Finalised lines (rolling) + the current partial per channel.
   *
   *  `seenAt` is OUR receive time, not the payload's -- the timestamp in a
   *  ProdCom event is whatever that box's clock said, and this is used to decide
   *  whether an entry has gone stale, which must not depend on a peer's clock. */
  private finals: FinalEntry[] = [];
  private partials = new Map<string, PartialEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Channel keys already logged as "final with no matching partial" since the
   *  current connection started — one log per key per connection, not one per
   *  occurrence, or a channel stuck in that state would spam the log forever. */
  private orphanFinalLogged = new Set<string>();

  /** Test seam: whether the stale-partial sweep is currently armed. */
  protected get partialSweepActive(): boolean {
    return this.sweepTimer !== null;
  }

  /** Test seam: whether the WebSocket has been PROMOTED — proven by a delivered
   *  transcript entry, with the SSE fallback closed in its favour. */
  protected get onWebSocketTransport(): boolean {
    return this.onWebSocket;
  }

  /** Test seam: whether a WebSocket attempt is currently open (handshake
   *  complete), proven or not. True during probation and every re-test; does
   *  NOT imply the SSE fallback is closed — see onWebSocketTransport for that. */
  protected get wsAttemptOpen(): boolean {
    return this.wsOpen;
  }

  /** Test seam: whether the SSE fallback is actually streaming right now — see
   *  `sseUp`'s own comment for why this is not simply "req is non-null". */
  protected get sseStreamUp(): boolean {
    return this.sseUp;
  }

  /** Test seam: the row count the silence check measures this socket against. */
  protected get wsBaseline(): number | null {
    return this.wsBaselineRows;
  }

  /**
   * Test seams for the two real-time constants.
   *
   * The WebSocket tests drive a real socket against a real local ProdCom stub,
   * so `t.mock.timers` is not an option — faking setTimeout under undici's
   * WebSocket breaks the client itself. Overriding these instead lets a test
   * exercise the genuine "heartbeat stopped, reconnect" and "fall back, then
   * retry the WebSocket" paths in milliseconds rather than minutes.
   */
  protected get heartbeatTimeoutMs(): number {
    return WS_HEARTBEAT_TIMEOUT_MS;
  }
  protected get streamIdleMs(): number {
    return STREAM_IDLE_MS;
  }
  protected get reconnectMs(): number {
    return RECONNECT_MS;
  }
  protected get wsRetryIntervalMs(): number {
    return WS_RETRY_INTERVAL_MS;
  }
  protected get wsSilentRetryIntervalMs(): number {
    return WS_SILENT_RETRY_INTERVAL_MS;
  }
  protected get wsSilenceCheckMs(): number {
    return WS_SILENCE_CHECK_MS;
  }
  /**
   * How long after a failure a success still counts as a gap in the same outage
   * rather than the end of it — OutageLog's settle window, with its own default.
   *
   * A seam because the thing it guards is slow by construction: a known-silent
   * box's socket is re-tested half an hour after it was dropped, which is well
   * past any settle window, so "did the re-test print a recovery line" cannot be
   * observed at all while the window is longer than the whole test.
   */
  protected get wsOutageSettleMs(): number {
    return DEFAULT_SETTLE_MS;
  }
  protected get probeDeadlineMs(): number {
    return PROBE_DEADLINE_MS;
  }

  /** Test seam: whether the fallback's WebSocket retry is currently armed. */
  protected get wsRetryArmed(): boolean {
    return this.wsRetryTimer !== null;
  }

  /** Test seam: whether this box has been shown to accept a socket and carry
   *  nothing on it. */
  protected get boxKnownSilent(): boolean {
    return this.wsSilentBox;
  }

  /** Test seam: the SSE stream's REST prime (channels, keywords, then backfill),
   *  so a test can await the same work instead of polling. */
  protected priming: Promise<void> = Promise.resolve();
  /** Test seam: the WebSocket attempt's own priming — just the silence check's
   *  row-count baseline, read fresh on every attempt. Deliberately separate from
   *  `priming` above: the two attempts open independently, and whichever
   *  transport's onopen runs second must not overwrite the other's promise out
   *  from under a test awaiting it. */
  protected wsBaselinePriming: Promise<void> = Promise.resolve();

  constructor() {
    super("prodcom", "prodcom:transcript");
  }

  protected get configured(): boolean {
    return !!this.host && !!this.port;
  }

  configure(host: string, port: number, apiKey: string | null): void {
    this.host = host?.trim() || null;
    this.port = port > 0 ? Math.floor(port) : null;
    this.apiKey = apiKey?.trim() || null;
    this.useWebSocket = true;
    this.sseReconnects = 0;
    // Nothing learned about the old box or the old key is true of the new one,
    // and carrying the run across would swallow the first line of the next
    // outage. The same applies to what was learned about its WebSocket: an
    // operator who has just upgraded ProdCom, restarted it, or pointed this at a
    // different box gets a clean first attempt WITH the documented subscribe
    // frame and the narrow retry rules, rather than inheriting a verdict about
    // gear that is no longer on the other end.
    this.wsOutages.forget();
    this.wsSubscribeFilterSuspect = false;
    this.wsSilentBox = false;
    this.wsLastGiveUpWasSilence = false;
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.configured) return;
    console.log(`[prodcom] connecting ${this.host}:${this.port}`);
    super.start();
  }

  protected override teardown(): void {
    this.connectionEpoch += 1;
    this.clearSseIdleWatchdog();
    // stop(), restart() and configure() all land here — one clear covers all
    // three, the way each watchdog's does.
    this.clearWebSocketRetry();
    this.dropFallbackStream();
    // A probe outlives the connection that started it otherwise: its result is
    // already discarded by the epoch check, but the socket would go on reading.
    this.wsProbeRequest?.destroy();
    this.wsProbeRequest = null;
    this.closeSocket();
    this.onWebSocket = false;
    this.wsEnvelopeLogged = false;
    this.wsUnknownFrameLogged = false;
    this.duplicateFinalLogged = false;
    // Per-CONNECTION, unlike wsSubscribeFilterSuspect and wsSilentBox above,
    // which describe the BOX and are cleared by configure() alone.
    this.wsBaselineRows = null;
    this.wsDelivered = false;
    this.wsDeliveredThisWindow = false;
    this.silenceCheckCapLogged = false;
    this.skippedSources.clear();
    // A new connection re-reads the keyword list and says so again. The list
    // itself is deliberately KEPT across the teardown: if the re-read fails,
    // still redacting with the last known words is the safe direction, and
    // dropping them would silently un-redact every display.
    this.lastKeywordSummary = null;
    // Same reasoning as the keyword summary above: a fresh connection announces
    // its channel list at least once, even to a client that was already
    // watching one that happened to look identical.
    this.lastChannelsBroadcast = null;
    this.redactionLogged = false;
    // In-flight speech does not survive the stream. Whatever was mid-utterance
    // when the connection went will be re-sent or finalised on the other side; an
    // orphan kept here would sit under every real line until a restart. Finals are
    // deliberately kept, so a reconnect does not blank a display mid-service.
    this.partials.clear();
    this.syncPartialSweep();
    // A new connection is a new epoch for the renamed-channel diagnostic below —
    // whatever channel keys existed before this reconnect are gone with it.
    this.orphanFinalLogged.clear();
  }

  private closeSocket(): void {
    // Before the early return: a check armed for a socket that has already gone
    // (ws.onclose nulls `this.ws` itself) must not outlive it. Every other path
    // that abandons a socket comes through here.
    this.clearSilenceCheck();
    this.clearWsHeartbeatWatchdog();
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    this.wsOpen = false;
    // Drop the handlers first: close() fires 'close', which would otherwise
    // schedule a reconnect for a socket we are deliberately discarding.
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    // No try/catch: close() with no arguments cannot throw in any readyState —
    // the only failure the spec defines is an out-of-range code or an oversized
    // reason, and neither is passed. An empty catch here would have been a
    // swallow guarding nothing.
    ws.close();
  }

  /**
   * Restart the SSE fallback's silence timer. Called on connect and on every
   * chunk. Independent of the WebSocket's own heartbeat watchdog below — the two
   * transports can both be open at once, and each needs its own clock, because
   * neither transport's silence proves anything about the other.
   */
  private armSseIdleWatchdog(): void {
    this.clearSseIdleWatchdog();
    this.sseIdleTimer = setTimeout(() => {
      console.warn(`[prodcom] no transcript data for ${this.streamIdleMs / 1000}s — treating the stream as dead`);
      this.report("error", "Transcript stream went silent — reconnecting");
      this.dropFallbackStream();
      this.scheduleReconnect();
    }, this.streamIdleMs);
    this.sseIdleTimer.unref?.();
  }

  private clearSseIdleWatchdog(): void {
    if (this.sseIdleTimer) clearTimeout(this.sseIdleTimer);
    this.sseIdleTimer = null;
  }

  /**
   * Restart the WebSocket's heartbeat watchdog. Armed on open and on every
   * frame, including the heartbeat itself.
   *
   * closeSocket() nulls `ws.onclose` before closing, precisely so a socket we are
   * deliberately discarding here does not also run through the close handler's
   * own give-up/demote logic — so this timer has to make that same decision
   * itself: a socket that was PROMOTED (delivering) is demoted back to SSE: one
   * that never proved itself just gives up and waits for its turn on the retry
   * cadence, exactly as a refused upgrade does. Either way the SSE fallback is
   * either already carrying captions or is about to be.
   */
  private armWsHeartbeatWatchdog(): void {
    this.clearWsHeartbeatWatchdog();
    this.wsHeartbeatTimer = setTimeout(() => {
      console.warn(
        `[prodcom] no websocket frame for ${Math.round(this.heartbeatTimeoutMs / 1000)}s — ` +
          `heartbeat missed, treating the connection as dead`,
      );
      const wasPromoted = this.onWebSocket;
      this.closeSocket();
      if (wasPromoted) {
        this.onWebSocket = false;
        this.report("disconnected", null);
        this.demoteToSse("the websocket stopped answering (heartbeat missed)");
      } else {
        this.giveUpOnUnprovenWebSocket("the websocket stopped answering (heartbeat missed)");
      }
    }, this.heartbeatTimeoutMs);
    this.wsHeartbeatTimer.unref?.();
  }

  private clearWsHeartbeatWatchdog(): void {
    if (this.wsHeartbeatTimer) clearTimeout(this.wsHeartbeatTimer);
    this.wsHeartbeatTimer = null;
  }

  /**
   * Let the SSE fallback's request go, deliberately.
   *
   * The field is nulled BEFORE the destroy, which is what makes the
   * `if (this.req !== req) return;` guards in connectSse fire: destroying our own
   * request reaches that request's own error handler, and without this it read as
   * the stream DROPPING — countSseReconnect(), then scheduleReconnect(), then
   * connect(), which could reopen a second stream beside one still finishing its
   * own teardown. Exactly the rule closeSocket() has always followed for the
   * WebSocket: drop the handlers first, then close.
   *
   * The idle watchdog is cleared here too, not left to the caller: every path
   * that drops the stream on purpose (promotion, teardown) must disarm the
   * timer that assumes the stream is still there, or a promoted WebSocket that
   * is carrying captions perfectly well gets its card flipped to "Transcript
   * stream went silent" up to streamIdleMs later, for a stream that was closed
   * on purpose rather than one that actually went quiet.
   */
  private dropFallbackStream(): void {
    this.clearSseIdleWatchdog();
    this.sseUp = false;
    const req = this.req;
    this.req = null;
    req?.destroy();
  }

  /**
   * Come back to the WebSocket on a clock while no attempt is currently open.
   *
   * Armed only once a WebSocket attempt has given up without proving itself —
   * see the `useWebSocket` guard below — and, against a box that has no
   * WebSocket, it costs one refused upgrade plus the one HTTP probe that
   * diagnoses it (see probeThenGiveUp), every five minutes, nothing more. The
   * attempt is made BESIDE the live SSE stream, exactly like every other WebSocket
   * attempt in this file: nothing about a periodic re-test is different from the
   * first one, which is what stops a re-test costing a fresh SSE stream, a
   * channel read, a keyword read or a 200-line backfill, and stops it feeding
   * countSseReconnect and the reconnect back-off with a drop that never happened.
   *
   * Nothing is logged per retry against a box that REFUSES the upgrade: the
   * outage is already reported once by noteWebSocketDown with a 15-minute
   * reminder, and `websocket is back` is the signal that matters. A box that
   * ACCEPTS the upgrade and carries nothing is different — the retry costs a REST
   * call and a closed socket — so that one is logged every time, by
   * runSilenceCheck.
   */
  private armWebSocketRetry(): void {
    this.clearWebSocketRetry();
    if (this.useWebSocket) return; // already on it, or already about to try
    // A box that refuses the upgrade costs nothing to ask again; one that
    // accepts it and says nothing costs a REST call and a closed socket every
    // time. See WS_SILENT_RETRY_INTERVAL_MS.
    const interval = this.wsSilentBox ? this.wsSilentRetryIntervalMs : this.wsRetryIntervalMs;
    this.wsRetryTimer = setTimeout(() => {
      this.wsRetryTimer = null;
      if (!this.running || this.onWebSocket || this.ws || !this.host || !this.port) return;
      this.connectWebSocket(this.host, this.port);
    }, interval);
    this.wsRetryTimer.unref?.();
  }

  private clearWebSocketRetry(): void {
    if (this.wsRetryTimer) clearTimeout(this.wsRetryTimer);
    this.wsRetryTimer = null;
  }

  // ── The socket that opens and says nothing ────────────────────────────────

  /**
   * Ask, once the socket has been up this long with nothing delivered, whether
   * anything was missed.
   *
   * Armed on every open and re-armed after every inconclusive answer, and
   * disarmed for good by closeSocket() or by the first transcript entry to
   * arrive. A socket that is carrying the transcript never runs this and never
   * costs a REST call.
   */
  private armSilenceCheck(): void {
    this.clearSilenceCheck();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      void this.runSilenceCheck();
    }, this.wsSilenceCheckMs);
    this.silenceTimer.unref?.();
  }

  private clearSilenceCheck(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  /**
   * Whether the check still has a question to ask ABOUT `ws`: the WebSocket is
   * the live transport and `ws` is still the socket this service holds.
   *
   * Deliberately says nothing about whether `ws` has delivered — the check
   * runs both before promotion (has it delivered ANYTHING yet) and after
   * (has it stopped, having once delivered), and the caller is what tells
   * those apart. Re-read after every await regardless: a frame can land, or
   * the socket can be replaced, while REST is out.
   *
   * Identity, not `this.ws !== null`, and the difference is the whole point.
   * `connectionEpoch` is bumped only by teardown(), and an ordinary drop does
   * not tear down — ws.onclose calls scheduleReconnect(), which opens the next
   * socket without touching the epoch. So a REST answer about socket A, arriving
   * after A dropped and B opened, passed a null check and a matching epoch and
   * was applied to B seconds into its life: a verdict computed over a window
   * that was not B's, condemning a box that may be working. In production the
   * read has four seconds to run and the reconnect base is one, so it takes one
   * slow transcript read coinciding with one drop.
   */
  private silenceCheckStillOpen(ws: WebSocket | null): boolean {
    return this.running && this.wsOpen && ws !== null && this.ws === ws;
  }

  /**
   * One transcript entry has arrived over the socket. The FIRST one proves it
   * and — unless it already is — promotes it to the live transport. Every one
   * after that marks the current silence-check window as accounted for, which
   * is what lets the check keep running post-promotion instead of trusting one
   * frame for the rest of the connection's life.
   *
   * Also the only thing that clears wsSilentBox, which is the point: a box is
   * "silent" until a socket delivers, not until a socket opens. noteWebSocketHealthy
   * already fires on every frame INCLUDING the heartbeat, which is exactly why it
   * could not be used for this.
   *
   * Protected, not private: prodcom-backoff.test.ts's synthetic suite (no real
   * socket, connect() a no-op) uses it as the seam for "the transport is
   * promoted", the one precondition its ramp-reset tests need.
   */
  protected noteWebSocketDelivered(): void {
    // Unconditional, unlike everything below: a promoted socket calls this on
    // every delivered frame, not just its first.
    this.wsDeliveredThisWindow = true;
    if (this.wsDelivered) return;
    this.wsDelivered = true;
    // Housekeeping, not the guard: this just saves the wake-up for a check
    // that is about to be re-armed in promoteWebSocket() anyway.
    this.clearSilenceCheck();
    // useWebSocket is NOT set here: connect() only opens a WebSocket attempt
    // when it is already true, so reaching a delivered frame on a still-open
    // socket proves it was true already — nothing between this attempt's own
    // open and this frame could have cleared it without also closing this
    // exact socket, which would have stopped any further frame arriving.
    if (this.wsSilentBox) {
      this.wsSilentBox = false;
      console.log(
        `[prodcom] the websocket is carrying the transcript again ` +
          `(${this.wsSubscribeFilterSuspect ? "no subscribe frame sent" : "subscribed to the transcript stream"}) — ` +
          `captions stay on it`,
      );
    } else if (this.wsSubscribeFilterSuspect) {
      console.log(
        `[prodcom] the websocket delivers the transcript with no subscribe frame sent — ` +
          `ProdCom's subscribe filter is what was swallowing it`,
      );
    }
    if (!this.onWebSocket) this.promoteWebSocket();
  }

  /**
   * Move captions onto the WebSocket now that it has proven delivery, and close
   * the SSE fallback that was carrying them until this moment.
   *
   * This is the ONLY place the WebSocket becomes the live transport — opening it,
   * subscribing, and even a healthy heartbeat all prove the PEER is alive, not
   * that the SUBSCRIPTION delivers, which is the gap ProdCom 2.3.2 sits in.
   *
   * Promotion is not permanent on the strength of this one frame: ProdCom
   * 2.3.2's websocket is known to deliver once and then go quiet while still
   * answering heartbeats, which is the original incident. armSilenceCheck()
   * keeps the same REST-backed check running on the same clock — see
   * runSilenceCheck's onWebSocket branch for what it does differently now
   * that the socket is trusted rather than on probation.
   */
  private promoteWebSocket(): void {
    this.onWebSocket = true;
    this.dropFallbackStream();
    console.log(
      `[prodcom] the websocket delivered a transcript entry — captions move to it and the SSE fallback closes`,
    );
    this.report("connected", `Streaming from ${this.host}:${this.port}`);
    this.armSilenceCheck();
    // A final still in flight on SSE the instant its stream is destroyed here
    // is not lost — one backfill catches whatever the teardown cut off.
    if (this.host && this.port) this.priming = this.backfillNow(this.host, this.port);
  }

  /**
   * How many rows ProdCom's transcript holds in total, right now.
   *
   * Deliberately NO `?since=`. The number has to mean the same thing when it is
   * compared against a later one, and any window pinned to this server's clock
   * moves between the two reads while any window pinned to ProdCom's needs
   * ProdCom's clock — which is exactly what wsBaselineRows exists to avoid
   * reading. `limit=1` because only `meta.totalCount` is wanted; the row itself
   * is discarded.
   *
   * Returns null rather than throwing: a baseline that could not be read is not
   * a baseline of zero, and the caller must be able to tell those apart.
   */
  private async readTranscriptRowCount(host: string, port: number): Promise<number | null> {
    let body: string;
    try {
      body = await this.getJson(host, port, "/api/v1/transcript?limit=1&offset=0");
    } catch (e) {
      console.warn(
        `[prodcom] could not read the transcript row count (${scrub(errorMessage(e))}) — ` +
          `this connection has no baseline, so a websocket that delivers nothing will not be noticed`,
      );
      return null;
    }
    const total = asRecord(asRecord(safeJson(body))?.["meta"])?.["totalCount"];
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
      console.warn(
        `[prodcom] the transcript row count was missing from ProdCom's response — ` +
          `this connection has no baseline, so a websocket that delivers nothing will not be noticed`,
      );
      return null;
    }
    return Math.floor(total);
  }

  /**
   * Has anything been SAID that this socket never delivered?
   *
   * Asked as "are there spoken rows beyond the row count we saw when the socket
   * opened", which is a question about ProdCom's own append-only ordering and
   * reads no timestamp on either side. See wsBaselineRows for why a timestamp
   * cannot answer it: the two clocks are independent, and the error in either
   * direction is worse than the bug being looked for.
   *
   * Pages forward only while the answer is still "no", which on any real box is
   * one request: the first page beyond the baseline either holds speech or holds
   * fewer than a full page. It has to page at all because the endpoint is
   * ascending from the OLDEST row, so that page is the FIRST twenty rows added
   * since the socket opened, not the most recent — and a run of `typed` or
   * `automation` rows longer than a page would otherwise read as "nobody spoke"
   * on every check for the life of the connection, the baseline being fixed.
   *
   * Returns the failure rather than logging it, because the two answers this can
   * give — "nothing was missed" and "I could not ask" — must not be confused,
   * and only the caller knows that acting on the second is what breaks a working
   * transport.
   *
   * Also returns `scannedRows` — exactly how many rows this call read, whether
   * or not any were speech — and `hitCap`: whether the loop ran out of pages
   * before reaching either a spoken row or the end of ProdCom's current
   * history. Both exist so the caller can move `wsBaselineRows` forward past
   * whatever it just confirmed is non-speech. Without that, a run of
   * `typed`/`automation` rows longer than the cap pins the baseline for good:
   * every later check re-reads this same window and answers "nothing missed"
   * even once real speech lands past it.
   */
  private async spokenLinesBeyond(
    host: string,
    port: number,
    baselineRows: number,
  ): Promise<
    { ok: true; spoken: number; scannedRows: number; hitCap: boolean } | { ok: false; error: string }
  > {
    let spoken = 0;
    let scannedRows = 0;
    let hitCap = true;
    for (let page = 0; page < WS_SILENCE_CHECK_MAX_PAGES; page++) {
      const offset = baselineRows + page * WS_SILENCE_CHECK_PAGE_SIZE;
      const path = `/api/v1/transcript?limit=${WS_SILENCE_CHECK_PAGE_SIZE}&offset=${offset}`;
      let body: string;
      try {
        body = await this.getJson(host, port, path);
      } catch (e) {
        // Returned, not logged: the caller is the only place that knows "could
        // not ask" must not be acted on like "nothing was said".
        return { ok: false, error: errorMessage(e) };
      }
      const parsed = asRecord(safeJson(body));
      const data = parsed?.["data"];
      if (!Array.isArray(data)) return { ok: false, error: "response had no data array" };
      scannedRows += data.length;
      for (const row of data) {
        const entry = asRecord(row);
        if (entry && isSpokenAudio(entry)) spoken++;
      }
      if (spoken > 0 || data.length === 0) {
        hitCap = false;
        break;
      }
      if (asRecord(parsed?.["meta"])?.["hasMore"] !== true) {
        hitCap = false;
        break;
      }
    }
    return { ok: true, spoken, scannedRows, hitCap };
  }

  /**
   * After a check finds nothing (`answer.spoken === 0`), move the baseline past
   * every row that check actually confirmed non-speech — never past a row it
   * has not yet read, since `scannedRows` only ever counts rows this call
   * fetched.
   *
   * `hitCap` names the one shape worth an operator's attention: the loop ran
   * out of pages before finding either a spoken row or the end of ProdCom's
   * history, which is exactly the run of typed/automation rows that used to
   * pin this check for good. Logged once per connection — a chatty comms
   * channel would otherwise repeat the line every check interval and bury the
   * rest of the log, the way the REST-outage line once did before it moved to
   * OutageLog.
   */
  private advanceSilenceCheckBaseline(baseline: number, scannedRows: number, hitCap: boolean): void {
    if (scannedRows <= 0) return;
    const next = baseline + scannedRows;
    this.wsBaselineRows = next;
    if (!hitCap || this.silenceCheckCapLogged) return;
    this.silenceCheckCapLogged = true;
    console.warn(
      `[prodcom] the silence check scanned ${WS_SILENCE_CHECK_MAX_PAGES} pages of non-speech rows without ` +
        `finding the end of them — continuing from row ${next} next time`,
    );
  }

  /**
   * The check itself. Three outcomes, and the two that do nothing matter most.
   *
   * Every log line here is one an operator reads at 9am on a Sunday to answer
   * "why is the captions strip empty": whether the socket was silent, how many
   * lines it had missed, which retry was tried, and which transport is carrying
   * captions now.
   */
  private async runSilenceCheck(): Promise<void> {
    const host = this.host;
    const port = this.port;
    // The socket this verdict will be about, captured before any await so the
    // re-checks below can tell it apart from whatever replaced it.
    const ws = this.ws;
    if (!this.silenceCheckStillOpen(ws) || !host || !port) return;
    // everyMs, not Math.round(ms / 1000): the seam these tests override is
    // milliseconds, and raw rounding prints "in 0s" for it. The helper exists
    // for exactly that.
    const quiet = everyMs(this.wsSilenceCheckMs);

    if (this.onWebSocket) {
      await this.runPromotedSilenceCheck(host, port, ws, quiet);
      return;
    }

    // Probation. This box has already been shown to accept a socket and carry
    // nothing on it, with AND without the subscribe frame, so the burden of
    // proof is on the socket rather than on REST: deliver something inside one
    // check interval or go back to the transport that works. No REST call —
    // the question was answered the first time.
    if (this.wsSilentBox) {
      console.warn(
        `[prodcom] the websocket has carried no transcript in ${quiet} and this box has failed ` +
          `that test before — captions stay on the SSE fallback, and the next re-test will connect ` +
          `${this.alternateSubscribeMode()}`,
      );
      this.giveUpOnUnprovenWebSocket(SILENT_SOCKET_REASON);
      return;
    }

    // Without a baseline there is no question to ask. readTranscriptRowCount has
    // already said so once, at connect, on the line that explains the
    // consequence; repeating it every minute for the life of the connection
    // would bury the rest of the log.
    const baseline = this.wsBaselineRows;
    if (baseline === null) {
      console.debug(`[prodcom] websocket quiet for ${quiet}, but this connection has no transcript baseline`);
      this.armSilenceCheck();
      return;
    }

    // Captured before the await, the same way probeThenGiveUp does: a stop()
    // or a configure() landing while REST is out means this answer is about a
    // box this service has already let go.
    const epoch = this.connectionEpoch;
    const answer = await this.spokenLinesBeyond(host, port, baseline);
    if (epoch !== this.connectionEpoch || !this.silenceCheckStillOpen(ws)) return;

    if (!answer.ok) {
      // "No lines" and "could not ask" are indistinguishable from here, and
      // acting on the second is how a transport that is working gets torn down.
      //
      // Through OutageLog, like every other repeated failure in this file: the
      // check re-arms every interval, so an unreachable REST endpoint under a
      // socket that is up wrote this line 1440 times a day into a 10,000-line
      // ring. First failure, a reminder every fifteen minutes carrying the
      // count, and one line when it comes back.
      const out = this.wsOutages.fail("silence-check", answer.error, this.now());
      if (out.log) {
        console.warn(
          `[prodcom] could not check whether the websocket is missing transcript lines ` +
            `(${scrub(answer.error)}) — leaving it alone and asking again in ${quiet}${out.note}`,
        );
      }
      this.armSilenceCheck();
      return;
    }
    const askable = this.wsOutages.ok("silence-check", this.now());
    if (askable.log) console.log(`[prodcom] the silent-socket check can reach ProdCom again${askable.note}`);
    if (answer.spoken === 0) {
      // Nothing was said in what this check actually scanned — advance past it.
      // debug, not log: a quiet room is not an event, and this repeats for as
      // long as the room stays quiet.
      this.advanceSilenceCheckBaseline(baseline, answer.scannedRows, answer.hitCap);
      console.debug(`[prodcom] websocket quiet for ${quiet}, and ProdCom has no spoken lines since it opened`);
      this.armSilenceCheck();
      return;
    }

    if (!this.wsSubscribeFilterSuspect) {
      // The strong hypothesis: ProdCom's `subscribe` frame acts as a filter and
      // the filter is broken, so asking for ["transcript"] yields nothing where
      // the default yields everything. One reconnect to find out, and if it is
      // right the socket keeps working for every site running this build.
      this.wsSubscribeFilterSuspect = true;
      console.warn(
        `[prodcom] websocket delivered no transcript in ${quiet} while ProdCom has at least ` +
          `${answer.spoken} spoken line(s) since it opened — reopening it without the subscribe frame`,
      );
      this.reopenWebSocketUnsubscribed(host, port);
      return;
    }

    this.wsSilentBox = true;
    console.warn(
      `[prodcom] websocket delivered no transcript with or without the subscribe frame, while ProdCom has ` +
        `at least ${answer.spoken} spoken line(s) since it opened — captions stay on the SSE fallback, ` +
        `the websocket is re-tested every ${everyMs(this.wsSilentRetryIntervalMs)} instead of every ` +
        `${everyMs(this.wsRetryIntervalMs)}, and every ${WS_SILENT_RETRY_EVERY} reconnect(s) ` +
        `instead of every ${WS_RETRY_EVERY}, starting ${this.alternateSubscribeMode()}`,
    );
    this.giveUpOnUnprovenWebSocket(SILENT_SOCKET_REASON);
  }

  /**
   * The silence check's post-promotion mode: the socket has already proven
   * itself once, so the question is no longer "has it EVER delivered" but "is
   * it STILL delivering" — ProdCom 2.3.2 is known to answer heartbeats forever
   * on a socket that has stopped carrying the transcript, which is the
   * original incident this whole file exists to catch.
   *
   * A window the socket delivered anything in costs no REST call — same
   * principle as probation, just re-checked every window instead of asked
   * once — but the baseline still has to move forward on that window, or the
   * NEXT silent window's REST read would find every already-delivered line
   * sitting past a baseline that never advanced and misread routine silence
   * as a miss.
   */
  private async runPromotedSilenceCheck(
    host: string,
    port: number,
    ws: WebSocket | null,
    quiet: string,
  ): Promise<void> {
    const deliveredThisWindow = this.wsDeliveredThisWindow;
    this.wsDeliveredThisWindow = false;

    if (deliveredThisWindow) {
      const epoch = this.connectionEpoch;
      const fresh = await this.readTranscriptRowCount(host, port);
      if (epoch !== this.connectionEpoch || !this.silenceCheckStillOpen(ws)) return;
      if (fresh !== null) this.wsBaselineRows = fresh;
      this.armSilenceCheck();
      return;
    }

    const baseline = this.wsBaselineRows;
    if (baseline === null) {
      console.debug(`[prodcom] promoted websocket quiet for ${quiet}, but this connection has no transcript baseline`);
      this.armSilenceCheck();
      return;
    }

    const epoch = this.connectionEpoch;
    const answer = await this.spokenLinesBeyond(host, port, baseline);
    if (epoch !== this.connectionEpoch || !this.silenceCheckStillOpen(ws)) return;
    if (this.wsDeliveredThisWindow) {
      // A frame landed while REST was out — this window is accounted for
      // after all. Leave the verdict to the next one rather than act on a
      // read that was already stale by the time it arrived.
      this.armSilenceCheck();
      return;
    }

    if (!answer.ok) {
      // Exactly probation's tolerance: "no lines" and "could not ask" must
      // not be confused, or an unreachable REST endpoint under a socket that
      // is genuinely still working tears down a transport that was fine.
      const out = this.wsOutages.fail("silence-check", answer.error, this.now());
      if (out.log) {
        console.warn(
          `[prodcom] could not check whether the promoted websocket is missing transcript lines ` +
            `(${scrub(answer.error)}) — leaving it alone and asking again in ${quiet}${out.note}`,
        );
      }
      this.armSilenceCheck();
      return;
    }
    const askable = this.wsOutages.ok("silence-check", this.now());
    if (askable.log) console.log(`[prodcom] the silent-socket check can reach ProdCom again${askable.note}`);

    if (answer.spoken === 0) {
      // Quiet room, not a silent socket. Same rule as probation: advance past
      // what this check actually scanned, never past a row it has not read.
      this.advanceSilenceCheckBaseline(baseline, answer.scannedRows, answer.hitCap);
      console.debug(`[prodcom] promoted websocket quiet for ${quiet}, and ProdCom has no spoken lines since`);
      this.armSilenceCheck();
      return;
    }

    // Proven once, silent since: demote rather than trust the one frame that
    // promoted it. demoteToSse() reopens SSE, whose own connect primes REST
    // (channels, keywords, backfill) and so covers the gap this leaves.
    this.wsSilentBox = true;
    this.wsLastGiveUpWasSilence = true;
    console.warn(
      `[prodcom] the promoted websocket delivered no transcript in ${quiet} while ProdCom has at least ` +
        `${answer.spoken} spoken line(s) it never carried — falling back to the SSE stream, which backfills ` +
        `the gap, and re-testing the websocket every ${everyMs(this.wsSilentRetryIntervalMs)} instead of every ` +
        `${everyMs(this.wsRetryIntervalMs)} from here`,
    );
    this.closeSocket();
    this.onWebSocket = false;
    this.report("disconnected", null);
    this.demoteToSse("stopped delivering while promoted — ProdCom shows spoken lines it never carried");
  }

  /**
   * Swap the subscription the NEXT socket to this box will use, and name it.
   *
   * wsSubscribeFilterSuspect used to be a one-way latch, cleared only by
   * configure(). Once set, every re-test for the life of the process connected
   * WITHOUT the subscribe frame — so if ProdCom ships a build that fixes the
   * subscription and makes the frame mandatory, which is what its own OpenAPI
   * document implies is the intent, every half-hourly re-test would open
   * unsubscribed, receive nothing, be dropped by probation a minute later, and
   * repeat: a caption gap every thirty minutes on a box that has been FIXED.
   * That is precisely what widening the interval instead of removing it was
   * meant to avoid.
   *
   * Alternating costs nothing — consecutive re-tests were going to happen anyway
   * — and means the client cannot be permanently wrong about which of the two
   * shapes this box wants. Called from both fallback paths, so the flip happens
   * exactly once per re-test whichever one took it.
   */
  private alternateSubscribeMode(): string {
    this.wsSubscribeFilterSuspect = !this.wsSubscribeFilterSuspect;
    return this.wsSubscribeFilterSuspect ? "without the subscribe frame" : "with the subscribe frame";
  }

  /**
   * Reconnect immediately, sending no `subscribe` frame.
   *
   * Not a teardown: the epoch is deliberately NOT bumped, because nothing this
   * connection started is being abandoned — the priming reads are already done
   * and the buffer is kept, exactly as it is across any other reconnect.
   */
  private reopenWebSocketUnsubscribed(host: string, port: number): void {
    this.closeSocket();
    this.wsEnvelopeLogged = false;
    this.wsUnknownFrameLogged = false;
    this.connectWebSocket(host, port);
  }

  /** Drop partials nothing has updated for PARTIAL_TTL_MS. Returns whether any
   *  went. Protected, not private: a test seam so the TTL rule can be checked
   *  without waiting on PARTIAL_SWEEP_MS's real setInterval. */
  protected pruneStalePartials(): boolean {
    const cutoff = this.now() - PARTIAL_TTL_MS;
    let dropped = false;
    for (const [ch, entry] of this.partials) {
      if (entry.seenAt > cutoff) continue;
      this.partials.delete(ch);
      dropped = true;
      console.log(`[prodcom] dropped a stale partial on channel ${scrub(ch)} — no final arrived`);
    }
    this.syncPartialSweep();
    return dropped;
  }

  /** OUR reference time for a final: its own `at` when parseable, else the
   *  time we received it (see FinalEntry). */
  private finalTimestamp(entry: FinalEntry): number {
    const parsed = Date.parse(entry.line.at);
    return Number.isNaN(parsed) ? entry.receivedAt : parsed;
  }

  /** Drop finalised lines older than LINE_MAX_AGE_MS. Returns whether any went. */
  private pruneStaleFinals(): boolean {
    const cutoff = this.now() - LINE_MAX_AGE_MS;
    const before = this.finals.length;
    this.finals = this.finals.filter((e) => this.finalTimestamp(e) >= cutoff);
    const dropped = before - this.finals.length;
    if (dropped > 0) console.log(`[prodcom] dropped ${dropped} line(s) older than 4h`);
    this.syncPartialSweep();
    return dropped > 0;
  }

  /**
   * Arm the sweep timer while a partial is held OR a final is in the buffer,
   * disarm it the moment both are empty. Called after every mutation of
   * `partials` or `finals` so the timer's lifetime tracks the buffer's
   * emptiness exactly, rather than depending on every call site to remember
   * every half. Finals age out on their own four-hour horizon (LINE_MAX_AGE_MS)
   * the same way partials age out on PARTIAL_TTL_MS, so both need the same
   * background sweep in a quiet room where nothing else calls getBuffer().
   */
  private syncPartialSweep(): void {
    if (this.partials.size > 0 || this.finals.length > 0) {
      if (this.sweepTimer) return;
      this.sweepTimer = setInterval(() => {
        const droppedPartials = this.pruneStalePartials();
        const droppedFinals = this.pruneStaleFinals();
        this.logLongLivedPartials();
        if (droppedPartials || droppedFinals) this.flushTranscript();
      }, PARTIAL_SWEEP_MS);
      this.sweepTimer.unref?.();
    } else if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Log a channel whose partial has been open a long time, whether or not it is
   * behaving correctly — a live monologue and a stuck line both look the same
   * from the outside ("still there"), and this is what tells them apart after
   * the fact. Fires once at PARTIAL_LOG_AFTER_MS, then at most once every
   * PARTIAL_LOG_REPEAT_MS while the same entry survives.
   */
  private logLongLivedPartials(): void {
    const now = this.now();
    for (const [ch, entry] of this.partials) {
      const age = now - entry.firstSeenAt;
      if (age < PARTIAL_LOG_AFTER_MS) continue;
      if (entry.lastLoggedAt != null && now - entry.lastLoggedAt < PARTIAL_LOG_REPEAT_MS) continue;
      entry.lastLoggedAt = now;
      const lastUpdateAgo = Math.round((now - entry.seenAt) / 1000);
      console.log(
        `[prodcom] partial on channel ${scrub(ch)} in progress for ${Math.round(age / 1000)}s — ` +
          `${entry.resendsUnchanged} unchanged re-sends, ${entry.textChanges} text changes, ` +
          `last update ${lastUpdateAgo}s ago, ${entry.line.text.length} chars`,
      );
    }
  }

  /**
   * Empty the transcript.
   *
   * Both halves, because the stuck-line case needs the partials gone and an
   * operator asking for a clear means the screen, which is the finals. Broadcasts
   * unconditionally: the point is that the display goes empty NOW.
   *
   * Logs each partial being discarded BEFORE clearing — the operator's button
   * is the only cure for the stuck-line bug this file guards against, so the
   * moment it's pressed is the moment to record which channel was stuck, for
   * how long, and how it behaved, in case it happens again.
   */
  clearTranscript(): void {
    const now = this.now();
    for (const [ch, entry] of this.partials) {
      const age = Math.round((now - entry.firstSeenAt) / 1000);
      console.log(
        `[prodcom] transcript cleared by operator: ${this.finals.length} finals, ${this.partials.size} partials; ` +
          `partial ch=${scrub(ch)} age=${age}s unchanged-resends=${entry.resendsUnchanged} text-changes=${entry.textChanges}`,
      );
    }
    this.finals = [];
    this.partials.clear();
    this.syncPartialSweep();
    broadcast("prodcom:transcript", this.getBuffer());
    console.log("[prodcom] transcript cleared");
  }

  /**
   * Current rolling buffer (finals + active partials), oldest → newest, AS IT
   * LEAVES THIS PROCESS — sensitive keywords already replaced with asterisks
   * unless the operator turned that off.
   *
   * Every outward path goes through here: every `broadcast()` in this file, and
   * `GET /api/prodcom/transcript`, which a freshly-loaded display reads for its
   * backfill. That route is the half of this that is easy to miss — redacting
   * only the broadcast leaves a display showing the unredacted word for its
   * first paint and hiding it from the next line on. Redaction lives in the
   * accessor rather than at each call site precisely so the NEXT outward path,
   * whatever it is, cannot be added unredacted.
   *
   * Cost is not worth caching. Measured at 0.19 ms to redact a full 100-line
   * buffer against 20 sensitive keywords, and broadcasts are throttled to four a
   * second — under 1 ms/s of CPU, for which a memo keyed on a keyword-list
   * generation would be more machinery than the work it skips.
   */
  getBuffer(): TranscriptLineDTO[] {
    return this.getRawBuffer().map((line) => this.redactLine(line));
  }

  /**
   * The buffer exactly as ProdCom sent it.
   *
   * The only caller is the token-gated diagnostic route — an operator reviewing
   * afterwards needs to be able to read what was hidden. Everything else calls
   * getBuffer(). Keeping the raw line here is what makes redaction
   * non-destructive: nothing overwrites the text, it is masked on the way past.
   */
  getRawBuffer(): TranscriptLineDTO[] {
    this.pruneStalePartials();
    this.pruneStaleFinals();
    return [...this.finals.map((e) => e.line), ...[...this.partials.values()].map((e) => e.line)];
  }

  /**
   * ProdCom's own channel list, straight from `GET /api/v1/channels` — every
   * channel the box has, whether or not it has ever spoken.
   *
   * Sorted by name (falling back to id) so the renderer's list order does not
   * depend on Map insertion order, which is ProdCom's own response order and
   * not something either side has promised the other.
   */
  getChannels(): ProdcomChannelDTO[] {
    return [...this.channels.entries()]
      .map(([id, meta]) => ({ id, name: meta.name, color: meta.color }))
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  }

  /** Hide sensitive keywords, or don't, per the operator's setting. */
  private redactLine(line: TranscriptLineDTO): TranscriptLineDTO {
    if (!this.redactSensitive) return line;
    const scoped = line.channel ? this.channelSensitive.get(line.channel) : undefined;
    const patterns = scoped?.length ? [...this.globalSensitive, ...scoped] : this.globalSensitive;
    if (patterns.length === 0) return line;
    const { text, redactions } = redactText(line.text, patterns);
    if (redactions === 0) return line;
    this.noteRedaction(line.channel);
    return { ...line, text, redactions };
  }

  /**
   * One line per connection, the first time anything is actually hidden.
   *
   * An operator looking at a wall of asterisks at 9am on a Sunday needs to be
   * able to tell "ProdCom keywords are doing this on purpose" from "the feed is
   * broken". Not per line — a keyword that matches a common word would fill the
   * log — and never the word, the count or the matched text.
   */
  private noteRedaction(channel: string | null): void {
    if (this.redactionLogged) return;
    this.redactionLogged = true;
    console.log(
      `[prodcom] hiding text that matches a keyword marked sensitive in ProdCom ` +
        `(first seen on channel ${scrub(channel ?? "none")}) — ` +
        `the unredacted lines are at /api/prodcom/transcript/raw`,
    );
  }

  /**
   * Turn keyword redaction on or off.
   *
   * Separate from configure() because it changes what is SENT, not what is
   * connected — an operator flipping it must not drop the stream and re-run
   * backfill. Re-broadcasts on a change so every open display updates at once
   * instead of waiting for the next person to speak.
   */
  setRedactSensitive(on: boolean): void {
    if (this.redactSensitive === on) return;
    this.redactSensitive = on;
    console.log(
      on
        ? "[prodcom] sensitive keywords will be hidden on displays"
        : "[prodcom] sensitive-keyword redaction turned OFF — displays show the transcript in full",
    );
    broadcast("prodcom:transcript", this.getBuffer());
  }

  /**
   * One-shot connectivity check for the Integrations "Test connection" button.
   *
   * Hits `/api/v1/status`, not the transcript stream: it is the endpoint the spec
   * provides for exactly this, it answers immediately instead of holding a
   * connection open, and its body names the version and channel count — which is
   * what an operator needs to know they reached the right box.
   */
  async test(host: string, port: number, apiKey: string | null): Promise<{ ok: boolean; message?: string }> {
    return new Promise((resolve) => {
      const req = http.get(
        {
          host,
          port,
          path: "/api/v1/status",
          headers: { ...this.authHeaders(apiKey), Accept: "application/json" },
          timeout: 4000,
        },
        (res) => {
          const code = res.statusCode ?? 0;
          if (code < 200 || code >= 300) {
            res.destroy();
            resolve({ ok: false, message: `ProdCom returned HTTP ${code}` });
            return;
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (body += c));
          res.on("end", () => {
            const data = asRecord(asRecord(safeJson(body))?.["data"]);
            const version = data ? str(data, "version") : null;
            const count = data && typeof data["channelCount"] === "number" ? data["channelCount"] : null;
            const detail = [version && `ProdCom ${version}`, count != null && `${count} channels`]
              .filter(Boolean)
              .join(", ");
            resolve({
              ok: true,
              message: detail ? `${detail} at ${host}:${port}` : `Connected to ProdCom at ${host}:${port}`,
            });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ ok: false, message: e.message }));
    });
  }

  /**
   * The one auth scheme ProdCom declares.
   *
   * The spec's `components.securitySchemes` has exactly one entry, `bearerAuth`
   * (`type: http, scheme: bearer`): "include the API key in the Authorization
   * header: `Bearer <key>`". This used to also send `X-API-Key` on the theory
   * that "the auth header name isn't documented". It is, and it isn't that.
   *
   * Auth only — every caller adds its own Accept. This used to hard-code
   * `Accept: text/event-stream`, which then rode along on the JSON reads and,
   * once the WebSocket landed, on the upgrade request too (confirmed on the wire
   * against the live box).
   */
  private authHeaders(apiKey: string | null): Record<string, string> {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  /**
   * ProdCom's first retry is fast — 4s rather than the base's 3s — because a
   * transcript that reconnects minutes late has already missed the sentence it
   * existed to show.
   *
   * It is only the FIRST retry that matters for that. This used to override
   * scheduleReconnect() to a flat 4s forever, which meant a box that was off all
   * week was dialled every four seconds all week, ignoring the service window
   * every other integration respects. The ramp is reset the moment a transport
   * comes up (see noteWebSocketHealthy and the SSE response handler), so a real
   * drop mid-service still retries in 4s.
   */
  protected override get reconnectBaseMs(): number {
    return this.reconnectMs;
  }

  /**
   * Ensure the SSE fallback is connected, and — when one is due — open a
   * WebSocket attempt beside it.
   *
   * This is the ONLY place either transport is started from a cold stop (the
   * base class's start()/scheduleReconnect() cycle), and it owns both: the SSE
   * stream is what makes captions live the moment this runs, and the WebSocket
   * attempt is what may later promote itself over it (see promoteWebSocket()).
   * A timer left over from the last stream must not fire into an attempt that is
   * already in flight, so this clears the wall-clock WebSocket retry — it is
   * re-armed once a transport is actually up.
   */
  protected async connect(): Promise<void> {
    this.clearWebSocketRetry();
    if (!this.running || !this.host || !this.port) return;
    // Guarded, not unconditional: connect() can run again while the WebSocket is
    // already PROMOTED (a natural SSE hiccup must not happen while promoted, but
    // nothing schedules connect() in that state either — this is belt-and-braces
    // against opening a second SSE stream beside a working WebSocket) and while
    // one is already in flight (`this.req` only goes null once its handlers say
    // so — see the SSE handlers below).
    if (!this.req && !this.onWebSocket) this.connectSse(this.host, this.port);
    if (this.useWebSocket && !this.ws) this.connectWebSocket(this.host, this.port);
  }

  // ── WebSocket transport ───────────────────────────────────────────────────

  /**
   * Open `GET /api/v1/ws`, beside whatever the SSE fallback is doing.
   *
   * Auth goes in the `Authorization` header rather than the `?key=` query
   * parameter the spec offers as an alternative, so the pre-shared key does not
   * land in ProdCom's own activity log (which records request paths). Node's
   * WebSocket takes headers through an options bag that the DOM lib's type does
   * not describe, hence the one cast; prodcom-websocket.test.ts asserts the
   * header actually arrives, so a Node release that stopped forwarding it turns
   * the suite red instead of silently 401-ing in production.
   *
   * Every attempt — the very first one, the unsubscribed reopen, and every
   * later re-test — is the SAME shape: opened beside the SSE stream, and never
   * touching it. Only delivering a transcript entry (see noteWebSocketDelivered
   * and promoteWebSocket) closes the fallback; opening, subscribing and even a
   * healthy heartbeat prove nothing about the SUBSCRIPTION, which is exactly the
   * gap ProdCom 2.3.2 sits in. Giving up on an attempt that never proves itself
   * costs no fallback to reopen, no SSE reconnect counted, and no back-off
   * advanced, because the SSE stream was never touched to make the attempt —
   * it does still cost the one HTTP probe a refusal always triggers (see
   * probeThenGiveUp), which is deliberate diagnosis, not waste.
   */
  private connectWebSocket(host: string, port: number): void {
    // Never assign over a live socket: that puts it beyond closeSocket()'s reach
    // for the life of the process.
    //
    // Belt-and-braces, and deliberately kept as such. With the `this.req !== req`
    // guards in connectSse there is no longer a reachable path that arrives here
    // holding a live socket, so this line cannot be made to fail a test and no
    // guard claims it does. It is one line standing between an assignment and a
    // leaked connection that already got through one review, and the rule it
    // states — close before you replace — is the same one closeSocket() itself
    // follows.
    this.closeSocket();
    const url = `ws://${host}:${port}/api/v1/ws`;
    let ws: WebSocket;
    try {
      ws = new (WebSocket as unknown as new (u: string, o?: { headers?: Record<string, string> }) => WebSocket)(url, {
        headers: this.authHeaders(this.apiKey),
      });
    } catch (e) {
      this.giveUpOnUnprovenWebSocket(errorMessage(e));
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.wsOpen = true;
      this.sseReconnects = 0;
      // Null until primeWsBaseline reads it below, so a baseline belonging to
      // the socket this one replaced can never be used to judge this one.
      this.wsBaselineRows = null;
      this.wsDelivered = false;
      this.wsDeliveredThisWindow = false;
      this.noteWebSocketHealthy();
      // Only while this box is known to carry nothing does the card need to say
      // a re-test is under way — the SSE stream is reporting "Streaming from
      // host:port" throughout, proven or not, and this only overrides it for the
      // one minute the re-test runs. That override is only truthful while SSE
      // is actually up: an unproven socket opening says nothing about whether
      // captions are flowing anywhere, so while SSE is down this reports
      // nothing and leaves the card on whatever SSE's own path last said.
      if (this.sseUp) {
        this.report("connected", this.wsSilentBox ? RETESTING_CARD_MESSAGE : `Streaming from ${host}:${port}`);
      }
      // Only the transcript stream is consumed here. The live box offers
      // transcript / status / automation / activity (the spec's list says
      // "channel" instead of "activity" and is wrong about that).
      //
      // Unless this build of ProdCom has already been shown to deliver nothing
      // when asked (wsSubscribeFilterSuspect), in which case the frame is
      // omitted and whatever the box sends by default is taken instead. Frames
      // that are not transcript entries are already ignored, and logged once.
      if (!this.wsSubscribeFilterSuspect) {
        ws.send(JSON.stringify({ type: "subscribe", events: ["transcript"] }));
      }
      this.armWsHeartbeatWatchdog();
      // A heartbeat proves the peer; only a transcript entry proves the
      // subscription. Until one arrives, this is what notices.
      this.armSilenceCheck();
      // Skipped for a box already known to carry nothing: this re-test either
      // gets dropped again without runSilenceCheck's wsSilentBox branch ever
      // reading wsBaselineRows, or it delivers and gets promoted — and
      // runPromotedSilenceCheck's first window re-reads the row count fresh
      // regardless, overwriting whatever this call would have found. Either
      // way the read is wasted; a box not yet known silent still needs it.
      if (!this.wsSilentBox) this.wsBaselinePriming = this.primeWsBaseline(host, port, ws);
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      // Any frame proves the peer is alive, heartbeat included — that is the
      // whole point of moving here. It is also what ends a WebSocket outage:
      // recovery is a transport that has HELD, not one that opened once.
      this.armWsHeartbeatWatchdog();
      this.noteWebSocketHealthy();
      this.handleWsFrame(typeof ev.data === "string" ? ev.data : String(ev.data));
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      // 'error' is always followed by 'close', which owns the reconnect. Doing it
      // here as well would queue two.
    };

    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      const wasOpen = this.wsOpen;
      this.ws = null;
      this.wsOpen = false;
      // The socket nulled itself, so closeSocket() — which is where every other
      // path clears these — is not on this one.
      this.clearWsHeartbeatWatchdog();
      this.clearSilenceCheck();
      if (this.onWebSocket) {
        // It was PROMOTED and went away: captions fall straight back to SSE,
        // with backfill covering whatever gap this leaves.
        this.onWebSocket = false;
        this.report("disconnected", null);
        this.demoteToSse(`the websocket dropped (${ev.reason || `code ${ev.code}`})`);
        return;
      }
      if (wasOpen) {
        // It opened, subscribed and exchanged frames, but never proved delivery
        // before dying. The SSE stream never stopped carrying captions, so this
        // is exactly as cheap as a refusal — wait for the next scheduled retry.
        this.giveUpOnUnprovenWebSocket(
          `the websocket closed before delivering a transcript entry (${ev.reason || `code ${ev.code}`})`,
        );
        return;
      }
      // It never opened. The box may be older than 2.3, may have the API off, or
      // may have rejected the key — the SSE stream, already carrying captions,
      // is what a display is reading regardless. Which of those it is does not
      // survive Node's WebSocket (see probeUpgrade), so ask the same URL over
      // plain HTTP before giving up on this attempt.
      void this.probeThenGiveUp(host, port, ev.reason || `closed before open (code ${ev.code})`);
    };
  }

  /**
   * Diagnose the refused upgrade, then give up on this attempt.
   *
   * `epoch` is captured before the probe's awaits. A configure() or a stop()
   * landing while the probe is in flight bumps it, and acting on a stale result
   * then would be acting on an answer about a box this service has already let
   * go — the same reason ensureRecord in service-recorder.ts captures a
   * generation.
   */
  private async probeThenGiveUp(host: string, port: number, bare: string): Promise<void> {
    const epoch = this.connectionEpoch;
    const probe = await this.probeUpgrade(host, port, bare);
    if (epoch !== this.connectionEpoch) return;
    this.giveUpOnUnprovenWebSocket(probe?.reason ?? bare, probe?.detail ?? null);
  }

  /**
   * Ask the WebSocket URL the same question over plain HTTP, and report what the
   * box actually said.
   *
   * Node's WebSocket exposes NO HTTP status for a refused handshake: a 426, a 401
   * and a box with no such route all arrive as `close` with code 1006 and an
   * empty reason. For two days in September 2026 the only evidence of a ProdCom
   * refusing every upgrade was `closed before open (code 1006)`, which says
   * nothing about whether the API was off, the key was wrong or the build was too
   * old. This is one extra request per refusal that turns that into
   * `upgrade refused with HTTP 426 (Upgrade Required)`.
   *
   * The headers are a real RFC 6455 handshake, so a box that WOULD upgrade
   * answers 101 here — which is itself a finding: the handshake is fine and the
   * socket is dying after it, which is a different bug from a refusal.
   *
   * `reason` is the outage KIND for noteWebSocketDown's dedupe, so it carries
   * only the status and its canonical phrase (from Node's own table, not the
   * wire): no byte counts, no timestamps, nothing that varies per attempt. The
   * body goes back separately as `detail`, scrubbed and truncated, and is logged
   * only on the line that actually prints.
   *
   * Never throws, and never rejects: a probe is diagnostics, and a failure to
   * diagnose must not stop this attempt from giving up and freeing the next one
   * to try. Three things enforce that, and each of them has been the difference
   * between an attempt that gives up and one that never does:
   *
   *   A DEADLINE, not Node's `timeout` option. That option fires on socket
   *   INACTIVITY, so a box answering the refusal with a chunked body that
   *   trickles a byte a second resets it for ever: reproduced in-process with a
   *   503 and one chunk per second, `wsProbeInFlight` was still true 12 s later
   *   and no further attempt could start (at the time this was found, that also
   *   meant the SSE fallback had not opened — before this fix the fallback did
   *   not exist until an attempt gave up, so the captions were gone for the rest
   *   of the service). `PROBE_DEADLINE_MS` is wall-clock from the request going
   *   out and cannot be pushed back by the peer.
   *
   *   A CAP ON READING. Once PROBE_BODY_BYTES have arrived there is nothing more
   *   to learn, so the response is finished there rather than read to its end —
   *   an endless body is a diagnostic, not a download.
   *
   *   A HELD REFERENCE. `wsProbeRequest` is what teardown() destroys, so a
   *   stop() or a configure() during a probe takes the socket with it instead of
   *   leaving it running against a box the operator has just disconnected from.
   */
  private probeUpgrade(
    host: string,
    port: number,
    bare: string,
  ): Promise<{ reason: string; detail: string | null } | null> {
    if (this.wsProbeInFlight) return Promise.resolve(null);
    this.wsProbeInFlight = true;
    return new Promise<{ reason: string; detail: string | null } | null>((resolve) => {
      let settled = false;
      let req: http.ClientRequest | null = null;
      const deadline = setTimeout(() => done(null), this.probeDeadlineMs);
      deadline.unref?.();
      const done = (result: { reason: string; detail: string | null } | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        this.wsProbeInFlight = false;
        this.wsProbeRequest = null;
        // Always, on every path. A probe socket left open holds its own timeout,
        // which keeps the process's event loop busy after the answer is already
        // known — visible as a test that asserts in 4 ms and takes 4 s to finish.
        req?.destroy();
        resolve(result);
      };

      try {
        req = http.request({
          host,
          port,
          path: "/api/v1/ws",
          method: "GET",
          timeout: PROBE_TIMEOUT_MS,
          headers: {
            ...this.authHeaders(this.apiKey),
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Version": "13",
            // A real key, because a box that validates the handshake would answer a
            // constant one differently from the client's own request.
            "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
            // Names itself, so this request is distinguishable from the real
            // client's upgrade in ProdCom's own activity log (which records
            // requests) — the live client sends `user-agent: node`.
            "User-Agent": PROBE_USER_AGENT,
          },
        });
      } catch (e) {
        // http.request throws SYNCHRONOUSLY on a header value Node will not put
        // on the wire (ERR_INVALID_CHAR — a newline or a non-latin1 character in
        // an API key, which undici's WebSocket accepts). Uncaught, that rejection
        // escapes probeThenGiveUp and this attempt never gives up at all.
        done({ reason: `probe failed: ${errorMessage(e)}`, detail: null });
        return;
      }
      this.wsProbeRequest = req;

      // 101: Node routes an accepted upgrade to 'upgrade', never to 'response'.
      req.on("upgrade", (_res, socket) => {
        socket.destroy();
        done({ reason: `upgrade accepted by a probe but the WebSocket ${bare}`, detail: null });
      });

      req.on("response", (res) => {
        const code = res.statusCode ?? 0;
        const phrase = http.STATUS_CODES[code];
        let body = "";
        const finish = () => {
          res.destroy();
          done({
            reason: `upgrade refused with HTTP ${code}${phrase ? ` (${phrase})` : ""}`,
            detail: body.slice(0, PROBE_BODY_BYTES).replace(/\s+/g, " ").trim() || null,
          });
        };
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length >= PROBE_BODY_BYTES) return;
          body += chunk;
          // Enough to name the refusal: stop reading rather than following a
          // body that may never end.
          if (body.length >= PROBE_BODY_BYTES) finish();
        });
        res.on("end", finish);
        res.on("error", finish);
      });

      req.on("timeout", () => req?.destroy(new Error("timed out")));
      req.on("error", (e) => done({ reason: `probe failed: ${errorMessage(e)}`, detail: null }));
      req.end();
    });
  }

  /**
   * Give up on a WebSocket attempt that never proved delivery — whether it was
   * refused, dropped before opening, timed out on its heartbeat, or was shown
   * silent by the check above. The SSE fallback, when it is actually up, is
   * untouched: it stays exactly as it was, and only the retry cadence and the
   * card's message change. When SSE is NOT up — this unproven attempt was
   * running against a box that is unreachable on both transports — there is
   * nothing here to truthfully call "connected", so nothing is reported and
   * the card is left on whatever SSE's own path already said.
   */
  private giveUpOnUnprovenWebSocket(reason: string, detail: string | null = null): void {
    this.closeSocket();
    this.useWebSocket = false;
    this.noteWebSocketDown(reason, detail, true);
    // Recorded regardless of the early returns below: connectSse's own card
    // message reads this on its NEXT (re)connect, whether or not this attempt
    // is the one that gets to report anything itself right now.
    this.wsLastGiveUpWasSilence = reason === SILENT_SOCKET_REASON;
    if (!this.running || !this.host || !this.port) return;
    // Keyed on THIS attempt's reason, not on wsSilentBox: a known-silent box that
    // starts refusing the upgrade outright is a different, fresher problem, and
    // the card must say so rather than keep blaming the earlier silence. Gated
    // on sseUp: giving up on an unproven socket may only OVERRIDE the card's
    // message while SSE is the thing actually carrying captions.
    if (this.sseUp) {
      this.report(
        "connected",
        this.wsLastGiveUpWasSilence ? SILENT_SOCKET_CARD_MESSAGE : `Streaming from ${this.host}:${this.port}`,
      );
    }
    this.armWebSocketRetry();
  }

  /**
   * A PROMOTED WebSocket died. Captions fall straight back to SSE — reopened
   * here, since promoting it is what closed the fallback in the first place —
   * with the existing backfill covering whatever gap this leaves. The retry
   * cadence starts over: this box just proved it works, so nothing about it is
   * "known silent", but the socket that proved it is gone and a fresh one has to
   * earn its way back the same as any other attempt.
   */
  private demoteToSse(reason: string): void {
    this.useWebSocket = false;
    this.noteWebSocketDown(reason, null, false);
    if (!this.running || !this.host || !this.port) return;
    this.connectSse(this.host, this.port);
  }

  /**
   * The WebSocket is unavailable. Says so once per outage.
   *
   * `reason` is the KIND, so a box that starts refusing the key after having
   * refused the upgrade is still news — but a thousand repeats of code 1006 are
   * one line. `detail` is whatever the box said in the body of a refused
   * handshake (see probeUpgrade): it can vary per attempt, so it rides on the
   * line rather than in the reason the dedupe keys on, and is only printed on the
   * line that actually prints.
   *
   * `stillOnFallback` says which is true: an unproven attempt gives up onto a
   * fallback that was never touched (captions STAY there), where a promoted
   * socket dying means the fallback is being reopened (captions ARE falling back
   * to it). Defaults to the second, so a direct caller — the reconnect back-off
   * suite drives this with no connection at all — gets the wording that always
   * describes a real transition.
   */
  protected noteWebSocketDown(reason: string, detail: string | null = null, stillOnFallback = false): void {
    const out = this.wsOutages.fail("websocket", reason, this.now());
    if (out.log) {
      console.warn(
        `[prodcom] websocket unavailable (${scrub(reason)}) — ` +
          (stillOnFallback
            ? this.sseUp
              ? `captions stay on the transcript SSE fallback${out.note}`
              : `captions have no live transport until SSE reconnects${out.note}`
            : `falling back to the transcript SSE stream${out.note}`) +
          (detail ? ` — the box said: ${scrub(detail)}` : ""),
      );
    }
  }

  /**
   * The WebSocket is carrying traffic. Called on open AND on every frame, which
   * is what gives OutageLog's settle window its meaning: a peer that accepts the
   * upgrade and drops it again has not recovered, and must not print one
   * "websocket is back" per flap.
   */
  protected noteWebSocketHealthy(): void {
    // Only a PROMOTED socket's health says anything about whether captions are
    // flowing — an unproven socket's heartbeat is the peer answering pings, not
    // evidence the box (or the network to it) is otherwise healthy. Resetting
    // the SSE ramp from it would let a box whose SSE/REST stack is broken but
    // whose WebSocket still heartbeats keep the fallback retrying at the
    // fastest interval forever, defeating the backoff entirely.
    if (this.onWebSocket) this.resetBackoff();
    // On a box already known to open a socket and carry nothing on it, opening
    // one again is not recovery — noteWebSocketDelivered decides that, and until
    // it does this socket is a minute from being dropped. The settle window
    // cannot catch this on its own: the re-tests are half an hour apart, so each
    // one looks like a fresh success and would print "websocket is back"
    // followed by a fallback line, every thirty minutes, indefinitely.
    if (this.wsSilentBox) return;
    const back = this.wsOutages.ok("websocket", this.now());
    if (back.log) console.log(`[prodcom] websocket is back${back.note}`);
  }

  /**
   * One WebSocket text frame.
   *
   * Control frames are matched on `type`; anything else is searched for a
   * transcript entry (see WS_ENTRY_CONTAINERS for why that search exists and how
   * far it goes).
   */
  private handleWsFrame(raw: string): void {
    // The envelope a transcript event arrives in is the one thing the spec does
    // not pin (see WS_ENTRY_CONTAINERS). `PRODCOM_DEBUG=1` logs every frame
    // verbatim, which is how somebody on site during a service can capture it
    // and replace the search with the single real key.
    if (process.env.PRODCOM_DEBUG) console.log(`[prodcom] RAW ws ${raw}`);

    const frame = asRecord(safeJson(raw));
    if (!frame) {
      this.logUnknownWsFrame(raw.slice(0, 80));
      return;
    }
    const type = str(frame, "type");

    if (type === "ping" || type === "heartbeat") {
      // The spec says "respond with the same"; the live box sends {"type":"ping"}
      // and accepts {"type":"pong"}. Echo whichever it used so a build that does
      // enforce the reply is satisfied either way.
      this.ws?.send(JSON.stringify({ type: type === "ping" ? "pong" : "heartbeat" }));
      return;
    }
    if (type === "pong") return;
    if (type === "welcome") {
      const streams = Array.isArray(frame["streams"]) ? (frame["streams"] as unknown[]).filter((s) => typeof s === "string") : [];
      console.log(`[prodcom] websocket open — streams offered: ${streams.length ? streams.join(", ") : "none listed"}`);
      return;
    }
    if (type === "error") {
      const message = str(frame, "message") ?? "no detail";
      console.warn(`[prodcom] websocket reported an error: ${message}`);
      return;
    }

    const found = findTranscriptEntry(frame);
    if (!found) {
      this.logUnknownWsFrame(`type=${type ?? "none"} keys=${Object.keys(frame).join(",")}`);
      return;
    }
    if (!this.wsEnvelopeLogged) {
      this.wsEnvelopeLogged = true;
      console.log(
        `[prodcom] websocket transcript frames carry the entry ` +
          `${found.at === null ? "at the top level" : `under "${found.at}"`}` +
          `${type ? ` (type=${type})` : ""}`,
      );
    }
    // Here rather than in acceptEntry(): what is being proven is that the SOCKET
    // delivers transcript entries, not that this particular one becomes a
    // caption. A `typed` entry is dropped by shouldCaption() and is still proof
    // the subscription works. acceptEntry is also the SSE fallback's path, where
    // there is no socket to prove.
    this.noteWebSocketDelivered();
    this.acceptEntry(found.entry);
  }

  /** One line per connection, whatever the frame was — a box emitting an
   *  unrecognised shape many times a second must not fill the log. */
  private logUnknownWsFrame(detail: string): void {
    if (this.wsUnknownFrameLogged) return;
    this.wsUnknownFrameLogged = true;
    console.warn(`[prodcom] websocket frame is not a transcript entry, ignoring it (${detail})`);
  }

  // ── SSE fallback transport ────────────────────────────────────────────────

  private connectSse(host: string, port: number): void {
    this.clearSseIdleWatchdog();
    const req = http.get(
      {
        host,
        port,
        path: "/api/v1/transcript/stream",
        headers: { ...this.authHeaders(this.apiKey), Accept: "text/event-stream" },
      },
      (res) => {
        if (this.req !== req) return;
        const code = res.statusCode ?? 0;
        if (code < 200 || code >= 300) {
          this.req = null;
          res.destroy();
          this.report("error", `ProdCom HTTP ${code}`);
          this.countSseReconnect();
          this.scheduleReconnect();
          return;
        }
        // The stream is open: the ramp has done its job, so the next drop
        // retries in 4s rather than wherever the back-off had climbed to.
        this.resetBackoff();
        this.sseUp = true;
        // A box whose LAST attempt ended because it carried nothing says so on
        // the card, whatever prompted THIS particular (re)connect. Keyed on
        // wsLastGiveUpWasSilence, not wsSilentBox: the box can go on to REFUSE
        // the upgrade outright on a later attempt, which is a different,
        // fresher problem than silence, and this must not keep blaming the
        // older one just because the box was once shown silent. It is still
        // "connected" either way, because captions ARE flowing: what is in
        // question is only the WebSocket, and that is what the message names.
        this.report(
          "connected",
          this.wsLastGiveUpWasSilence ? SILENT_SOCKET_CARD_MESSAGE : `Streaming from ${host}:${port}`,
        );
        this.priming = this.primeFromRest(host, port);
        res.setEncoding("utf8");
        this.armSseIdleWatchdog();
        // A healthy fallback never reconnects, so the every-third-reconnect rule
        // cannot fire — this is the clock that asks again anyway.
        this.armWebSocketRetry();

        // Parse text/event-stream via the shared reader — a new one per
        // connection, so a partial event does not survive a reconnect. It caps the
        // accumulation buffer and resyncs at the next separator on overflow; the
        // log line is ours because an operator needs to know WHICH stream lost
        // data.
        const reader = createSseReader({
          onOverflow: () =>
            console.warn(`[prodcom] transcript buffer exceeded ${SSE_MAX_BUFFER} bytes — resyncing`),
        });
        res.on("data", (chunk: string) => {
          if (this.req !== req) return;
          this.armSseIdleWatchdog();
          for (const event of reader.push(chunk)) this.handleSseEvent(event);
        });
        res.on("end", () => {
          if (this.req !== req) return;
          this.req = null;
          this.sseUp = false;
          this.clearSseIdleWatchdog();
          this.report("disconnected", null);
          this.countSseReconnect();
          this.scheduleReconnect();
        });
        res.on("error", (e) => {
          if (this.req !== req) return;
          this.req = null;
          this.sseUp = false;
          this.clearSseIdleWatchdog();
          this.report("error", `Transcript stream broke — ${e.message}`);
          this.countSseReconnect();
          this.scheduleReconnect();
        });
      },
    );
    this.req = req;
    // The real liveness check on this path — see SOCKET_KEEPALIVE_MS.
    keepSocketAlive(req, SOCKET_KEEPALIVE_MS);
    req.on("error", (e) => {
      if (this.req !== req) return;
      this.req = null;
      // A watchdog armed by the dying stream must not outlive it, or it can
      // destroy the NEXT request while it is still connecting.
      this.clearSseIdleWatchdog();
      this.report("error", `Can't reach ${host}:${port} — ${e.message}`);
      this.countSseReconnect();
      this.scheduleReconnect();
    });
  }

  /** Come back to the WebSocket periodically while stuck on the fallback — a box
   *  that was mid-restart, or had its API toggled, should not be on SSE until the
   *  next server restart. Both this and armWebSocketRetry() widen on a box whose
   *  socket opens and carries nothing; widening one and not the other would leave
   *  a flapping fallback re-testing a known-silent socket every few seconds. */
  private countSseReconnect(): void {
    this.sseReconnects++;
    const every = this.wsSilentBox ? WS_SILENT_RETRY_EVERY : WS_RETRY_EVERY;
    if (this.sseReconnects % every === 0) {
      // debug, not log: console.debug is the one level log-buffer does not
      // capture, so this stays out of /log. It is a routine step inside an
      // outage that is already reported once by noteWebSocketDown, with the
      // attempt count on its 15-minute reminder — an operator reading /log
      // wants the outage, not each probe inside it.
      console.debug(`[prodcom] retrying the websocket after ${this.sseReconnects} SSE reconnect(s)`);
      this.useWebSocket = true;
    }
  }

  // One SSE event block ("event: x\ndata: {...}"). Kept as the (string) entry
  // point the tests drive, and it goes through the same shared block parser the
  // live stream does.
  protected handleEvent(raw: string): void {
    const event = parseSseBlock(raw);
    if (event) this.handleSseEvent(event);
  }

  // (event:/id: names ignored — transcript framing is carried in the payload)
  private handleSseEvent({ data: payload }: SseEvent): void {
    if (!payload || payload === "[DONE]") return;
    if (process.env.PRODCOM_DEBUG) console.log(`[prodcom] RAW sse ${payload}`);
    const entry = asRecord(safeJson(payload));
    if (!entry) {
      // Every SSE event on this endpoint is "a JSON object representing a new,
      // updated, or completed transcript entry" per the spec. Anything else is
      // not a caption and must not reach a stage wall as one.
      console.warn(`[prodcom] transcript stream sent a frame that is not JSON, ignoring it (${payload.length} bytes)`);
      return;
    }
    this.acceptEntry(entry);
  }

  // ── Entry handling, shared by both transports ─────────────────────────────

  /** Normalise one TranscriptEntry and, if it is speech, put it in the buffer. */
  private acceptEntry(entry: Record<string, unknown>): void {
    const line = this.normalizeLine(entry);
    if (!line) return;
    if (!this.shouldCaption(entry)) return;
    this.ingest(line);
  }

  /**
   * Whether an entry belongs on a caption display.
   *
   * `source` is required on every TranscriptEntry and is one of `audio`, `typed`
   * or `automation`. Only the first is somebody speaking. The other two were
   * rendered identically until now, so an operator typing "cam 2 go wide" into a
   * comms channel put that sentence on the stage and lobby walls as though it had
   * been said aloud. An entry with no `source` at all is treated as speech — a
   * build that predates the field should not lose its captions.
   */
  private shouldCaption(entry: Record<string, unknown>): boolean {
    const source = nonAudioSource(entry);
    if (source === null) return true;
    const seen = (this.skippedSources.get(source) ?? 0) + 1;
    this.skippedSources.set(source, seen);
    if (seen === 1) {
      console.log(`[prodcom] not captioning "${source}" entries — they are not spoken audio`);
    }
    return false;
  }

  /**
   * One TranscriptEntry → one TranscriptLineDTO.
   *
   * Field names are the spec's, verified against 3001 rows on 2.3.2:
   *   { id, channelId, channelName?, text, source, inProgress, date,
   *     completeDate?, seenDate?, hasBeenSeen, translatedText?,
   *     triggeredAutomations? }
   * `inProgress: true` = interim/partial; the line is final when it is false.
   *
   * `triggeredAutomations` is deliberately ignored: it names the automations a
   * line fired, which is information for ProdCom's own UI, not for a caption.
   */
  private normalizeLine(entry: Record<string, unknown>): TranscriptLineDTO | null {
    const text = str(entry, "text");
    if (text == null) return null;
    const channel = str(entry, "channelId");

    // Colour and the display name come from GET /api/v1/channels, keyed by
    // channel id. A transcript entry has never carried a colour — this file used
    // to probe five different key names for one and every channel therefore fell
    // through to the UI's deterministic colour. The channel record is also the
    // CURRENT name, where the entry's `channelName` is denormalised at write time
    // and goes stale the moment a channel is renamed mid-service.
    const meta = channel ? this.channels.get(channel) : undefined;
    const channelName = meta?.name ?? str(entry, "channelName");
    const color = meta?.color ?? null;
    if (channel && !meta) this.refreshChannelsSoon();

    const inProgress = bool(entry, "inProgress");
    const isFinal = inProgress == null ? true : !inProgress;
    const id = str(entry, "id") ?? `t${++this.seq}`;
    const at = str(entry, "completeDate") ?? str(entry, "date") ?? new Date().toISOString();
    return { id, channel, channelName, color, text, isFinal, at };
  }

  /**
   * Apply one normalised line to the buffer.
   *
   * The one entry point both transports share while both are open, so a line
   * that arrives on each — the WebSocket beside the SSE stream it has not yet
   * displaced — is deduped here rather than twice, once per caller. Entries
   * carry ProdCom's own `id`, and that id is revised in place until `inProgress`
   * is false: a final replaces any existing entry with the same id (addFinal),
   * and a partial for an id already finalised is a straggler from whichever
   * transport is slower, not a resurrection.
   */
  private ingest(line: TranscriptLineDTO): void {
    const ch = line.channel ?? "_";
    if (line.isFinal) {
      const hadPartial = this.partials.has(ch);
      // The renamed-channel case from the incident this file guards against: a
      // final lands under a key with no partial to resolve, while OTHER
      // channels are mid-utterance. Once per channel per connection, or a
      // channel stuck in this state would spam the log on every final.
      if (!hadPartial && this.partials.size > 0 && !this.orphanFinalLogged.has(ch)) {
        this.orphanFinalLogged.add(ch);
        console.log(
          `[prodcom] final on channel ${scrub(ch)} with no partial in flight; ` +
            `${this.partials.size} partial(s) live on other channels`,
        );
      }
      this.partials.delete(ch);
      this.syncPartialSweep();
      const changed = this.addFinal(line);
      // Suppressing an unchanged final is only correct while a SECOND transport
      // is genuinely in the picture (`wsOpen`: an unproven WebSocket open beside
      // SSE) — that is the one window where "identical to what's already
      // stored" really does mean "the other transport just delivered this".
      // Outside it, an unchanged final still broadcasts: a consumer that
      // subscribed between two otherwise-identical deliveries (a freshly
      // enabled automation rule, a display that just mounted) has seen NEITHER
      // of them, and "the content matches what was already stored" says
      // nothing about what THAT listener has seen. The single-transport case
      // in prodcom-duplicate-broadcast.test.ts pins this.
      if (changed || !this.wsOpen) {
        this.flushTranscript(); // finals land immediately
      } else {
        this.noteDuplicateFinalSuppressed();
      }
    } else {
      // A partial for an id already on the buffer as a FINAL is the slower
      // transport's copy of speech the faster one already completed — applying
      // it would resurrect a finished line as an in-progress one, and getBuffer()
      // appends partials after finals, so it would reappear at the bottom of the
      // display under everything that has been said since.
      if (this.finals.some((e) => e.line.id === line.id)) return;

      // A re-send of the SAME partial (identical id and text) is not progress —
      // ProdCom re-emitting an interim result on a keepalive, or a recogniser
      // stalled on an open mic, both look like this. Only a genuine change
      // refreshes seenAt; an unchanged re-send keeps the original arrival time,
      // or the TTL below would never elapse no matter how long it sat there.
      // The same rule is what a duplicate delivered by the OTHER transport falls
      // under too — it re-arrives as an unchanged re-send and is coalesced by
      // scheduleTranscript()'s throttle below rather than broadcast twice.
      const existing = this.partials.get(ch);
      // A same-id partial SHORTER than what is on screen is a straggler while a
      // WebSocket attempt is open (`wsOpen`, the duplicate-final rule's window
      // above): the two transports do not share a clock, so a slower copy of
      // the same utterance can land after a faster one that is further along,
      // and applying it would visibly rewind the caption. On SSE alone
      // partials arrive in order, so every revision applies, including one the
      // recogniser shortened.
      if (this.wsOpen && existing && existing.line.id === line.id && line.text.length < existing.line.text.length) {
        return;
      }
      const unchanged = !!existing && existing.line.id === line.id && existing.line.text === line.text;
      const now = this.now();
      this.partials.set(ch, {
        line,
        seenAt: unchanged ? existing!.seenAt : now,
        firstSeenAt: existing ? existing.firstSeenAt : now,
        resendsUnchanged: (existing?.resendsUnchanged ?? 0) + (unchanged ? 1 : 0),
        textChanges: (existing?.textChanges ?? 0) + (existing && !unchanged ? 1 : 0),
        lastLoggedAt: existing?.lastLoggedAt ?? null,
      });
      this.syncPartialSweep();
      this.scheduleTranscript(); // interim partials arrive many/sec — coalesce them
    }
  }

  /** One line per connection, the first time an unchanged repeat of a finished
   *  line is suppressed rather than broadcast twice.
   *
   * Worded without naming which transport: this fires whenever a second
   * transport was open (wsOpen), but ingest() has no record of which of the
   * two calls that produced the repeat came from which — an unproven
   * WebSocket open beside SSE while SSE itself repeats a keepalive looks
   * identical from here to the same line genuinely arriving on both. */
  private noteDuplicateFinalSuppressed(): void {
    if (this.duplicateFinalLogged) return;
    this.duplicateFinalLogged = true;
    console.log(`[prodcom] a finished line repeated while a second transport was open — duplicate suppressed`);
  }

  private flushTranscript(): void {
    if (this.transcriptTimer) {
      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = null;
    }
    this.transcriptDirty = false;
    // Skip the full-buffer spread + push when nothing consumes the transcript.
    //
    // channelInDemand, not channelHasSubscribers: the prodcom.phrase-said trigger
    // reads this channel from inside the process, so a browser-only check meant a
    // phrase rule never fired unless somebody happened to have a transcription
    // display open — which on an unattended box is never.
    if (channelInDemand("prodcom:transcript")) broadcast("prodcom:transcript", this.getBuffer());
  }

  private scheduleTranscript(): void {
    this.transcriptDirty = true;
    if (this.transcriptTimer) return;
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = null;
      if (this.transcriptDirty) this.flushTranscript();
    }, TRANSCRIPT_THROTTLE_MS);
  }

  /**
   * Append a finalised line, replacing any existing one with the same id (so a
   * backfilled line and a streamed update of it don't both appear).
   *
   * @returns whether this changed anything a display shows — false only when an
   *   existing entry is replaced by one that is byte-for-byte the same, which is
   *   what the SAME final arriving on both transports looks like. The caller
   *   uses this to decide whether the change is worth a broadcast.
   */
  private addFinal(line: TranscriptLineDTO): boolean {
    const entry: FinalEntry = { line, receivedAt: this.now() };
    const at = this.finals.findIndex((e) => e.line.id === line.id);
    if (at !== -1) {
      const changed = !linesEqual(this.finals[at]!.line, line);
      this.finals[at] = entry;
      this.syncPartialSweep();
      return changed;
    }
    this.finals.push(entry);
    if (this.finals.length > MAX_LINES) this.finals.splice(0, this.finals.length - MAX_LINES);
    this.syncPartialSweep();
    return true;
  }

  // ── REST priming: channel colours, then the transcript so far ─────────────

  /**
   * What a freshly-opened connection needs from REST.
   *
   * Channels FIRST and awaited, so the backfilled lines carry their colours on
   * the very first broadcast rather than arriving grey and correcting later.
   */
  private async primeFromRest(host: string, port: number): Promise<void> {
    await this.refreshChannelMetadata(host, port);
    await this.backfillNow(host, port);
  }

  /** Run one backfill and log what it did — shared by primeFromRest (every
   *  fresh SSE connection) and promoteWebSocket (below), which needs it for a
   *  different reason: a final still in flight on SSE the instant it is torn
   *  down for the websocket is not lost, it is caught on the next read. */
  private async backfillNow(host: string, port: number): Promise<void> {
    const result = await this.backfill(host, port);
    if (result.error) {
      console.warn(
        `[prodcom] backfill failed after ${result.pages} page(s) (${result.error}) — ` +
          `${result.added} line(s) landed; the live stream is unaffected`,
      );
    } else if (result.added > 0 || result.pages > 1) {
      console.log(`[prodcom] backfill: ${result.added} line(s) over ${result.pages} page(s)`);
    }
  }

  /**
   * A WebSocket attempt's own priming: just the silence check's row-count
   * baseline, read fresh every time a socket opens.
   *
   * Deliberately NOT channels, keywords or backfill — the SSE stream owns
   * keeping those current for as long as it is open, which per this file's
   * design is the entire time any WebSocket attempt is unproven. Re-running a
   * full backfill on every re-test would cost a channel read and a 200-line
   * backfill every re-test for no benefit (the buffer is already caught up) and
   * would print a `backfill: N line(s)` log on a connection that received no new
   * lines at all.
   */
  private async primeWsBaseline(host: string, port: number, ws: WebSocket): Promise<void> {
    const rows = await this.readTranscriptRowCount(host, port);
    // A read that outlived its socket is answered after that socket closed.
    // ProdCom's transcript only grows, so applying it would inflate the next
    // attempt's baseline and hide lines spoken since that attempt opened.
    //
    // Identity, not connectionEpoch: an ORDINARY reconnect (this socket drops
    // and a new one opens to the SAME box) never bumps the epoch — only
    // teardown() does — but it does replace `this.ws`, and this baseline has
    // to belong to the attempt that asked for it, not whichever one happens to
    // be open when the answer lands. See prodcom-stale-baseline.test.ts.
    if (this.ws === ws) {
      this.wsBaselineRows = rows;
    } else {
      console.debug("[prodcom] dropped a baseline read that arrived after this websocket attempt was replaced");
    }
  }

  /**
   * Everything this app reads about the channels: their names and colours, and
   * the keywords ProdCom scopes to them.
   *
   * One entry point because both are refreshed on the same two occasions —
   * connect, and a throttled re-read when a line arrives on an unknown id — and
   * two entry points is how one of them ends up refreshed and the other stale.
   * The keyword read needs the channel list to know which channels to ask about,
   * so it runs second and is skipped when the channel read failed.
   *
   * Protected so a test can drive a re-read against a box that has stopped
   * answering, without waiting out the refresh throttle.
   */
  protected async refreshChannelMetadata(host: string, port: number): Promise<void> {
    const channels = await this.fetchChannels(host, port);
    if (channels.error) {
      this.logChannelFailure(channels.error);
      // Without the channel list there is nothing to ask for keywords about.
      // Whatever was loaded before stays loaded — see logKeywordFailure().
      this.logKeywordFailure(channels.error);
      return;
    }
    const keywords = await this.fetchKeywords(host, port, channels.embedded ?? new Map());
    if (keywords.error) this.logKeywordFailure(keywords.error);
  }

  /**
   * Fetch `/api/v1/channels` and key name + colour by channel id.
   *
   * There is no channel event on the WebSocket — the live box's welcome frame
   * lists transcript / status / automation / activity, and the spec's claim of a
   * "channel" category is wrong — so this is a REST read on connect plus a
   * throttled refresh when a line turns up on an id we have never seen.
   *
   * `embedded` carries any channel that answered with its own `keywords` array.
   * The spec's Channel schema declares that field; ProdCom 2.3.2 does not send
   * it (17 channels on the live box, none carrying the key), so the keyword read
   * below asks each channel separately for the ones that did not. Both are real
   * observed behaviours, not a guessed fallback: a box that does send them saves
   * a request per channel and stays consistent with its own list.
   */
  private async fetchChannels(
    host: string,
    port: number,
  ): Promise<{ error?: string; embedded?: Map<string, unknown[]> }> {
    const epoch = this.connectionEpoch;
    let body: string;
    try {
      body = await this.getJson(host, port, "/api/v1/channels");
    } catch (e) {
      // Returned, not logged here: both callers reach this, and the one that
      // matters to an operator is the connect-time read.
      return { error: errorMessage(e) };
    }
    if (epoch !== this.connectionEpoch) {
      // A reconfigure or a stop() landed while this was in flight — this
      // answer is about a box this service has already let go, and applying
      // it would put the OLD box's channels on the NEW connection.
      console.debug("[prodcom] dropped a channel list read that arrived after this connection was replaced");
      return {};
    }
    const rows = asRecord(safeJson(body))?.["data"];
    if (!Array.isArray(rows)) return { error: "response had no data array" };

    const next = new Map<string, ChannelMeta>();
    const embedded = new Map<string, unknown[]>();
    for (const row of rows) {
      const rec = asRecord(row);
      const id = rec && str(rec, "id");
      if (!rec || !id) continue;
      next.set(id, { name: str(rec, "name"), color: normalizeColor(str(rec, "color")) });
      if (Array.isArray(rec["keywords"])) embedded.set(id, rec["keywords"]);
    }
    this.channels = next;
    this.channelsFetchedAt = this.now();
    this.broadcastChannelsIfChanged();
    return { embedded };
  }

  /**
   * Push the current channel list on "prodcom:channels" if it differs from the
   * last thing sent — the same change-driven rule as every other broadcast in
   * this app, so a throttled re-read that came back identical (the common case:
   * this runs on every reconnect, and a box's channel list rarely changes
   * between them) does not cost every open settings panel a frame.
   */
  private broadcastChannelsIfChanged(): void {
    if (!channelInDemand("prodcom:channels")) return;
    const list = this.getChannels();
    const signature = JSON.stringify(list);
    if (signature === this.lastChannelsBroadcast) return;
    this.lastChannelsBroadcast = signature;
    broadcast("prodcom:channels", list);
  }

  /** The one operator-facing line for a channel-list failure, so both callers
   *  say the same thing. */
  private logChannelFailure(error: string): void {
    console.warn(
      `[prodcom] channel list unavailable (${error}) — ` +
        `captions fall back to per-channel colours chosen by the display`,
    );
  }

  /**
   * Read the keyword lists and keep the patterns for the sensitive ones.
   *
   * Global (`GET /api/v1/keywords`) applies to every line; channel-scoped
   * (`GET /api/v1/channels/{id}/keywords`) only to that channel, which is how
   * ProdCom itself scopes them. Requests go out together rather than one after
   * another — a box with seventeen channels would otherwise take seventeen
   * round trips before the first caption could be redacted, and until the list
   * is loaded nothing is hidden.
   *
   * A failure returns rather than logs, and — importantly — leaves the previous
   * patterns in place. Discarding them on a transient error would silently
   * un-redact every display mid-service, which is the exact failure this whole
   * change exists to prevent.
   */
  private async fetchKeywords(
    host: string,
    port: number,
    embedded: Map<string, unknown[]>,
  ): Promise<{ error?: string }> {
    // `scope` and never the path: this is the one place a request URL could end
    // up quoted in an error, and while the only variable in it is a channel id,
    // an invariant that reads "no URL reaches a log line from here" is one a
    // reviewer can check at a glance. It also tells an operator WHICH read
    // failed, which the path would have done anyway.
    const rowsOf = async (scope: string, path: string): Promise<unknown[]> => {
      const parsed = asRecord(safeJson(await this.getJson(host, port, path)));
      const data = parsed?.["data"];
      if (!Array.isArray(data)) throw new Error(`the ${scope} response had no data array`);
      return data;
    };

    const epoch = this.connectionEpoch;
    const ids = [...this.channels.keys()];
    let globalRows: unknown[];
    let scoped: { id: string; rows: unknown[] }[];
    try {
      [globalRows, scoped] = await Promise.all([
        rowsOf("global keyword", "/api/v1/keywords"),
        Promise.all(
          ids.map(async (id) => ({
            id,
            // The channel row already carried them on a box that sends them.
            rows:
              embedded.get(id) ??
              (await rowsOf("channel keyword", `/api/v1/channels/${encodeURIComponent(id)}/keywords`)),
          })),
        ),
      ]);
    } catch (e) {
      // errorMessage, and getJson's own rejections, carry a status code or a
      // socket error — never a response body. No keyword text can reach a log
      // line through here, and prodcom-redaction.test.ts fails if one ever does.
      //
      // The patterns already loaded are deliberately left alone: clearing them
      // here silently un-redacts every display on a transient 500 mid-service,
      // which is the exact failure this file exists to prevent.
      return { error: errorMessage(e) };
    }
    if (epoch !== this.connectionEpoch) {
      // Same race as fetchChannels: a reconfigure or a stop() landed while
      // both reads were out, and applying them now would hide the OLD box's
      // sensitive words behind the NEW box's redaction state — or the other
      // way round.
      console.debug("[prodcom] dropped a keyword read that arrived after this connection was replaced");
      return {};
    }

    this.globalSensitive = sensitivePatterns(globalRows);
    const next = new Map<string, RegExp[]>();
    let scopedSensitive = 0;
    for (const { id, rows } of scoped) {
      const patterns = sensitivePatterns(rows);
      if (!patterns.length) continue;
      next.set(id, patterns);
      scopedSensitive += patterns.length;
    }
    this.channelSensitive = next;

    // Counts only. The words themselves are what has to stay on this machine.
    const summary =
      `${globalRows.length} global (${this.globalSensitive.length} sensitive), ` +
      `${scoped.reduce((n, s) => n + s.rows.length, 0)} channel-scoped across ${ids.length} channel(s) ` +
      `(${scopedSensitive} sensitive)`;
    if (summary !== this.lastKeywordSummary) {
      this.lastKeywordSummary = summary;
      console.log(
        `[prodcom] keywords loaded: ${summary} — ` +
          (this.redactSensitive
            ? "sensitive matches are hidden on displays"
            : "redaction is OFF, so they are shown in full"),
      );
    }
    return {};
  }

  /** The one operator-facing line for a keyword-read failure. Says what the
   *  consequence is, because "unavailable" alone does not tell an operator
   *  whether their displays are currently safe. */
  private logKeywordFailure(error: string): void {
    const held = this.globalSensitive.length + [...this.channelSensitive.values()].reduce((n, p) => n + p.length, 0);
    console.warn(
      `[prodcom] keyword list unavailable (${error}) — ` +
        (held > 0
          ? `still hiding ${held} sensitive keyword(s) from the last successful read`
          : "no sensitive keywords are loaded, so nothing is being hidden on displays"),
    );
  }

  /** A line arrived on an unknown channel id. Re-read the list, at most once per
   *  CHANNEL_REFRESH_MIN_MS, so a channel added mid-service gets its colour —
   *  and its keywords, or a channel added mid-service would caption unredacted. */
  private refreshChannelsSoon(): void {
    if (this.channelRefreshInFlight) return;
    if (this.now() - this.channelsFetchedAt < CHANNEL_REFRESH_MIN_MS) return;
    const host = this.host;
    const port = this.port;
    if (!host || !port) return;
    this.channelRefreshInFlight = true;
    // Stamp before the fetch, or a box that keeps failing would be re-asked on
    // every single line.
    this.channelsFetchedAt = this.now();
    void this.refreshChannelMetadata(host, port).finally(() => {
      this.channelRefreshInFlight = false;
    });
  }

  /**
   * Prime the buffer from ProdCom's own history so a display opened mid-service
   * shows prior lines immediately.
   *
   * `GET /api/v1/transcript` is ascending FROM THE OLDEST ENTRY and its
   * pagination is mandatory. Called with no parameters — which is what this did
   * until now — it returns the oldest 50 rows of about 3000, five days old, and
   * applyBackfillRows() then discards all fifty as older than the horizon. A
   * display opened mid-service showed nothing until somebody spoke.
   *
   * So: `since` narrows it server-side (mind sinceParam() — the millisecond form
   * is silently ignored), `limit` takes the spec's maximum, and `offset` walks
   * every page `hasMore` reports rather than assuming one is enough.
   */
  private async backfill(host: string, port: number): Promise<BackfillResult> {
    const epoch = this.connectionEpoch;
    const since = sinceParam(this.now() - LINE_MAX_AGE_MS);
    const rows: unknown[] = [];
    let pages = 0;
    let error: string | undefined;

    for (let offset = 0; pages < BACKFILL_MAX_PAGES; offset += BACKFILL_PAGE_SIZE) {
      const path =
        `/api/v1/transcript?since=${encodeURIComponent(since)}` +
        `&limit=${BACKFILL_PAGE_SIZE}&offset=${offset}`;
      let body: string;
      try {
        body = await this.getJson(host, port, path);
      } catch (e) {
        error = errorMessage(e);
        break;
      }
      pages++;
      const parsed = asRecord(safeJson(body));
      const data = parsed?.["data"];
      if (!Array.isArray(data)) {
        error = "response had no data array";
        break;
      }
      rows.push(...data);
      const meta = asRecord(parsed?.["meta"]);
      if (data.length === 0 || meta?.["hasMore"] !== true) break;
      if (pages === BACKFILL_MAX_PAGES) {
        console.warn(
          `[prodcom] backfill stopped at the ${BACKFILL_MAX_PAGES}-page cap — ` +
            `ProdCom reports more history since ${since} than ${BACKFILL_MAX_PAGES * BACKFILL_PAGE_SIZE} lines`,
        );
      }
    }

    if (epoch !== this.connectionEpoch) {
      // A reconfigure or a stop() landed while these pages were in flight —
      // this is the OLD box's history, and applying it would put its lines on
      // a buffer that now belongs to a different connection.
      console.debug(`[prodcom] dropped a backfill (${rows.length} row(s)) that arrived after this connection was replaced`);
      return { added: 0, skipped: 0, pages, error };
    }
    const applied = this.applyBackfillRows(rows);
    return { added: applied.added, skipped: applied.skipped, pages, error };
  }

  /** One GET, resolving the body or rejecting with a reason the caller can log. */
  private getJson(host: string, port: number, path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host, port, path, headers: { ...this.authHeaders(this.apiKey), Accept: "application/json" }, timeout: 4000 },
        (res) => {
          const code = res.statusCode ?? 0;
          if (code < 200 || code >= 300) {
            res.resume();
            reject(new Error(`HTTP ${code}`));
            return;
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (body += c));
          res.on("end", () => resolve(body));
          res.on("error", (e) => reject(e));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
    });
  }

  /**
   * Apply ProdCom's own transcript history to the buffer on (re)connect.
   *
   * Rows older than LINE_MAX_AGE_MS are skipped even though `since` already asked
   * the server for the same window. That is deliberate belt-and-braces, not
   * duplication: `since` is silently ignored by 2.3.2 when the timestamp carries
   * milliseconds (see sinceParam), the parameter did not exist at all on older
   * builds, and a box whose clock is days off will happily answer with anything.
   * This filter is what stops Thursday's sermon reaching a display on Sunday in
   * every one of those cases. Protected (not private) so a test can drive it
   * directly without a real ProdCom host.
   */
  protected applyBackfillRows(rows: unknown[]): { added: number; skipped: number } {
    const cutoff = this.now() - LINE_MAX_AGE_MS;
    let added = 0;
    let skipped = 0;
    for (const row of rows) {
      const entry = asRecord(row);
      if (!entry) continue;
      const line = this.normalizeLine(entry);
      if (!line?.isFinal) continue;
      if (!this.shouldCaption(entry)) continue;
      const parsed = Date.parse(line.at);
      const at = Number.isNaN(parsed) ? this.now() : parsed;
      if (at < cutoff) {
        skipped++;
        continue;
      }
      this.addFinal(line);
      added++;
    }
    if (skipped > 0) {
      console.log(`[prodcom] backfill skipped ${skipped} line(s) older than 4h`);
    }
    if (added > 0) broadcast("prodcom:transcript", this.getBuffer());
    return { added, skipped };
  }
}

/**
 * Are two finalised lines the same thing, in everything a display or a
 * broadcast shows?
 *
 * Compares every field the two transports could disagree on. `redactions` is
 * deliberately absent — it is computed on the way OUT (redactLine, in
 * getBuffer()) and never stored on either side, so it cannot differ here.
 */
function linesEqual(a: TranscriptLineDTO, b: TranscriptLineDTO): boolean {
  return (
    a.id === b.id &&
    a.channel === b.channel &&
    a.channelName === b.channelName &&
    a.color === b.color &&
    a.text === b.text &&
    a.isFinal === b.isFinal &&
    a.at === b.at
  );
}

/** JSON.parse that returns null instead of throwing. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * A TranscriptEntry inside a WebSocket frame, and where it was found.
 *
 * Identified by the two fields the spec marks required on every entry, so an
 * envelope key that happens to hold something else cannot pass. `at: null` means
 * the frame WAS the entry.
 */
function findTranscriptEntry(
  frame: Record<string, unknown>,
): { entry: Record<string, unknown>; at: string | null } | null {
  const isEntry = (o: Record<string, unknown>) => typeof o["text"] === "string" && typeof o["channelId"] === "string";
  if (isEntry(frame)) return { entry: frame, at: null };
  for (const key of WS_ENTRY_CONTAINERS) {
    const nested = asRecord(frame[key]);
    if (nested && isEntry(nested)) return { entry: nested, at: key };
  }
  return null;
}

export const prodcomService = new ProdComService();
