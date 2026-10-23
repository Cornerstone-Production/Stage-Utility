// main/services/video/reconcile-plan.ts — working out what the relay's
// paths and publish users should become, without ever touching the network.
//
// Pure, so "add this one, replace that one, remove a third, leave a fourth
// alone" is tested against plain objects. mediamtx-relay.ts is the only
// thing that turns a plan into HTTP calls.

import { listenPathName } from "./audio-listen.js";
import { apiUser, listenPublisherUser, READER_USER, type RelayUser } from "./mediamtx-config.js";
import type { RelayFeed } from "./relay.js";

/** The subset of a MediaMTX path's config this app ever sets. `GET
 *  /v3/config/paths/list` reports dozens of other keys (recording,
 *  playback, every other protocol's own timeouts) — none of them are here,
 *  and a match check below never looks at them. */
export interface PathConf {
  source: string;
  sourceOnDemand?: boolean;
  sourceOnDemandStartTimeout?: string;
  sourceOnDemandCloseAfter?: string;
  overridePublisher?: boolean;
  runOnDemand?: string;
  runOnDemandRestart?: boolean;
  runOnDemandStartTimeout?: string;
  runOnDemandCloseAfter?: string;
}

/** MediaMTX's own built-in catch-all path. It is never in `desired` — no
 *  feed is ever named "all_others" (feed-id.ts's pattern does not produce
 *  it) — so without this it would always read as "the relay has a path we
 *  don't want" and get deleted, refusing every connection to a path nobody
 *  configured instead of the relay's own "path not found." */
const ALL_OTHERS = "all_others";

/** A literal `%` survives the WHATWG `URL` username/password setters
 *  unescaped — confirmed against Node's own `URL` (`new URL("rtsp://h/s")`
 *  with `.password = "s3c%zret"` serializes as `s3c%zret`, verbatim): `%`
 *  is not in the userinfo percent-encode set, since the setters treat a URL
 *  as already-encoded input, not a raw credential to encode. Pre-escaping
 *  it here is what makes the setters' own encoding of `@`, `:`, `/` and the
 *  rest correct as a ROUND TRIP: `50%off!` must reach the device as
 *  `50%off!`, not `50` truncated at a `%` a real client tries to decode as
 *  an escape. `searchParams.set` (the SRT branch below) does not need this
 *  — form-urlencoded serialization already encodes `%` as `%25` on its
 *  own, confirmed the same way. */
function encodePercent(s: string): string {
  return s.replace(/%/g, "%25");
}

/** A pull feed's address with its credentials folded in — what a `RelayFeed`
 *  of kind "pull" carries as `source`. Never logs: the return value carries
 *  a password, and nothing that touches it here is a log call.
 *
 *  rtsp/rtsps/http/https put the credentials in the URL's own userinfo,
 *  percent-encoded by the `URL` setters (`p@ss` becomes `p%40ss`) after a
 *  literal `%` is pre-escaped (see encodePercent); srt has no userinfo
 *  convention of its own, so its password goes in the query as
 *  `passphrase=<pw>`; it has no username (feed-input.ts refuses one) —
 *  MediaMTX authenticates an SRT pull by passphrase alone. An empty
 *  username with no password leaves `url` untouched.
 */
export function pullSource(url: string, username: string, password: string | undefined): string {
  const parsed = new URL(url);

  if (parsed.protocol === "srt:") {
    if (!password) return url;
    parsed.searchParams.set("passphrase", password);
    return parsed.toString();
  }

  if (username === "" && !password) return url;

  // The URL setters below silently no-op when the URL "cannot have a
  // username/password" — true only when its host is empty (per the WHATWG
  // URL spec; not actually scheme-specific for any of the four schemes
  // this ever sees). Every rtsp/rtsps/http/https URL a feed can carry has
  // already been through `new URL()` in feed-input.ts, which requires a
  // host to parse at all — so this is a defensive fallback, not a reachable
  // one, and the scheme is left with no credentials rather than silently
  // dropping a password nobody can see was dropped.
  if (parsed.host === "") return url;

  parsed.username = encodePercent(username);
  if (password !== undefined) parsed.password = encodePercent(password);
  return parsed.toString();
}

/** How long the relay dials an on-demand pull source before giving up on
 *  that request. */
export const PULL_START_TIMEOUT_MS = 10_000;

/** The config MediaMTX needs for one feed's path. */
export function pathConf(feed: RelayFeed): PathConf {
  if (feed.kind === "pull") {
    return {
      source: feed.source,
      sourceOnDemand: true,
      sourceOnDemandStartTimeout: `${PULL_START_TIMEOUT_MS / 1000}s`,
      sourceOnDemandCloseAfter: "10s",
    };
  }
  return { source: "publisher", overridePublisher: false };
}

/** How long a reader of a `-listen` path waits for ffmpeg to start publishing
 *  before it is told no. A start measured at about a second locally; a Raspberry
 *  Pi on a slow card is several. */
export const LISTEN_START_TIMEOUT_MS = 15_000;
/** How long after the last reader leaves the converter keeps running. Long
 *  enough that switching Listen off and on again reuses it rather than paying
 *  the start twice; short enough that an abandoned page costs a few seconds of
 *  CPU, not a session. */
export const LISTEN_CLOSE_AFTER_MS = 10_000;

/** The config of a feed's `<id>-listen` path. MediaMTX runs `command` when the
 *  first reader arrives (one process, whoever else joins), restarts it while
 *  readers remain, and stops it LISTEN_CLOSE_AFTER_MS after the last leaves. The
 *  path itself is fed by that process publishing to it over RTSP. */
export function listenPathConf(command: string): PathConf {
  return {
    source: "publisher",
    overridePublisher: false,
    runOnDemand: command,
    runOnDemandRestart: true,
    runOnDemandStartTimeout: `${LISTEN_START_TIMEOUT_MS / 1000}s`,
    runOnDemandCloseAfter: `${LISTEN_CLOSE_AFTER_MS / 1000}s`,
  };
}

/** Every relay path the feeds ask for: each feed's own, then the `-listen`
 *  sibling of each that has a command. */
export function desiredPaths(feeds: RelayFeed[]): [string, PathConf][] {
  const out: [string, PathConf][] = [];
  for (const feed of feeds) {
    out.push([feed.id, pathConf(feed)]);
    if (feed.listenCommand !== undefined) out.push([listenPathName(feed.id), listenPathConf(feed.listenCommand)]);
  }
  return out;
}

/** The relay's whole publish-user list: the fixed reader user, then one
 *  `video` user per push feed, sorted by path so the list (and the
 *  before/after comparison `MediaMtxRelay.reconcile` makes against it) is
 *  stable regardless of feed order. */
export function publishUsers(feeds: RelayFeed[]): RelayUser[] {
  const pushUsers = feeds
    .filter((feed): feed is Extract<RelayFeed, { kind: "push" }> => feed.kind === "push")
    .map((feed) => ({
      user: "video",
      pass: feed.password,
      ips: [] as string[],
      permissions: [{ action: "publish" as const, path: feed.id }],
    }))
    .sort((a, b) => a.permissions[0].path.localeCompare(b.permissions[0].path));
  const listenPaths = feeds
    .filter((feed) => feed.listenCommand !== undefined)
    .map((feed) => listenPathName(feed.id))
    .sort();
  return [READER_USER, ...(listenPaths.length > 0 ? [listenPublisherUser(listenPaths)] : []), ...pushUsers];
}

/** Every user the relay holds: publishUsers(), then the API's own user.
 *  One list for the config file a relay starts from and for every
 *  reconcile's users patch alike — a patch without the API user would lock
 *  this server out of the relay it just configured. */
export function relayUsers(feeds: RelayFeed[], apiPassword: string): RelayUser[] {
  return [...publishUsers(feeds), apiUser(apiPassword)];
}

/** True when `current` already carries every key `wanted` sets, at the same
 *  value. Every value `pathConf` produces is a string or boolean, so `===`
 *  is the whole comparison — there is nothing here to recurse into. */
function matchesWanted(current: Record<string, unknown>, wanted: PathConf): boolean {
  return (Object.keys(wanted) as (keyof PathConf)[]).every((key) => current[key] === wanted[key]);
}

/** What to add, replace and remove so the relay's paths match `desired`
 *  exactly. A path already there is replaced only when it differs from
 *  what `pathConf` wants; one whose conf matches, key for key, is left
 *  alone even though the relay reports far more keys than that. */
export function planReconcile(
  desired: RelayFeed[],
  current: { name: string; conf: Record<string, unknown> }[],
): { add: [string, PathConf][]; replace: [string, PathConf][]; remove: string[] } {
  const currentByName = new Map(current.map((path) => [path.name, path.conf]));
  const wantedPaths = desiredPaths(desired);
  const desiredNames = new Set(wantedPaths.map(([name]) => name));

  const add: [string, PathConf][] = [];
  const replace: [string, PathConf][] = [];
  for (const [name, wanted] of wantedPaths) {
    const existing = currentByName.get(name);
    if (existing === undefined) {
      add.push([name, wanted]);
    } else if (!matchesWanted(existing, wanted)) {
      replace.push([name, wanted]);
    }
  }

  const remove = current.map((path) => path.name).filter((name) => name !== ALL_OTHERS && !desiredNames.has(name));

  return { add, replace, remove };
}
